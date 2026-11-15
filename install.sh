#!/usr/bin/env bash
# Interactive installer of the RID portal + gateway on one Linux server (pilot topology,
# docs/INSTALL.md). Production is the Helm charts of M6-05, not this script.
#
#   sudo ./install.sh              # asks step by step, writes .env, builds and starts everything
#   sudo ./install.sh status       # containers and health checks
#   sudo ./install.sh credentials  # where to log in and with what (demo users, Keycloak admin)
#   sudo ./install.sh otp          # one-time code of the demo users with a critical role
#   sudo ./install.sh logs [svc]   # follow the logs (all services, or one)
#   sudo ./install.sh backup       # databases, CA, TSA, documents and .env into backups/
#   sudo ./install.sh update       # backup, git pull --ff-only, rebuild and restart
#   sudo ./install.sh stop|start   # stop or start every container (data is kept)
#
# Re-running the install keeps the existing .env: secrets of a running deployment never change
# under it (database passwords, signing key, subject key; DEPLOYMENT.md §4.1).
# Messages are in Spanish, the portal's default language.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
ENV_FILE="$ROOT/.env"
NODE_IMAGE="node:24.22.1-alpine3.24"
EDGE_NETWORK="rid-edge"
MIN_COMPOSE="2.26.0"

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
env_set() {
  local key=$1 value=$2
  if grep -qE "^$key=" "$ENV_FILE"; then
    local tmp; tmp=$(mktemp)
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$ENV_FILE" >"$tmp"
    cat "$tmp" >"$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

# --- compose ------------------------------------------------------------------------------------
compose_args() {
  COMPOSE=(docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml)
  [[ $(env_get RID_INSTALL_PROXY) == bundled ]] && COMPOSE+=(-f infra/compose/docker-compose.edge.yml)
  COMPOSE+=(--env-file "$ENV_FILE")
  [[ $(env_get RID_INSTALL_OBSERVABILITY) == true ]] && COMPOSE+=(--profile observability)
  return 0
}
dc() { compose_args; "${COMPOSE[@]}" "$@"; }
require_install() { [[ -f $ENV_FILE ]] || fail "No hay instalación en $ROOT (falta .env). Ejecuta: sudo ./install.sh"; }

# --- checks -------------------------------------------------------------------------------------
version_ge() { [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1) == "$2" ]]; }

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

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker no está instalado."
    if yes_no "¿Instalo Docker Engine con el script oficial (get.docker.com)?" s; then
      curl -fsSL https://get.docker.com | sh
      systemctl enable --now docker >/dev/null 2>&1 || true
    else
      fail "Instala Docker Engine con Compose ≥ $MIN_COMPOSE y vuelve a ejecutar."
    fi
  fi
  docker info >/dev/null 2>&1 || fail "Docker no responde (¿está iniciado? systemctl start docker)"
  local cv
  cv=$(docker compose version --short 2>/dev/null | sed 's/^v//') || true
  [[ -n $cv ]] || fail "Falta el plugin Docker Compose v2 (paquete docker-compose-plugin)."
  version_ge "$cv" "$MIN_COMPOSE" || fail "Docker Compose $cv; se necesita ≥ $MIN_COMPOSE."
  ok "Docker $(docker version --format '{{.Server.Version}}'), Compose $cv"

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
  unreadable=$(find infra config -type f ! -perm -o+r 2>/dev/null | head -n 1 || true)
  if [[ -n $unreadable ]]; then
    warn "Hay archivos del repositorio sin permiso de lectura para otros (p. ej. $unreadable)."
    chmod -R o+rX infra config scripts && ok "Permisos de lectura corregidos en infra/, config/ y scripts/"
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
    if docker ps --format '{{.Names}}' | grep -qE '^rid-(edge|wg-hub)-1$'; then
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
    ask PORTAL_HOST "Nombre del portal (p. ej. rid.entidad.gov.xx)"
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
      ask ACME_EMAIL "Correo de contacto para Let's Encrypt (opcional)" ""
    fi
  fi
  info "El certificado del gateway ($GATEWAY_HOST) no se pide aquí: lo emite la CA de la red (step-ca)."

  step "Paso 5 · Analítica de uso (OpenSearch)"
  info "Guarda los metadatos de cada llamada para los indicadores (M5). Suma ~1 GB de RAM."
  local def=n
  ((MEM_GB >= 15)) && def=s
  if yes_no "¿Activar la analítica?" "$def"; then OBSERVABILITY=true; else OBSERVABILITY=false; fi

  step "Paso 6 · Usuarios de demostración"
  info "El piloto carga entidades ficticias y usuarios de demo (operador, regulador, publicador…)."
  info "Es la única forma, por ahora, de tener el primer administrador de plataforma (docs/INSTALL.md §6)."
  ask_secret DEMO_PASSWORD "Contraseña común de los usuarios de demo (Enter = una aleatoria)"

  step "Resumen"
  printf '  %-28s %s\n' "País:" "$COUNTRY" \
    "Portal:" "https://$PORTAL_HOST" \
    "Gateway (mTLS):" "https://$GATEWAY_HOST" \
    "Proxy:" "$([[ $PROXY == bundled ]] && echo "incluido (Traefik en 80/443)" || echo "existente (red $EDGE_NET)")" \
    "Certificado del portal:" "$(case $TLS in letsencrypt) echo "Let's Encrypt";; files) echo "propio ($CERT_FILE)";; *) echo "lo gestiona tu proxy";; esac)" \
    "Analítica:" "$([[ $OBSERVABILITY == true ]] && echo sí || echo no)" \
    "Contraseña de demo:" "$([[ -n $DEMO_PASSWORD ]] && echo "la indicada" || echo "aleatoria")"
  yes_no "¿Continuar con la instalación?" s || fail "Instalación cancelada; no se cambió nada."
}

# --- install ------------------------------------------------------------------------------------
write_env() {
  step "Paso 7 · Secretos y configuración (.env)"
  local args=("https://$PORTAL_HOST" --gateway-host "$GATEWAY_HOST" --traefik-network "$EDGE_NET" --country "$COUNTRY")
  [[ -n $DEMO_PASSWORD ]] && args+=(--demo-password "$DEMO_PASSWORD")
  docker run --rm -v "$ROOT:/w" -w /w "$NODE_IMAGE" node scripts/make-deploy-env.mjs "${args[@]}"
  cat >>"$ENV_FILE" <<EOF

# Installer (install.sh, docs/INSTALL.md)
RID_PORTAL_HOST=$PORTAL_HOST
RID_GATEWAY_HOST=$GATEWAY_HOST
RID_INSTALL_PROXY=$PROXY
RID_INSTALL_TLS=$TLS
RID_ACME_EMAIL=${ACME_EMAIL-}
RID_INSTALL_OBSERVABILITY=$OBSERVABILITY
EOF
  chmod 600 "$ENV_FILE"
  ok ".env escrito (permisos 600). Contiene todas las llaves de la instalación."
  warn "Guarda una copia cifrada de .env FUERA de este servidor: sin ella no se pueden recuperar los datos."
}

load_env_settings() {
  PORTAL_HOST=$(env_get RID_PORTAL_HOST)
  GATEWAY_HOST=$(env_get RID_GATEWAY_HOST)
  PROXY=$(env_get RID_INSTALL_PROXY)
  TLS=$(env_get RID_INSTALL_TLS)
  OBSERVABILITY=$(env_get RID_INSTALL_OBSERVABILITY)
  EDGE_NET=$(env_get TRAEFIK_NETWORK)
  [[ -n $PORTAL_HOST && -n $PROXY ]] ||
    fail ".env existe pero no lo escribió este instalador (faltan RID_PORTAL_HOST / RID_INSTALL_PROXY). Ver docs/INSTALL.md §7."
}

write_edge() {
  [[ $PROXY == bundled ]] || return 0
  mkdir -p infra/edge/dynamic infra/edge/certs
  local tls='{ certResolver: le }'
  if [[ $TLS == files ]]; then
    tls='{}'
    if [[ -n ${CERT_FILE-} ]]; then
      install -m 600 "$CERT_FILE" infra/edge/certs/portal.crt
      install -m 600 "$KEY_FILE" infra/edge/certs/portal.key
    fi
    [[ -f infra/edge/certs/portal.crt ]] || fail "Falta infra/edge/certs/portal.crt (certificado propio)."
    cat >infra/edge/dynamic/certs.yml <<'EOF'
# Written by install.sh: the portal's own certificate (RID_INSTALL_TLS=files).
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
  sed -e "s/@PORTAL_HOST@/$PORTAL_HOST/g" -e "s/@GATEWAY_HOST@/$GATEWAY_HOST/g" -e "s/@TLS@/$tls/g" \
    infra/edge/rid.yml.template >infra/edge/dynamic/rid.yml
  ok "Rutas del proxy en infra/edge/dynamic/rid.yml"
}

prepare_host() {
  step "Paso 8 · Preparación del servidor"
  docker network inspect "$EDGE_NET" >/dev/null 2>&1 || {
    docker network create "$EDGE_NET" >/dev/null && ok "Red de Docker $EDGE_NET creada"
  }
  if [[ $OBSERVABILITY == true ]]; then
    if (($(sysctl -n vm.max_map_count) < 262144)); then
      echo 'vm.max_map_count=262144' >/etc/sysctl.d/99-rid-opensearch.conf
      sysctl --system >/dev/null
      ok "vm.max_map_count=262144 (OpenSearch), persistente en /etc/sysctl.d/99-rid-opensearch.conf"
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
  info "Se compilan el portal, el API y los servicios auxiliares; después arranca todo en orden."
  if ! dc up -d --build --wait --wait-timeout 1800; then
    dc ps || true
    fail "Algún servicio no quedó sano. Revisa: sudo ./install.sh logs <servicio> (docs/INSTALL.md §8)."
  fi
  ok "Todos los servicios están arriba"
}

curl_portal() { # path → HTTP code, through this server's proxy
  if [[ $PROXY == bundled ]]; then
    curl -sk -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$PORTAL_HOST:443:127.0.0.1" "https://$PORTAL_HOST$1" || true
  else
    curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://$PORTAL_HOST$1" || true
  fi
}

verify() {
  step "Paso 10 · Comprobaciones"
  local code i
  code=$(curl_portal /api/v1/health)
  [[ $code == 200 ]] && ok "API del portal responde (/api/v1/health)" || warn "/api/v1/health respondió $code"
  code=$(curl_portal /api/v1/opa/bundle.tar.gz)
  [[ $code != 200 ]] && ok "El bundle de OPA no está expuesto al público ($code)" ||
    warn "¡/api/v1/opa responde 200 desde afuera! Revisa las rutas del proxy."
  code=$(curl_portal /auth/realms/rid-portal/.well-known/openid-configuration)
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
    "Consola de Keycloak:" "https://$PORTAL_HOST/auth/admin/" \
    "Correo de pruebas:" "https://$PORTAL_HOST/mail" \
    "Carpeta ciudadana demo:" "https://$PORTAL_HOST/carpeta"
  echo
  info "Usuarios y contraseñas:   sudo ./install.sh credentials"
  info "Código de segundo factor: sudo ./install.sh otp"
  info "Estado:                   sudo ./install.sh status"
  info "Siguiente paso: docs/INSTALL.md §5 (verificación de punta a punta) y docs/guias/operador.md"
}

cmd_install() {
  printf '%s\n' "${B}Instalador del Portal RID — portal + gateway en un servidor (piloto)${N}"
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
  write_edge
  prepare_host
  start_stack
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
    "Usuarios de demo (contraseña):" "$(env_get RID_DEMO_USER_PASSWORD)" \
    "  operador / revisor:" "ana.operadora (segundo factor)" \
    "  administrador de plataforma:" "pablo.plataforma (segundo factor)" \
    "  regulador:" "marta.regulador (segundo factor)" \
    "  auditoría:" "sofia.auditora (segundo factor)" \
    "  publicador (entidad de salud):" "pedro.publicador" \
    "  responsable de datos (salud):" "lucia.datos (segundo factor)" \
    "  administradora de entidad:" "elena.admin" \
    "  desarrollador (consumidor):" "carlos.dev" \
    "  ciudadana (carpeta):" "ciudadana.demo" \
    "Keycloak (realm master):" "$(env_get KEYCLOAK_ADMIN_USER) / $(env_get KEYCLOAK_ADMIN_PASSWORD)" \
    "Correo de pruebas (/mail):" "$(env_get MAILPIT_UI_AUTH | sed 's/:/ \/ /')"
  info "Código de segundo factor de los usuarios de demo: sudo ./install.sh otp"
}

cmd_otp() {
  require_install
  docker run --rm -v "$ROOT:/w:ro" -w /w "$NODE_IMAGE" node scripts/totp.mjs
}

cmd_backup() {
  require_install
  local dir="$ROOT/backups/$(date +%Y%m%d-%H%M%S)" user db
  mkdir -p "$dir"; chmod 700 "$ROOT/backups" "$dir"
  user=$(env_get POSTGRES_USER); user=${user:-rid}
  db=$(env_get POSTGRES_DB); db=${db:-rid}
  info "Respaldando en $dir"
  dc exec -T postgres pg_dump -U "$user" -Fc "$db" >"$dir/rid.dump"
  dc exec -T postgres pg_dump -U "$user" -Fc keycloak >"$dir/keycloak.dump"
  for v in step-ca-data tsa-data api-documents carpeta-data; do
    docker volume inspect "rid_$v" >/dev/null 2>&1 &&
      docker run --rm -v "rid_$v:/v:ro" -v "$dir:/b" "$NODE_IMAGE" tar czf "/b/$v.tgz" -C /v .
  done
  cp "$ENV_FILE" "$dir/env"
  chmod 600 "$dir"/*
  ok "Respaldo completo: $(du -sh "$dir" | cut -f1). Cópialo fuera del servidor."
}

cmd_update() {
  require_install; load_env_settings
  cmd_backup
  git pull --ff-only
  write_edge
  dc up -d --build --wait --wait-timeout 1800
  ok "Actualizado a $(git log -1 --format='%h %s')"
  warn "Revisa en DEPLOYMENT.md §5.4 si la versión pide pasos manuales (realms, variables nuevas)."
}

case ${1:-install} in
  install) cmd_install ;;
  status) cmd_status ;;
  credentials) cmd_credentials ;;
  otp) cmd_otp ;;
  logs) require_install; shift; dc logs -f --tail=200 "$@" ;;
  backup) cmd_backup ;;
  update) cmd_update ;;
  stop) require_install; dc stop ;;
  start) require_install; dc up -d --wait --wait-timeout 900 ;;
  -h | --help | help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) fail "Comando desconocido: $1 (ver ./install.sh help)" ;;
esac
