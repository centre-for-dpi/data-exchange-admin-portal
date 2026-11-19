#!/usr/bin/env bash
# Interactive installer of the DEN portal + gateway on one Linux server (pilot topology,
# docs/INSTALL.md). Production is the Helm charts of M6-05, not this script.
#
#   sudo ./install.sh              # asks step by step, writes .env, builds and starts everything
#   sudo ./install.sh status       # containers and health checks
#   sudo ./install.sh credentials  # where to log in and with what (demo users, Keycloak admin)
#   sudo ./install.sh otp          # one-time code of the demo users with a critical role
#   sudo ./install.sh logs [svc]   # follow the logs (all services, or one)
#   sudo ./install.sh backup       # full pgBackRest backup, plus dumps, CA, TSA, documents and the
#                                  # backup repository into backups/<date>/ (not .env: its keys are
#                                  # kept apart); keeps the last DEN_BACKUP_KEEP (5)
#   sudo ./install.sh restore [time]  # restore the database: latest state, or the moment given
#                                  # ("2026-11-20 14:30:00-05"); stops and restarts everything
#   sudo ./install.sh restore-volumes <backups/date>  # server lost: on a new server with the saved
#                                  # .env, recreate the volumes from that backup and start
#   sudo ./install.sh update       # backup, git pull --ff-only, rebuild and restart
#   sudo ./install.sh images <tag>|build  # published images from ghcr.io (0.2.0, sha-<commit>)
#                                  # instead of building the API, web, hub and runner here
#   sudo ./install.sh stop|start   # stop or start every container (data is kept)
#   sudo ./install.sh platform-role grant|revoke <email> <role> [--reason "..."] | list
#                                  # platform roles of the operator's own people, audited;
#                                  # the person registers and signs in once first
#   sudo ./install.sh demo-users list|disable [--reason "..."] [--yes]
#                                  # the seed's demo users: disable them (Keycloak and portal,
#                                  # audited) once your own people have their platform roles
#   sudo ./install.sh realms       # the realm files' settings on the existing realms (update
#                                  # runs it): login flow, policies, 60-minute verification link,
#                                  # the citizen app's client
#
# Re-running the install keeps the existing .env: secrets of a running deployment never change
# under it (database passwords, signing key, subject key; DEPLOYMENT.md §4.1).
# Messages are in Spanish, the portal's default language.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env"
NODE_IMAGE="node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53"
EDGE_NETWORK="den-edge"
MIN_COMPOSE="2.26.0"
# What `backup` saves besides the database dumps, and `restore-volumes` puts back (M-30).
BACKUP_VOLUMES=(step-ca-data tsa-data api-documents citizen-app-data pgbackrest-repo)
# Volume subpaths (the API mounts step-ca's certs/ only) need Docker Engine 26 (B-30).
MIN_ENGINE="26.0.0"
# Secrets that must not keep the public value of .env.example (M-25).
EXAMPLE_SECRETS=(POSTGRES_PASSWORD DEN_APP_DB_PASSWORD KEYCLOAK_DB_PASSWORD KEYCLOAK_ADMIN_PASSWORD
  DEN_PORTAL_WEB_CLIENT_SECRET DEN_GATEWAY_PROVISIONER_SECRET DEN_CITIZEN_APP_CLIENT_SECRET
  DEN_DEMO_USER_PASSWORD DEN_DEMO_CRITICAL_PASSWORD DEN_DEMO_TOTP_SECRET APISIX_ADMIN_KEY
  ETCD_ROOT_PASSWORD APISIX_ETCD_PASSWORD OPA_BUNDLE_TOKEN DEN_OPA_DECISION_TOKEN DEN_OPA_ADMIN_TOKEN
  DEN_END_USER_HASH_SALT DEN_SUBJECT_REF_KEY DEN_TRANSPARENCY_INGEST_TOKEN STEP_CA_PASSWORD
  DEN_STEP_CA_PROVISIONER_PASSWORD AUTH_SECRET DEN_SECRETS_KEY DEN_TRANSPARENCY_SIGNING_JWK
  CITIZEN_APP_WEBHOOK_SECRET DEN_NODE_CONTROL_TOKEN DEN_WG_HUB_PRIVATE_KEY DEN_WG_HUB_AGENT_TOKEN
  DEN_VALIDATION_TOKEN DEN_CONTRACT_RUNNER_TOKEN DEN_METRICS_TOKEN GRAFANA_ADMIN_PASSWORD
  DEN_APISIX_KEYRING)

# --- output -------------------------------------------------------------------------------------
if [[ -t 1 ]]; then
  B=$'\e[1m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'
else
  B=''; G=''; Y=''; R=''; C=''; N=''
fi
info() { printf '%s\n' "${C}›${N} $*"; }
ok() { printf '%s\n' "${G}✔${N} $*"; }
warn() { printf '%s\n' "${Y}⚠${N} $*"; }
fail() { printf '%s\n' "${R}✘ $*${N}" >&2; exit 1; }
step() { printf '\n%s\n' "${B}── $* ──${N}"; }

# ask VAR "question" [default]
ask() {
  local __var=$1 __q=$2 __def=${3-} __ans
  if [[ -n $__def ]]; then read -r -p "  $__q [$__def]: " __ans; else read -r -p "  $__q: " __ans; fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
# ask_secret VAR "question" (empty allowed)
ask_secret() {
  local __var=$1 __q=$2 __ans
  read -r -s -p "  $__q: " __ans; echo
  printf -v "$__var" '%s' "$__ans"
}
# yes_no "question" default(s|n) → status 0 for yes
yes_no() {
  local __q=$1 __def=${2:-s} __ans
  read -r -p "  $__q [$([[ $__def == s ]] && echo 'S/n' || echo 's/N')]: " __ans
  __ans=${__ans:-$__def}
  [[ $__ans =~ ^[sSyY] ]]
}

# --- .env helpers -------------------------------------------------------------------------------
env_get() {
  [[ -f $ENV_FILE ]] || return 0
  local line
  line=$(grep -E "^$1=" "$ENV_FILE" | tail -n 1 || true)
  line=${line#*=}
  line=${line#\'}; line=${line%\'}; line=${line#\"}; line=${line%\"}
  printf '%s' "$line"
}
# env_set KEY VALUE: VALUE as written (quote it with env_quote unless it is a generated one).
env_set() {
  local key=$1 value=$2
  if grep -qE "^$key=" "$ENV_FILE"; then
    local tmp; tmp=$(mktemp)
    # Through the environment, not awk -v, which reads backslashes as escapes (B-30).
    K=$key V=$value awk 'BEGIN{FS=OFS="="} $1==ENVIRON["K"]{print ENVIRON["K"] "=" ENVIRON["V"]; next} {print}' \
      "$ENV_FILE" >"$tmp"
    cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}
# env_quote VALUE: in single quotes, which Compose, bash and Node read literally ($, # and spaces
# included, B-30). Fails on what they cannot carry that way: quotes, backslashes, line breaks.
env_quote() {
  case $1 in *"'"* | *'"'* | *'\'* | *$'\n'* | *$'\r'*) return 1 ;; esac
  printf "'%s'" "$1"
}
# The value of KEY in .env.example (M-25).
example_value() { ENV_FILE="$ROOT/.env.example" env_get "$1"; }
random_secret() { head -c 32 /dev/urandom | base64 | tr -d '\n/+='; }

# Secrets added by later versions to an existing .env (re-running never changes the others).
ensure_env_additions() {
  if [[ -z $(env_get PGBACKREST_REPO1_CIPHER_PASS) ]]; then
    env_set PGBACKREST_REPO1_CIPHER_PASS "$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=')"
    chmod 600 "$ENV_FILE"
    warn "Nueva clave de cifrado de los respaldos (PGBACKREST_REPO1_CIPHER_PASS) en .env: guarda una copia fuera del servidor. Sin ella no se puede restaurar ningún respaldo."
  fi
  # Credentials of OPA's API and etcd (B-15, ADR-0031), new in this version: generated once. etcd-init
  # turns etcd's authentication on with them on the next start; the data in etcd stays.
  local key
  for key in DEN_OPA_DECISION_TOKEN DEN_OPA_ADMIN_TOKEN ETCD_ROOT_PASSWORD APISIX_ETCD_PASSWORD; do
    if [[ -z $(env_get "$key") ]]; then
      env_set "$key" "$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=')"
      chmod 600 "$ENV_FILE"
      info "Nueva credencial interna en .env: $key."
    fi
  done
  # The TSA's trust (M-14, ADR-0032), new in this version: the pilot stamps with the development
  # TSA and the API says so at start. With the accredited one: DEN_TSA_URL, DEN_TSA_ROOTS_FILE, true.
  if [[ -z $(env_get DEN_TSA_REQUIRE_INDEPENDENT) ]]; then
    env_set DEN_TSA_REQUIRE_INDEPENDENT false
    info "DEN_TSA_REQUIRE_INDEPENDENT=false en .env: la TSA es la de desarrollo (DEPLOYMENT.md §3.7)."
  fi
  # Earlier .env files carried the development value (data/documents), which the API cannot write.
  if [[ $(env_get DEN_DOCUMENTS_DIR) != /var/lib/den/documents ]]; then
    env_set DEN_DOCUMENTS_DIR /var/lib/den/documents
    info "DEN_DOCUMENTS_DIR corregido en .env: /var/lib/den/documents (volumen api-documents)."
  fi
  migrate_citizen_app_env
  ensure_r04_env
}

# R-04: what earlier .env files lack or carry wrong. Idempotent.
ensure_r04_env() {
  local key
  # B-16: one password per step-ca provisioner, none the CA's own (STEP_CA_PASSWORD). On the next
  # start configure.sh gives each provisioner a new key under its password; the API reads them.
  if [[ -z $(env_get DEN_STEP_CA_PROVISIONER_PASSWORD) ||
    $(env_get DEN_STEP_CA_PROVISIONER_PASSWORD) == "$(env_get STEP_CA_PASSWORD)" ]]; then
    env_set DEN_STEP_CA_PROVISIONER_PASSWORD "$(random_secret)"
    chmod 600 "$ENV_FILE"
    info "DEN_STEP_CA_PROVISIONER_PASSWORD nueva en .env: ya no es la de la CA (B-16)."
  fi
  for key in DEN_STEP_CA_GATEWAY_PROVISIONER_PASSWORD DEN_STEP_CA_NODE_PROVISIONER_PASSWORD; do
    if [[ -z $(env_get "$key") ]]; then
      env_set "$key" "$(random_secret)"
      chmod 600 "$ENV_FILE"
      info "Nueva credencial interna en .env: $key."
    fi
  done
  # M-29: the demo users with a critical role get a password apart from the shared one. On an
  # existing Keycloak it is applied by `realms` (DEN_DEMO_CRITICAL_PENDING until then).
  if [[ -z $(env_get DEN_DEMO_CRITICAL_PASSWORD) ]]; then
    env_set DEN_DEMO_CRITICAL_PASSWORD "$(random_secret)"
    env_set DEN_DEMO_CRITICAL_PENDING true
    chmod 600 "$ENV_FILE"
    info "Contraseña aparte para los usuarios de demo con rol crítico (DEN_DEMO_CRITICAL_PASSWORD): sudo ./install.sh credentials."
  fi
  # M-28: the API's mail inside the Compose network; .env.example's value is the host's Mailpit.
  case $(env_get DEN_SMTP_URL) in
    '' | smtp://127.0.0.1:1025 | smtp://localhost:1025)
      env_set DEN_SMTP_URL smtp://mailpit:1025
      info "DEN_SMTP_URL=smtp://mailpit:1025 en .env (Mailpit; el servidor real del operador va aquí, DEPLOYMENT.md §3.9)."
      ;;
  esac
  # M-27: the proxy proves to the web that a request came through it; only then does the web
  # forward the visitor's address. Written into the proxy's routes by write_edge.
  if [[ -z $(env_get DEN_WEB_PROXY_TOKEN) ]]; then
    env_set DEN_WEB_PROXY_TOKEN "$(random_secret)"
    chmod 600 "$ENV_FILE"
    info "Nueva credencial interna en .env: DEN_WEB_PROXY_TOKEN (el proxy la agrega a lo que manda a la web)."
  fi
  # B-28: the API reaches Keycloak's Admin API inside the network; the proxy no longer publishes it.
  if [[ -z $(env_get DEN_KEYCLOAK_ADMIN_URL) ]]; then
    env_set DEN_KEYCLOAK_ADMIN_URL http://keycloak:8080/auth
  fi
  ensure_trust_proxy
}

# M-27: the proxy in front and the web, which forwards the visitor's address, may set
# X-Forwarded-For. By host name, resolved by the API on the Compose network: `edge` (the bundled
# Traefik) or the container of the proxy already on the server, and `web`.
ensure_trust_proxy() {
  local current proxy
  current=$(env_get DEN_TRUST_PROXY)
  # Empty, or `web` alone (no proxy was found last time): look for the proxy.
  if [[ -z $current || $current == web ]]; then
    if [[ $(env_get DEN_INSTALL_PROXY) == bundled ]]; then proxy=edge; else proxy=$(external_proxy); fi
    if [[ -z $proxy ]]; then
      warn "No encontré el contenedor de tu proxy en la red $(env_get TRAEFIK_NETWORK): pon su nombre o su dirección en DEN_TRUST_PROXY de .env, antes de ,web (DEPLOYMENT.md §4.1). Mientras tanto el API no ve la dirección de los visitantes."
      [[ -n $current ]] || env_set DEN_TRUST_PROXY web
      return 0
    fi
    env_set DEN_TRUST_PROXY "$proxy,web"
    info "DEN_TRUST_PROXY=$proxy,web en .env: el API ve la dirección de cada visitante (M-27)."
  elif [[ ! $current =~ ^[0-9]+$ && ,${current// /}, != *,web,* ]]; then
    env_set DEN_TRUST_PROXY "$current,web"
    info "DEN_TRUST_PROXY: se agrega web, que reenvía la dirección del visitante al API (M-27)."
  fi
}

# The Traefik container on the proxy's network (DEN_INSTALL_PROXY=external), if there is one.
external_proxy() {
  local net name
  net=$(env_get TRAEFIK_NETWORK)
  [[ -n $net ]] || return 0
  for name in $(docker network inspect "$net" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null); do
    if docker inspect -f '{{.Config.Image}}' "$name" 2>/dev/null | grep -qi traefik; then
      printf '%s' "$name"
      return 0
    fi
  done
}

# M-25: no secret may keep the public value of .env.example (a hand-written or copied .env).
check_example_secrets() {
  local name value sample bad=()
  for name in "${EXAMPLE_SECRETS[@]}"; do
    value=$(env_get "$name")
    sample=$(example_value "$name")
    [[ -n $value && -n $sample && $value == "$sample" ]] && bad+=("$name")
  done
  ((${#bad[@]} == 0)) ||
    fail "Estos secretos de .env tienen el valor de ejemplo de .env.example, público: ${bad[*]}. Genera valores propios (DEPLOYMENT.md §4.1)."
}

# The reference citizen app was renamed (carpeta -> citizen-app, commit 9de1423): a .env from
# before keeps the old names and Compose refuses to start without DEN_CITIZEN_APP_CLIENT_SECRET.
# The values are carried over (same secret: the realm client keeps it); the old lines stay, unused.
# `install.sh realms` renames the Keycloak client (scripts/keycloak-citizen-app.mjs).
migrate_citizen_app_env() {
  local old new
  old=$(env_get DEN_CARPETA_CLIENT_SECRET)
  if [[ -z $(env_get DEN_CITIZEN_APP_CLIENT_SECRET) && -n $old ]]; then
    env_set DEN_CITIZEN_APP_CLIENT_SECRET "$old"
    chmod 600 "$ENV_FILE"
    info "DEN_CITIZEN_APP_CLIENT_SECRET en .env, copiado de DEN_CARPETA_CLIENT_SECRET (app ciudadana renombrada)."
  fi
  # The pilot published the app at /carpeta; the proxy routes /citizen-app now.
  old=$(env_get DEN_CARPETA_URL)
  if [[ -z $(env_get DEN_CITIZEN_APP_URL) && -n $old ]]; then
    env_set DEN_CITIZEN_APP_URL "${old%/carpeta}$([[ $old == */carpeta ]] && echo /citizen-app)"
    info "DEN_CITIZEN_APP_URL en .env: $(env_get DEN_CITIZEN_APP_URL) (antes DEN_CARPETA_URL)."
  fi
  # The client id the API accepts, and the notices' receiver (its id and its Compose address).
  old=$(env_get DEN_CITIZEN_CLIENTS)
  new=$(printf '%s' "$old" | sed -E 's/(^|,)carpeta-ciudadana(,|$)/\1citizen-app\2/')
  if [[ $new != "$old" ]]; then
    env_set DEN_CITIZEN_CLIENTS "$new"
    info "DEN_CITIZEN_CLIENTS en .env: carpeta-ciudadana -> citizen-app."
  fi
  old=$(env_get DEN_CITIZEN_APPS)
  new=$(printf '%s' "$old" | sed -e 's/"carpeta-ciudadana"/"citizen-app"/' \
    -e 's#http://carpeta:3100/carpeta/#http://citizen-app:3100/citizen-app/#')
  if [[ $new != "$old" ]]; then
    env_set DEN_CITIZEN_APPS "'$new'"
    info "DEN_CITIZEN_APPS en .env: la app ciudadana de referencia es citizen-app."
  fi
}

# --- compose ------------------------------------------------------------------------------------
# Published images (docker-compose.images.yml) when .env names a tag; they exist for x86_64 only.
uses_images() { [[ -n $(env_get DEN_IMAGE_TAG) && $(uname -m) == x86_64 ]]; }

compose_args() {
  COMPOSE=(docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml)
  [[ $(env_get DEN_INSTALL_PROXY) == bundled ]] && COMPOSE+=(-f infra/compose/docker-compose.edge.yml)
  COMPOSE+=(--env-file "$ENV_FILE")
  [[ $(env_get DEN_INSTALL_OBSERVABILITY) == true ]] && COMPOSE+=(--profile observability)
  [[ $(env_get DEN_INSTALL_ANTIVIRUS) == true ]] && COMPOSE+=(--profile antivirus)
  uses_images && COMPOSE+=(-f infra/compose/docker-compose.images.yml)
  return 0
}
dc() { compose_args; "${COMPOSE[@]}" "$@"; }
require_install() { [[ -f $ENV_FILE ]] || fail "No hay instalación en $ROOT (falta .env). Ejecuta: sudo ./install.sh"; }

# --- checks -------------------------------------------------------------------------------------
version_ge() { [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1) == "$2" ]]; }

# Docker Engine with Docker's own script (get.docker.com), never piped into a shell (B-30): it is
# downloaded, its SHA-256 shown and, with DEN_DOCKER_SCRIPT_SHA256 set (a checksum taken from a
# channel you trust), checked; it runs only after you confirm. The alternative is Docker's
# packages for your distribution (https://docs.docker.com/engine/install/), then run this again.
install_docker() {
  local script sum
  info "Se puede instalar con el script oficial de Docker (https://get.docker.com) o con los paquetes"
  info "de Docker para tu distribución (https://docs.docker.com/engine/install/) y ejecutar esto de nuevo."
  yes_no "¿Descargo el script oficial para revisarlo y ejecutarlo?" s ||
    fail "Instala Docker Engine ≥ $MIN_ENGINE con Compose ≥ $MIN_COMPOSE y vuelve a ejecutar."
  script=$(mktemp)
  curl -fsSL --proto '=https' --tlsv1.2 https://get.docker.com -o "$script" ||
    fail "No pude descargar https://get.docker.com"
  sum=$(sha256sum "$script" | cut -d ' ' -f 1)
  info "Script descargado en $script ($(wc -c <"$script") bytes), SHA-256 $sum"
  if [[ -n ${DEN_DOCKER_SCRIPT_SHA256-} ]]; then
    [[ $sum == "${DEN_DOCKER_SCRIPT_SHA256,,}" ]] ||
      fail "El SHA-256 no es el de DEN_DOCKER_SCRIPT_SHA256: no lo ejecuto."
    ok "Coincide con DEN_DOCKER_SCRIPT_SHA256"
  else
    info "Revísalo antes (less $script) o compara su SHA-256 con uno que obtengas por otro canal"
    info "(DEN_DOCKER_SCRIPT_SHA256=<sha256> sudo -E ./install.sh lo comprueba solo)."
    yes_no "¿Lo ejecuto como root?" n || fail "No se instaló Docker. El script quedó en $script."
  fi
  sh "$script"
  rm -f "$script"
  systemctl enable --now docker >/dev/null 2>&1 || true
}

check_system() {
  step "Paso 1 · Verificación del servidor"
  [[ $(uname -s) == Linux ]] || fail "Este instalador es para Linux (encontré $(uname -s))."
  [[ $EUID -eq 0 ]] || fail "Ejecútalo como root: sudo ./install.sh"
  case $(uname -m) in
    x86_64 | aarch64 | arm64) ok "Arquitectura $(uname -m)" ;;
    *) fail "Arquitectura no soportada: $(uname -m) (se necesita x86_64 o arm64)" ;;
  esac
  [[ -r /etc/os-release ]] && ok "Sistema: $(. /etc/os-release && echo "$PRETTY_NAME")"

  local cpus mem_gb disk_gb
  cpus=$(nproc)
  mem_gb=$(awk '/MemTotal/ {printf "%d", $2/1024/1024 + 0.5}' /proc/meminfo)
  if ((cpus >= 4)); then ok "CPU: $cpus núcleos"; else warn "CPU: $cpus núcleos (mínimo 4; la compilación será lenta)"; fi
  if ((mem_gb >= 15)); then ok "RAM: ${mem_gb} GB"
  elif ((mem_gb >= 7)); then warn "RAM: ${mem_gb} GB (suficiente sin analítica; recomendado 16 GB)"
  else fail "RAM: ${mem_gb} GB. El mínimo es 8 GB (ver docs/INSTALL.md §1)."; fi
  MEM_GB=$mem_gb

  # The tools this script and the checks use (B-30).
  local tool missing=()
  for tool in curl git openssl; do command -v "$tool" >/dev/null 2>&1 || missing+=("$tool"); done
  ((${#missing[@]} == 0)) ||
    fail "Faltan programas: ${missing[*]}. Instálalos (p. ej. apt-get install ${missing[*]}) y vuelve a ejecutar."

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker no está instalado."
    install_docker
  fi
  docker info >/dev/null 2>&1 || fail "Docker no responde (¿está iniciado? systemctl start docker)"
  local cv ev
  ev=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || true
  version_ge "${ev:-0}" "$MIN_ENGINE" || fail "Docker Engine ${ev:-desconocido}; se necesita ≥ $MIN_ENGINE."
  cv=$(docker compose version --short 2>/dev/null | sed 's/^v//') || true
  [[ -n $cv ]] || fail "Falta el plugin Docker Compose v2 (paquete docker-compose-plugin)."
  version_ge "$cv" "$MIN_COMPOSE" || fail "Docker Compose $cv; se necesita ≥ $MIN_COMPOSE."
  ok "Docker $ev, Compose $cv"

  local docker_root
  docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
  disk_gb=$(df -Pk "$docker_root" | awk 'NR==2 {printf "%d", $4/1024/1024}')
  if ((disk_gb >= 60)); then ok "Disco libre en $docker_root: ${disk_gb} GB"
  elif ((disk_gb >= 30)); then warn "Disco libre en $docker_root: ${disk_gb} GB (recomendado ≥ 60 GB)"
  else fail "Disco libre en $docker_root: ${disk_gb} GB. Se necesitan al menos 30 GB."; fi

  [[ -e /dev/net/tun ]] && ok "/dev/net/tun disponible (túneles WireGuard de los nodos)" ||
    warn "No existe /dev/net/tun: el hub WireGuard no podrá levantar el túnel de los nodos."

  # Files cloned with a restrictive umask break the containers that mount them (step-ca).
  local unreadable
  # infra/edge/certs holds the portal's private key: it stays out of this fix.
  local tracked=(find infra config scripts -path infra/edge/certs -prune -o)
  unreadable=$("${tracked[@]}" -type f ! -perm -o+r -print 2>/dev/null | head -n 1 || true)
  if [[ -n $unreadable ]]; then
    warn "Hay archivos del repositorio sin permiso de lectura para otros (p. ej. $unreadable)."
    "${tracked[@]}" \( -type f -o -type d \) -exec chmod o+rX {} + 2>/dev/null
    ok "Permisos de lectura corregidos en infra/, config/ y scripts/ (sin tocar infra/edge/certs)"
  fi
}

port_busy() { # port proto
  if command -v ss >/dev/null 2>&1; then
    if [[ $2 == udp ]]; then ss -Hlun "sport = :$1" | grep -q .; else ss -Hltn "sport = :$1" | grep -q .; fi
  else
    return 1
  fi
}

check_ports() {
  local busy=()
  if [[ $PROXY == bundled ]]; then
    for p in 80 443; do port_busy "$p" tcp && busy+=("$p/tcp"); done
  fi
  port_busy 51820 udp && busy+=("51820/udp")
  if ((${#busy[@]})); then
    # Our own containers already hold them on a re-run.
    if docker ps --format '{{.Names}}' | grep -qE '^den-(edge|wg-hub)-1$'; then
      ok "Puertos ${busy[*]} ya en uso por esta instalación"
    else
      fail "Puertos ocupados por otro servicio: ${busy[*]}. Libéralos o usa la opción de proxy existente."
    fi
  else
    ok "Puertos libres: $([[ $PROXY == bundled ]] && echo '80/tcp 443/tcp ')51820/udp"
  fi
}

check_dns() {
  local name ips host_ips
  host_ips=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v ':' | xargs || true)
  for name in "$PORTAL_HOST" "$GATEWAY_HOST"; do
    ips=$(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u | xargs || true)
    if [[ -z $ips ]]; then
      warn "$name no resuelve todavía en DNS. Crea el registro A hacia la IP pública de este servidor."
    elif [[ -n $host_ips ]] && ! grep -qwF -- "${ips%% *}" <<<"$host_ips"; then
      info "$name → $ips (este servidor tiene $host_ips; correcto si hay NAT o un balanceador delante)"
    else
      ok "$name → $ips"
    fi
  done
}

# --- questions ----------------------------------------------------------------------------------
questions() {
  step "Paso 2 · País"
  local countries
  countries=$(find config/country -maxdepth 1 -name '*.yaml' ! -name example.yaml -exec basename {} .yaml \; | sort | xargs)
  info "Configuraciones disponibles en config/country/: $countries"
  while :; do
    ask COUNTRY "Código del país" "$(awk '{print $1}' <<<"$countries")"
    [[ -f config/country/$COUNTRY.yaml ]] && break
    warn "No existe config/country/$COUNTRY.yaml"
  done

  step "Paso 3 · Nombres públicos"
  info "Se necesitan DOS nombres DNS que apunten a este servidor:"
  info "  • el del portal (personas: portal web, API, inicio de sesión)"
  info "  • el del gateway (sistemas: tráfico con mTLS de aplicaciones y nodos del kit)"
  while :; do
    ask PORTAL_HOST "Nombre del portal (p. ej. den.entidad.gov.xx)"
    PORTAL_HOST=${PORTAL_HOST,,}
    [[ $PORTAL_HOST =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] && break
    warn "Escribe solo el nombre, sin https:// ni rutas."
  done
  while :; do
    ask GATEWAY_HOST "Nombre del gateway" "gw.$PORTAL_HOST"
    GATEWAY_HOST=${GATEWAY_HOST,,}
    if [[ $GATEWAY_HOST == "$PORTAL_HOST" ]]; then warn "Debe ser distinto del nombre del portal."; continue; fi
    [[ $GATEWAY_HOST =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] && break
    warn "Escribe solo el nombre, sin https:// ni rutas."
  done

  step "Paso 4 · Proxy de entrada y certificados"
  info "1) Incluido (recomendado): este instalador pone Traefik en los puertos 80 y 443."
  info "2) Ya tengo un Traefik en este servidor: me uno a su red de Docker."
  local choice
  ask choice "Opción" 1
  if [[ $choice == 2 ]]; then
    PROXY=external
    ask EDGE_NET "Nombre de la red de Docker de tu Traefik" "traefik"
    docker network inspect "$EDGE_NET" >/dev/null 2>&1 || fail "No existe la red de Docker '$EDGE_NET'."
    TLS=external
    info "El instalador escribe las rutas del portal y del gateway para tu Traefik (proveedor de archivos)."
    while :; do
      ask EDGE_ENTRYPOINT "EntryPoint HTTPS de tu Traefik" "websecure"
      ask EDGE_RESOLVER "certResolver de tu Traefik para el certificado del portal (\"-\": tu Traefik ya lo tiene)" "-"
      [[ $EDGE_ENTRYPOINT =~ ^[A-Za-z0-9_-]+$ && $EDGE_RESOLVER =~ ^[A-Za-z0-9_-]+$ ]] && break
      warn "Solo letras, números, - y _ (nombres de Traefik)."
    done
    while :; do
      ask EDGE_DIR "Carpeta de configuración dinámica de tu Traefik en este servidor (\"-\": solo generar el archivo)" "-"
      env_quote "$EDGE_DIR" >/dev/null && break
      warn "Sin comillas ni barras invertidas."
    done
    [[ $EDGE_DIR == - || -d $EDGE_DIR ]] || fail "No existe la carpeta $EDGE_DIR."
  else
    PROXY=bundled
    EDGE_NET=$EDGE_NETWORK
    info "Certificado del portal ($PORTAL_HOST):"
    info "1) Let's Encrypt automático (el puerto 80 debe ser alcanzable desde internet)"
    info "2) Certificado propio de la entidad (archivos PEM: cadena completa y llave privada)"
    ask choice "Opción" 1
    if [[ $choice == 2 ]]; then
      TLS=files
      while :; do
        ask CERT_FILE "Ruta del certificado (cadena completa, PEM)"
        ask KEY_FILE "Ruta de la llave privada (PEM)"
        [[ -r $CERT_FILE && -r $KEY_FILE ]] && break
        warn "No puedo leer alguno de los dos archivos."
      done
    else
      TLS=letsencrypt
      while :; do
        ask ACME_EMAIL "Correo de contacto para Let's Encrypt (opcional)" ""
        [[ -z $ACME_EMAIL || $ACME_EMAIL =~ ^[^[:space:]@]+@[^[:space:]@]+$ ]] &&
          env_quote "$ACME_EMAIL" >/dev/null && break
        warn "Escribe un correo (nombre@dominio) o deja vacío."
      done
    fi
  fi
  info "El certificado del gateway ($GATEWAY_HOST) no se pide aquí: lo emite la CA de la red (step-ca)."
  info "La consola de administración de Keycloak (/auth/admin) no se publica (B-28), salvo para las"
  info "direcciones o redes que indiques aquí (p. ej. la IP fija de la oficina del operador)."
  while :; do
    ask ADMIN_ALLOW "Direcciones permitidas para /auth/admin, separadas por comas (Enter = ninguna)" ""
    admin_sources "$ADMIN_ALLOW" >/dev/null && break
    warn "Direcciones IP o redes CIDR (203.0.113.10, 198.51.100.0/24), separadas por comas."
  done

  step "Paso 5 · Observabilidad (analítica, métricas y alertas)"
  info "OpenSearch guarda los metadatos de cada llamada para los indicadores; Prometheus, Alertmanager"
  info "y Grafana (/grafana) vigilan la plataforma y avisan al operador por correo. Suma ~1,5 GB de RAM."
  local def=n
  ((MEM_GB >= 15)) && def=s
  if yes_no "¿Activar la observabilidad?" "$def"; then OBSERVABILITY=true; else OBSERVABILITY=false; fi
  info "El antivirus (ClamAV) revisa cada documento que se sube (designaciones, acuerdos) antes de"
  info "guardarlo. Suma ~1,2 GB de RAM y descarga sus firmas de internet."
  def=n
  ((MEM_GB >= 8)) && def=s
  if yes_no "¿Activar el antivirus de documentos?" "$def"; then ANTIVIRUS=true; else ANTIVIRUS=false; fi

  step "Paso 6 · Usuarios de demostración"
  info "El piloto carga entidades ficticias y usuarios de demo (operador, regulador, publicador…)."
  info "Es la única forma, por ahora, de tener el primer administrador de plataforma (docs/INSTALL.md §6)."
  while :; do
    ask_secret DEMO_PASSWORD "Contraseña común de los usuarios de demo, 12 caracteres o más (Enter = una aleatoria)"
    if [[ -n $DEMO_PASSWORD && ${#DEMO_PASSWORD} -lt 12 ]]; then
      warn "La política de contraseñas de Keycloak exige 12 caracteres o más."
    elif ! env_quote "$DEMO_PASSWORD" >/dev/null; then
      warn "Sin comillas, barras invertidas ni saltos de línea (\$ y # sí se admiten)."
    else
      break
    fi
  done
  info "Los usuarios con rol crítico (plataforma, operador, regulador, auditoría, responsable de datos)"
  info "reciben otra contraseña, aleatoria: la común se puede compartir en un taller (sudo ./install.sh credentials)."

  step "Resumen"
  printf '  %-28s %s\n' "País:" "$COUNTRY" \
    "Portal:" "https://$PORTAL_HOST" \
    "Gateway (mTLS):" "https://$GATEWAY_HOST" \
    "Proxy:" "$([[ $PROXY == bundled ]] && echo "incluido (Traefik en 80/443)" || echo "existente (red $EDGE_NET)")" \
    "Certificado del portal:" "$(case $TLS in letsencrypt) echo "Let's Encrypt";; files) echo "propio ($CERT_FILE)";; *) echo "lo gestiona tu proxy";; esac)" \
    "Observabilidad:" "$([[ $OBSERVABILITY == true ]] && echo sí || echo no)"     "Antivirus:" "$([[ $ANTIVIRUS == true ]] && echo sí || echo no)" \
    "Contraseña de demo:" "$([[ -n $DEMO_PASSWORD ]] && echo "la indicada" || echo "aleatoria")"
  yes_no "¿Continuar con la instalación?" s || fail "Instalación cancelada; no se cambió nada."
}

# --- install ------------------------------------------------------------------------------------
write_env() {
  step "Paso 7 · Secretos y configuración (.env)"
  local args=("https://$PORTAL_HOST" --gateway-host "$GATEWAY_HOST" --traefik-network "$EDGE_NET" --country "$COUNTRY")
  # The password goes through the environment, never on a command line (ps would show it).
  DEN_DEPLOY_DEMO_PASSWORD="$DEMO_PASSWORD" docker run --rm -e DEN_DEPLOY_DEMO_PASSWORD     -v "$ROOT:/w" -w /w "$NODE_IMAGE" node scripts/make-deploy-env.mjs "${args[@]}"
  cat >>"$ENV_FILE" <<EOF

# Installer (install.sh, docs/INSTALL.md)
DEN_PORTAL_HOST=$PORTAL_HOST
DEN_GATEWAY_HOST=$GATEWAY_HOST
DEN_INSTALL_PROXY=$PROXY
DEN_INSTALL_TLS=$TLS
DEN_ACME_EMAIL=$(env_quote "${ACME_EMAIL-}")
DEN_EDGE_ENTRYPOINT=${EDGE_ENTRYPOINT-websecure}
DEN_EDGE_CERT_RESOLVER=${EDGE_RESOLVER--}
DEN_EDGE_DYNAMIC_DIR=$(env_quote "${EDGE_DIR--}")
DEN_KEYCLOAK_ADMIN_ALLOW=$(env_quote "${ADMIN_ALLOW-}")
DEN_INSTALL_OBSERVABILITY=$OBSERVABILITY
DEN_INSTALL_ANTIVIRUS=$ANTIVIRUS
EOF
  [[ $ANTIVIRUS == true ]] && env_set DEN_CLAMAV_URL tcp://clamav:3310
  chmod 600 "$ENV_FILE"
  ok ".env escrito (permisos 600). Contiene todas las llaves de la instalación."
  warn "Guarda una copia cifrada de .env FUERA de este servidor: sin ella no se pueden recuperar los datos."
}

load_env_settings() {
  PORTAL_HOST=$(env_get DEN_PORTAL_HOST)
  GATEWAY_HOST=$(env_get DEN_GATEWAY_HOST)
  PROXY=$(env_get DEN_INSTALL_PROXY)
  TLS=$(env_get DEN_INSTALL_TLS)
  OBSERVABILITY=$(env_get DEN_INSTALL_OBSERVABILITY)
  ANTIVIRUS=$(env_get DEN_INSTALL_ANTIVIRUS)
  EDGE_NET=$(env_get TRAEFIK_NETWORK)
  EDGE_ENTRYPOINT=$(env_get DEN_EDGE_ENTRYPOINT)
  EDGE_RESOLVER=$(env_get DEN_EDGE_CERT_RESOLVER)
  EDGE_DIR=$(env_get DEN_EDGE_DYNAMIC_DIR)
  ADMIN_ALLOW=$(env_get DEN_KEYCLOAK_ADMIN_ALLOW)
  [[ -n $PORTAL_HOST && -n $PROXY ]] ||
    fail ".env existe pero no lo escribió este instalador (faltan DEN_PORTAL_HOST / DEN_INSTALL_PROXY). Ver docs/INSTALL.md §7."
}

write_edge() {
  mkdir -p infra/edge/dynamic infra/edge/certs
  if [[ $PROXY != bundled ]]; then
    write_edge_external
    return
  fi
  local tls='{ certResolver: le }'
  if [[ $TLS == files ]]; then
    tls='{}'
    if [[ -n ${CERT_FILE-} ]]; then
      install -m 600 "$CERT_FILE" infra/edge/certs/portal.crt
      install -m 600 "$KEY_FILE" infra/edge/certs/portal.key
    fi
    [[ -f infra/edge/certs/portal.crt ]] || fail "Falta infra/edge/certs/portal.crt (certificado propio)."
    cat >infra/edge/dynamic/certs.yml <<'EOF'
# Written by install.sh: the portal's own certificate (DEN_INSTALL_TLS=files).
tls:
  stores:
    default:
      defaultCertificate:
        certFile: /etc/traefik/certs/portal.crt
        keyFile: /etc/traefik/certs/portal.key
EOF
  else
    rm -f infra/edge/dynamic/certs.yml
  fi
  render_edge websecure "$tls" infra/edge/dynamic/den.yml
  ok "Rutas del proxy en infra/edge/dynamic/den.yml"
}

# admin_sources "a, b": Traefik's sourceRange for Keycloak's administration (B-28), from
# DEN_KEYCLOAK_ADMIN_ALLOW, each quoted; with none, loopback only, which no visitor has. Fails on an
# entry that is not an address or a CIDR network.
admin_sources() {
  local entry entries out=()
  IFS=',' read -r -a entries <<<"${1// /}"
  for entry in "${entries[@]}"; do
    [[ -z $entry ]] && continue
    [[ $entry =~ ^[0-9A-Fa-f.:]+(/[0-9]{1,3})?$ ]] || return 1
    out+=("'$entry'")
  done
  ((${#out[@]})) || out=("'127.0.0.1/32'")
  local IFS=,
  printf '%s' "${out[*]}"
}

# render_edge ENTRYPOINT TLS FILE: the routes of the portal and the gateway (den.yml.template).
render_edge() {
  local sources token
  sources=$(admin_sources "${ADMIN_ALLOW-}") ||
    fail "DEN_KEYCLOAK_ADMIN_ALLOW: direcciones IP o redes CIDR separadas por comas."
  token=$(env_get DEN_WEB_PROXY_TOKEN)
  [[ $token =~ ^[A-Za-z0-9_-]{32,}$ ]] ||
    fail "DEN_WEB_PROXY_TOKEN: 32 o más letras, números, - o _ (sudo ./install.sh start la genera si falta)."
  # It holds the proxy's token: readable by its owner (root) only.
  (umask 077 && sed -e "s/@PORTAL_HOST@/$PORTAL_HOST/g" -e "s/@GATEWAY_HOST@/$GATEWAY_HOST/g" \
    -e "s/@TLS@/$2/g" -e "s/@ENTRYPOINT@/$1/g" -e "s#@ADMIN_SOURCES@#${sources//,/, }#g" \
    -e "s#@PROXY_TOKEN@#$token#g" infra/edge/den.yml.template >"$3.tmp") && mv -f "$3.tmp" "$3"
  chmod 600 "$3"
}

# write_edge_external: the same routes for a Traefik that is already on this server (file
# provider). They go to its dynamic folder when the operator gave it; otherwise the file is left
# in infra/edge/den-external.yml to be copied by hand.
write_edge_external() {
  local tls='{}' file=infra/edge/den-external.yml
  [[ -n ${EDGE_RESOLVER-} && $EDGE_RESOLVER != - ]] && tls="{ certResolver: $EDGE_RESOLVER }"
  render_edge "${EDGE_ENTRYPOINT:-websecure}" "$tls" "$file"
  if [[ -n ${EDGE_DIR-} && $EDGE_DIR != - ]]; then
    [[ -d $EDGE_DIR ]] || fail "No existe la carpeta dinámica de tu Traefik: $EDGE_DIR"
    install -m 600 "$file" "$EDGE_DIR/den.yml"  # it holds DEN_WEB_PROXY_TOKEN
    ok "Rutas del portal y del gateway en $EDGE_DIR/den.yml (tu Traefik las carga solo si vigila esa carpeta)"
  else
    warn "Copia $ROOT/$file a la carpeta de configuración dinámica de tu Traefik: sin esas rutas el portal no responde."
  fi
}

prepare_host() {
  step "Paso 8 · Preparación del servidor"
  docker network inspect "$EDGE_NET" >/dev/null 2>&1 || {
    docker network create "$EDGE_NET" >/dev/null && ok "Red de Docker $EDGE_NET creada"
  }
  if [[ $OBSERVABILITY == true ]]; then
    if (($(sysctl -n vm.max_map_count) < 262144)); then
      echo 'vm.max_map_count=262144' >/etc/sysctl.d/99-den-opensearch.conf
      sysctl --system >/dev/null
      ok "vm.max_map_count=262144 (OpenSearch), persistente en /etc/sysctl.d/99-den-opensearch.conf"
    else
      ok "vm.max_map_count ya es suficiente"
    fi
  fi
  local ports=(51820/udp)
  [[ $PROXY == bundled ]] && ports=(80/tcp 443/tcp 51820/udp)
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q 'Status: active'; then
    if yes_no "El firewall ufw está activo. ¿Abro ${ports[*]}?" s; then
      for p in "${ports[@]}"; do ufw allow "$p" >/dev/null; done
      ok "ufw: abiertos ${ports[*]}"
    fi
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    if yes_no "firewalld está activo. ¿Abro ${ports[*]}?" s; then
      for p in "${ports[@]}"; do firewall-cmd --permanent --add-port="$p" >/dev/null; done
      firewall-cmd --reload >/dev/null
      ok "firewalld: abiertos ${ports[*]}"
    fi
  else
    info "No detecté ufw ni firewalld. Si hay un firewall externo, debe permitir: ${ports[*]}"
  fi
}

start_stack() {
  step "Paso 9 · Construcción y arranque (10–20 minutos la primera vez)"
  if uses_images; then
    info "Imágenes publicadas $(env_get DEN_IMAGE_TAG) del portal, el API, el hub y el runner; se compilan solo los auxiliares."
  else
    info "Se compilan el portal, el API y los servicios auxiliares; después arranca todo en orden."
  fi
  if ! dc up -d --build --wait --wait-timeout 1800; then
    dc ps || true
    fail "Algún servicio no quedó sano. Revisa: sudo ./install.sh logs <servicio> (docs/INSTALL.md §8)."
  fi
  ok "Todos los servicios están arriba"
}

curl_portal() { # path [method] → HTTP code, through this server's proxy
  local args=(-sk -o /dev/null -w '%{http_code}' --max-time 10 -X "${2:-GET}")
  [[ $PROXY == bundled ]] && args+=(--resolve "$PORTAL_HOST:443:127.0.0.1")
  curl "${args[@]}" "https://$PORTAL_HOST$1" || true
}

# not_public PATH METHOD WHAT: the proxy must not send PATH to the API (M-26). The API answers 401
# there (it wants a token); the web, which gets every other path, 404. Only an exact 404 passes:
# any other code, or no answer at all, is reported.
not_public() {
  local code
  code=$(curl_portal "$1" "$2")
  case $code in
    404) ok "$3 no está expuesto al público (404 en $1)" ;;
    000) warn "No pude comprobar $1: el proxy no respondió (¿DNS, puerto 443?)" ;;
    *) warn "¡$2 $1 respondió $code desde afuera, se esperaba 404! $3 podría estar expuesto: revisa las rutas del proxy (DEPLOYMENT.md §5.2)." ;;
  esac
}

verify() {
  step "Paso 10 · Comprobaciones"
  local code i
  code=$(curl_portal /api/v1/health)
  [[ $code == 200 ]] && ok "API del portal responde (/api/v1/health)" || warn "/api/v1/health respondió $code"
  not_public /api/v1/opa/bundle.tar.gz GET "El bundle de OPA"
  not_public /api/v1/internal/subject-access POST "El colector de transparencia"
  code=$(curl_portal /auth/admin/)
  [[ -z ${ADMIN_ALLOW-} && $code != 403 ]] &&
    warn "/auth/admin respondió $code desde aquí, se esperaba 403: la consola de Keycloak podría estar expuesta (B-28)."
  code=$(curl_portal /auth/realms/den-portal/.well-known/openid-configuration)
  [[ $code == 200 ]] && ok "Keycloak responde en /auth" || warn "Keycloak respondió $code (puede tardar unos minutos más)"
  if dc exec -T api wget -qO- 'http://opa:8181/health?bundles' >/dev/null 2>&1; then
    ok "OPA tiene el bundle de política activo"
  else
    warn "OPA aún no tiene el bundle (se descarga cada 10–20 s)"
  fi
  if [[ $PROXY == bundled && $TLS == letsencrypt ]]; then
    if curl -fs -o /dev/null --max-time 10 --resolve "$PORTAL_HOST:443:127.0.0.1" "https://$PORTAL_HOST/api/v1/health"; then
      ok "Certificado de Let's Encrypt válido para $PORTAL_HOST"
    else
      warn "Aún no hay certificado válido de Let's Encrypt: el DNS debe apuntar aquí y el puerto 80 estar abierto. Traefik reintenta solo."
    fi
  fi
  if command -v openssl >/dev/null 2>&1; then
    local issuer=''
    for i in 1 2 3 4 5 6; do
      issuer=$(openssl s_client -connect 127.0.0.1:443 -servername "$GATEWAY_HOST" </dev/null 2>/dev/null |
        openssl x509 -noout -issuer 2>/dev/null || true)
      [[ -n $issuer ]] && break
      sleep 5
    done
    [[ -n $issuer ]] && ok "Gateway $GATEWAY_HOST presenta su certificado de la red ($issuer)" ||
      info "No pude leer el certificado del gateway desde aquí; se comprueba en docs/INSTALL.md §5."
  fi
}

summary() {
  step "Listo"
  printf '  %-26s %s\n' \
    "Portal:" "https://$PORTAL_HOST" \
    "Gateway (sistemas, mTLS):" "https://$GATEWAY_HOST" \
    "Consola de Keycloak:" "https://$PORTAL_HOST/auth/admin/ ($([[ -n ${ADMIN_ALLOW-} ]] && echo "desde $ADMIN_ALLOW" || echo "cerrada: DEN_KEYCLOAK_ADMIN_ALLOW"))" \
    "Correo de pruebas:" "https://$PORTAL_HOST/mail" \
    "App ciudadana demo:" "https://$PORTAL_HOST/citizen-app"
  [[ $OBSERVABILITY == true ]] && printf '  %-26s %s\n' "Tablero del operador:" "https://$PORTAL_HOST/grafana/"
  echo
  info "Usuarios y contraseñas:   sudo ./install.sh credentials"
  info "Código de segundo factor: sudo ./install.sh otp"
  info "Estado:                   sudo ./install.sh status"
  info "Siguiente paso: docs/INSTALL.md §5 (verificación de punta a punta) y docs/es/guides/operator.md"
  info "Usuarios de demo: cuando tu gente tenga sus roles (platform-role grant), desactívalos con sudo ./install.sh demo-users disable"
}

cmd_install() {
  printf '%s\n' "${B}Instalador del Portal DEN — portal + gateway en un servidor (piloto)${N}"
  check_system
  if [[ -f $ENV_FILE ]]; then
    step "Instalación existente"
    load_env_settings
    ok "Encontré .env para https://$PORTAL_HOST: se conservan sus secretos y respuestas."
    yes_no "¿Reaplicar la configuración y arrancar todo?" s || exit 0
  else
    questions
  fi
  check_ports
  check_dns
  [[ -f $ENV_FILE ]] || write_env
  ensure_env_additions
  check_example_secrets
  write_edge
  prepare_host
  start_stack
  apply_pending_realms
  verify
  summary
}

# --- day 2 --------------------------------------------------------------------------------------
cmd_status() {
  require_install; load_env_settings
  dc ps --format 'table {{.Service}}\t{{.Status}}'
  echo
  verify
}

cmd_credentials() {
  require_install
  warn "Datos sensibles: no los compartas por canales abiertos."
  printf '  %-34s %s\n' \
    "Roles críticos (contraseña aparte):" "$(env_get DEN_DEMO_CRITICAL_PASSWORD)" \
    "  operador / revisor:" "ana.operadora (segundo factor)" \
    "  administrador de plataforma:" "pablo.plataforma (segundo factor)" \
    "  regulador:" "marta.regulador (segundo factor)" \
    "  auditoría:" "sofia.auditora (segundo factor)" \
    "  responsable de datos (salud):" "lucia.datos (segundo factor)" \
    "Usuarios de demo (contraseña común):" "$(env_get DEN_DEMO_USER_PASSWORD)" \
    "  publicador (entidad de salud):" "pedro.publicador" \
    "  administradora de entidad:" "elena.admin" \
    "  desarrollador (consumidor):" "carlos.dev" \
    "  ciudadana (app):" "ciudadana.demo" \
    "Keycloak (realm master):" "$(env_get KEYCLOAK_ADMIN_USER) / $(env_get KEYCLOAK_ADMIN_PASSWORD)" \
    "Correo de pruebas (/mail):" "$(env_get MAILPIT_UI_AUTH | sed 's/:/ \/ /')"
  [[ $(env_get DEN_INSTALL_OBSERVABILITY) == true ]] &&
    printf '  %-34s %s\n' "Grafana (/grafana):" "admin / $(env_get GRAFANA_ADMIN_PASSWORD)"
  info "Código de segundo factor de los usuarios de demo: sudo ./install.sh otp"
  info "La contraseña común se puede compartir en un taller; la de los roles críticos, no (M-29)."
  [[ $(env_get DEN_DEMO_CRITICAL_PENDING) == true ]] &&
    warn "Keycloak aún tiene la contraseña común en los roles críticos: sudo ./install.sh realms"
  info "Si ya los desactivaste (demo-users disable), no entran: sudo ./install.sh demo-users list"
}

# Platform roles (operator, reviewer, regulator, auditor) for the operator's own people: no screen
# grants them yet. The person registers in the portal, verifies the address and signs in once.
cmd_platform_role() {
  require_install
  [[ $# -ge 1 ]] || fail "Uso: ./install.sh platform-role grant|revoke <correo> <rol> [--reason \"motivo\"] | list"
  dc exec -T api node --enable-source-maps dist/admin/platform-roles-cli.js "$@"
  [[ $1 == grant ]] &&
    info "Cuando tu gente tenga sus roles, desactiva los usuarios de demo: sudo ./install.sh demo-users disable"
  return 0
}

# The seed's demo users (pablo.plataforma, ana.operadora...) keep their platform roles and the demo
# password. Once the operator's own people have theirs, `disable` stops them signing in (Keycloak)
# and revokes their roles in the portal, audited; the seed leaves them disabled (P-08). It refuses
# while no platform_admin of the operator's own is active.
cmd_demo_users() {
  require_install
  # The master administrator is not in the API's environment (A-2): it goes in for this command
  # only, by name (`-e VAR` takes the value from here, never on a command line).
  export KEYCLOAK_ADMIN_USER KEYCLOAK_ADMIN_PASSWORD
  KEYCLOAK_ADMIN_USER=$(env_get KEYCLOAK_ADMIN_USER)
  KEYCLOAK_ADMIN_PASSWORD=$(env_get KEYCLOAK_ADMIN_PASSWORD)
  local cli=(dc exec -T -e KEYCLOAK_ADMIN_USER -e KEYCLOAK_ADMIN_PASSWORD api
    node --enable-source-maps dist/admin/demo-users-cli.js)
  case ${1:-} in
    list) "${cli[@]}" list ;;
    disable)
      shift
      local args=() yes=false
      for a in "$@"; do [[ $a == --yes ]] && yes=true || args+=("$a"); done
      if [[ $yes != true ]]; then
        "${cli[@]}" list
        warn "Los usuarios de demo del portal (no los ciudadanos de la app demo) dejarán de entrar y perderán sus roles de plataforma. No hay comando para volver atrás."
        warn "El ensayo automático (scripts/demo.mjs) y los códigos de 'otp' dejan de servir en esta instalación."
        yes_no "¿Desactivarlos?" n || exit 0
      fi
      "${cli[@]}" disable "${args[@]}"
      ;;
    *) fail "Uso: sudo ./install.sh demo-users list | disable [--reason \"motivo\"] [--yes]" ;;
  esac
}

# The settings of infra/keycloak/*-realm.json on realms Keycloak imported before (--import-realm
# skips existing realms): login flow and second factor, password policy, events, redirect URIs,
# the 60-minute verification link (P-08), the secret rotation policy and the citizen app's client
# (renamed carpeta-ciudadana -> citizen-app, R-10). Idempotent; it reaches
# Keycloak on the Compose network as the master administrator of .env.
cmd_realms() {
  require_install
  local url s
  url=$(env_get DEN_GATEWAY_KEYCLOAK_URL); url=${url:-http://keycloak:8080/auth}
  # The critical roles' own demo password (M-29), once, on a realm made before it.
  local pending=()
  [[ $(env_get DEN_DEMO_CRITICAL_PENDING) == true ]] && pending=(--demo-critical-password)
  for s in keycloak-citizen-app.mjs keycloak-portal-mfa.mjs keycloak-client-policies.mjs; do
    local args=()
    [[ $s == keycloak-portal-mfa.mjs ]] && args=("${pending[@]}")
    docker run --rm --network den_default -v "$ROOT:/w:ro" -w /w -e KEYCLOAK_URL="$url" \
      "$NODE_IMAGE" node "scripts/$s" "${args[@]}" || return 1
  done
  if ((${#pending[@]})); then
    env_set DEN_DEMO_CRITICAL_PENDING false
    ok "Los usuarios de demo con rol crítico tienen su propia contraseña (sudo ./install.sh credentials)"
  fi
  ok "Realms de Keycloak al día con infra/keycloak"
}

# After a start: the realm steps a new variable left pending (M-29).
apply_pending_realms() {
  [[ $(env_get DEN_DEMO_CRITICAL_PENDING) == true ]] || return 0
  cmd_realms || warn "No pude aplicar la contraseña de los roles críticos en Keycloak. Reintenta: sudo ./install.sh realms"
}

cmd_otp() {
  require_install
  docker run --rm -v "$ROOT:/w:ro" -w /w "$NODE_IMAGE" node scripts/totp.mjs
}

cmd_backup() {
  require_install
  local dir="$ROOT/backups/$(date +%Y%m%d-%H%M%S)" user db
  mkdir -p "$dir"; chmod 700 "$ROOT/backups" "$dir"
  user=$(env_get POSTGRES_USER); user=${user:-den}
  db=$(env_get POSTGRES_DB); db=${db:-den}
  info "Respaldando en $dir"
  # A full pgBackRest backup first (OPERATIONS.md §6), when the service runs (M6-06 onwards).
  if dc ps --status running --services 2>/dev/null | grep -qx pgbackrest; then
    dc exec -T pgbackrest pgbackrest --stanza=den --type=full backup
  fi
  # Logical dumps too: they restore into another PostgreSQL version or another platform.
  dc exec -T postgres pg_dump -U "$user" -Fc "$db" >"$dir/den.dump"
  dc exec -T postgres pg_dump -U "$user" -Fc keycloak >"$dir/keycloak.dump"
  # The pgBackRest repository is encrypted: it can leave the server as is.
  for v in "${BACKUP_VOLUMES[@]}"; do
    docker volume inspect "den_$v" >/dev/null 2>&1 &&
      docker run --rm -v "den_$v:/v:ro" -v "$dir:/b" "$NODE_IMAGE" tar czf "/b/$v.tgz" -C /v .
  done
  # Not .env (M-30): it holds the key of the encrypted repository above, the CA's password and
  # every other secret. It is kept apart, off the server, never in the same place as the backups.
  chmod 600 "$dir"/*
  ok "Respaldo completo: $(du -sh "$dir" | cut -f1). Cópialo fuera del servidor; .env, aparte."
  prune_backups
}

# Keeps the newest DEN_BACKUP_KEEP (5) backups/<date>/ (M-24): each holds the dumps and the CA.
prune_backups() {
  local keep old
  keep=$(env_get DEN_BACKUP_KEEP)
  [[ $keep =~ ^[1-9][0-9]*$ ]] || keep=5
  [[ -d $ROOT/backups ]] || return 0
  for old in $(find "$ROOT/backups" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*-[0-9]*' -printf '%f\n' |
    grep -E '^[0-9]{8}-[0-9]{6}$' | sort -r | tail -n +$((keep + 1))); do
    rm -r -- "${ROOT:?}/backups/$old"
    info "Respaldo antiguo borrado: backups/$old (se conservan $keep, DEN_BACKUP_KEEP)"
  done
}

cmd_restore() {
  require_install; load_env_settings
  local target=${1:-} args=(--stanza=den --delta)
  [[ -n $target ]] && args+=(--type=time "--target=$target" --target-action=promote)
  dc ps --status running --services 2>/dev/null | grep -qx pgbackrest ||
    fail "El servicio pgbackrest no está corriendo: no hay respaldos que restaurar (sudo ./install.sh start)."
  dc exec -T pgbackrest pgbackrest --stanza=den info
  warn "Se detiene todo, se restaura la base ${target:+al instante $target}${target:-al último estado archivado} y se arranca de nuevo. Lo escrito después de ese instante se pierde."
  yes_no "¿Continuar?" n || exit 0
  dc stop
  # The same command as scripts/restore-test.mjs; the mkdir covers a lost data volume.
  dc run --rm --no-deps pgbackrest sh -c     "mkdir -p /var/lib/postgresql/18 && pgbackrest $(printf '%q ' "${args[@]}")restore"
  dc up -d --wait --wait-timeout 1800
  # A full backup on the new timeline, the base of the next point-in-time recoveries.
  dc exec -T pgbackrest pgbackrest --stanza=den --type=full backup
  ok "Base restaurada${target:+ al instante $target}. Revisa el portal; los volúmenes (CA, documentos) se restauran aparte (OPERATIONS.md §6)."
}

cmd_update() {
  require_install; load_env_settings
  cmd_backup
  git pull --ff-only
  # Bash already read this file: the rest runs with the installer just pulled, whose
  # ensure_env_additions knows the variables (and new secrets) the new version needs.
  exec bash "$ROOT/install.sh" update-apply
}

# The "server lost" procedure (OPERATIONS.md §6.1, M-30), on a new server with this repository and
# the saved .env: creates the volumes without starting anything, fills them from a backups/<date>/
# directory (`install.sh backup`), restores the database from the pgBackRest repository into the
# empty data volume (PostgreSQL never initialises a new cluster), then starts everything and takes
# a full backup on the new timeline. The same commands as scripts/restore-test.mjs.
cmd_restore_volumes() {
  require_install; load_env_settings
  local dir=${1:-} v
  [[ -n $dir && -f $dir/pgbackrest-repo.tgz ]] ||
    fail "Uso: sudo ./install.sh restore-volumes <carpeta de respaldo> (con pgbackrest-repo.tgz, de install.sh backup)"
  dir=$(cd "$dir" && pwd)
  [[ -z $(dc ps -q 2>/dev/null) ]] ||
    fail "Hay contenedores de esta instalación en marcha: esto es para un servidor nuevo. Para volver atrás en el mismo servidor: sudo ./install.sh restore"
  if docker volume inspect den_pg-data >/dev/null 2>&1; then
    warn "Ya existe el volumen de datos de PostgreSQL (den_pg-data): se reemplaza su contenido con el respaldo."
    yes_no "¿Continuar?" n || exit 0
  fi
  step "Restauración en un servidor nuevo desde $dir"
  ensure_env_additions
  check_example_secrets
  write_edge
  prepare_host
  info "Se crean imágenes, redes y volúmenes sin arrancar nada (10–20 minutos la primera vez)."
  dc create --build
  for v in "${BACKUP_VOLUMES[@]}"; do
    if [[ ! -f $dir/$v.tgz ]]; then
      warn "No hay $v.tgz en el respaldo: el volumen den_$v queda vacío."
      continue
    fi
    docker volume create "den_$v" >/dev/null
    docker run --rm -v "den_$v:/v" -v "$dir:/b:ro" "$NODE_IMAGE" \
      sh -c 'find /v -mindepth 1 -delete && tar xzf "/b/$1.tgz" -C /v' sh "$v"
    ok "Volumen den_$v restaurado"
  done
  # Into the empty data volume, as `restore` does after a lost volume.
  dc run --rm --no-deps pgbackrest sh -c \
    "mkdir -p /var/lib/postgresql/18 && pgbackrest --stanza=den --delta restore"
  ok "Base de datos restaurada desde el repositorio de pgBackRest"
  start_stack
  dc exec -T pgbackrest pgbackrest --stanza=den --type=full backup
  ok "Restaurado. Revisa la cadena de auditoría (Consola → Auditoría → Verificar integridad) y docs/OPERATIONS.md §6.1."
}

cmd_update_apply() {
  require_install; load_env_settings
  ensure_env_additions
  check_example_secrets
  write_edge
  dc up -d --build --wait --wait-timeout 1800
  cmd_realms || warn "No pude aplicar la configuración de los realms de Keycloak. Reintenta: sudo ./install.sh realms"
  ok "Actualizado a $(git log -1 --format='%h %s')"
  warn "Revisa en DEPLOYMENT.md §5.4 si la versión pide pasos manuales (realms, variables nuevas)."
}

# Switch between published images and local builds: `images 0.2.0`, `images sha-<commit>` or
# `images build`. The tag must exist in ghcr.io and be readable without credentials.
cmd_images() {
  require_install; load_env_settings
  local tag=${1:-}
  [[ -n $tag ]] || fail "Uso: sudo ./install.sh images <etiqueta>|build (p. ej. 0.2.0 o sha-<commit>)"
  if [[ $tag == build ]]; then
    env_set DEN_IMAGE_TAG ''
    info "Se vuelve a compilar en este servidor."
    dc up -d --build --wait --wait-timeout 1800
  else
    [[ $(uname -m) == x86_64 ]] || fail "Las imágenes publicadas son solo para x86_64; este servidor es $(uname -m)."
    env_set DEN_IMAGE_TAG "$tag"
    if ! dc pull migrate api web wg-hub contract-runner; then
      env_set DEN_IMAGE_TAG ''
      fail "No pude bajar las imágenes $tag de ghcr.io (¿existe la etiqueta? ¿son públicas?). Sigo compilando aquí."
    fi
    dc up -d --wait --wait-timeout 1800
  fi
  ok "Listo: $(uses_images && echo "imágenes publicadas $tag" || echo "imágenes compiladas aquí")"
}

case ${1:-install} in
  install) cmd_install ;;
  status) cmd_status ;;
  credentials) cmd_credentials ;;
  otp) cmd_otp ;;
  logs) require_install; shift; dc logs -f --tail=200 "$@" ;;
  backup) cmd_backup ;;
  restore) shift; cmd_restore "${1:-}" ;;
  restore-volumes) shift; cmd_restore_volumes "${1:-}" ;;
  update) cmd_update ;;
  update-apply) cmd_update_apply ;;
  images) shift; cmd_images "${1:-}" ;;
  platform-role) shift; cmd_platform_role "$@" ;;
  demo-users) shift; cmd_demo_users "$@" ;;
  realms) cmd_realms ;;
  stop) require_install; dc stop ;;
  start)
    require_install; ensure_env_additions; check_example_secrets
    dc up -d --wait --wait-timeout 900
    apply_pending_realms
    ;;
  -h | --help | help) sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//' ;;
  *) fail "Comando desconocido: $1 (ver ./install.sh help)" ;;
esac
