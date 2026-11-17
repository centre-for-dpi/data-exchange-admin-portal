#!/usr/bin/env bash
# Checks and helpers for the server of a participating entity (docs/guides/entities.md): network
# reachability of the RID platform, the key and CSR of an application, and a first call through
# the gateway with mTLS and a certificate-bound token. Needs bash, curl and openssl; nothing else.
# It is not the instant-APIs kit (ADR-0011): it only exercises the platform's public contract.
#
#   ./entity-check.sh check <portal-host> <gateway-host>
#   ./entity-check.sh csr <client_id>
#   ./entity-check.sh call <portal-host> <gateway-host> <client_id> <path> <purpose> [end-user]
#
# The application's secret is read from CLIENT_SECRET, or asked without echo; never an argument.
# Messages are in Spanish, the portal's default language.
set -euo pipefail

if [[ -t 1 ]]; then G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else G=''; Y=''; R=''; C=''; N=''; fi
ok() { printf '%s\n' "${G}✔${N} $*"; }
warn() { printf '%s\n' "${Y}⚠${N} $*"; }
info() { printf '%s\n' "${C}›${N} $*"; }
fail() { printf '%s\n' "${R}✘ $*${N}" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "Falta '$1'. Instálalo y vuelve a ejecutar."; }
need curl
need openssl

# One line of a curl config (`key = "value"`), with \ and " escaped as that syntax requires.
curl_quote() {
  local key=${1%% = *} value=${1#* = }
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  printf '%s = "%s"\n' "$key" "$value"
}

network_ca() { # portal → ./rid-network-ca.pem
  [[ -s rid-network-ca.pem ]] && return 0
  curl -fsS --max-time 15 -o rid-network-ca.pem "https://$1/api/v1/pki/ca" ||
    fail "No pude descargar la raíz de la red desde https://$1/api/v1/pki/ca"
}

cmd_check() {
  local portal=${1:?portal-host} gateway=${2:?gateway-host} name ips out
  for name in "$portal" "$gateway"; do
    ips=$(getent ahostsv4 "$name" 2>/dev/null | awk '{print $1}' | sort -u | xargs || true)
    [[ -n $ips ]] && ok "DNS: $name → $ips" || fail "DNS: $name no resuelve desde este servidor"
  done

  if curl -fsS --max-time 15 -o /dev/null "https://$portal/api/v1/health"; then
    ok "Salida HTTPS al portal (https://$portal)"
  else
    fail "No llego a https://$portal/api/v1/health: revisa la salida a 443/tcp y el proxy de la entidad"
  fi

  network_ca "$portal"
  ok "Raíz de la red guardada en ./rid-network-ca.pem ($(openssl x509 -in rid-network-ca.pem -noout -subject))"

  # The gateway asks for a client certificate: without one the handshake ends, but its server
  # certificate must verify against the network root.
  out=$(openssl s_client -connect "$gateway:443" -servername "$gateway" -CAfile rid-network-ca.pem \
    -verify_return_error </dev/null 2>&1 || true)
  if grep -q 'Verify return code: 0 (ok)' <<<"$out" || grep -q 'Verification: OK' <<<"$out"; then
    ok "Salida al gateway ($gateway:443) y certificado del gateway válido para la red"
  elif grep -qiE 'connect:|Connection refused|timed out|no peer certificate' <<<"$out"; then
    fail "No llego al gateway en $gateway:443: revisa la salida a 443/tcp"
  else
    warn "El gateway respondió, pero su certificado no verificó contra la raíz de la red:"
    grep -E 'verify error|Verify return code' <<<"$out" | head -n 3 >&2
  fi

  info "UDP 51820 (túnel de los nodos del kit) no se puede probar desde aquí sin un nodo:"
  info "  pide a tu equipo de red que permita la salida UDP a $gateway:51820 si usarán el kit."
}

cmd_csr() {
  local id=${1:?client_id}
  [[ $id =~ ^[A-Za-z0-9._-]+$ ]] || fail "client_id inválido: $id"
  [[ -e $id.key ]] && fail "$id.key ya existe: no la sobrescribo."
  (umask 077 && openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout "$id.key" -out "$id.csr" -subj "/CN=$id" 2>/dev/null)
  ok "Llave privada: $id.key (permisos 600; NUNCA sale de este servidor)"
  ok "Solicitud de certificado: $id.csr"
  info "Pega el contenido de $id.csr en la ficha de la aplicación → Certificado de cliente (mTLS),"
  info "y guarda el certificado descargado como $id.crt junto a la llave."
}

cmd_call() {
  local portal=${1:?portal-host} gateway=${2:?gateway-host} id=${3:?client_id} path=${4:?path} purpose=${5:?purpose}
  local end_user=${6-} secret=${CLIENT_SECRET-} token code body
  [[ -r $id.crt && -r $id.key ]] || fail "Faltan $id.crt y $id.key en este directorio."
  network_ca "$portal"
  if [[ -z $secret ]]; then read -r -s -p "Secreto de la aplicación $id: " secret; echo; fi
  local tls=(--cert "$id.crt" --key "$id.key" --cacert rid-network-ca.pem)

  # Secret and token go to curl in a config on stdin (-K -): never in argv, where ps shows them.
  body=$(curl_quote "user = $id:$secret" | curl -sS -K - --max-time 20 "${tls[@]}" -d grant_type=client_credentials \
    "https://$gateway/oauth/token") || fail "No se pudo pedir el token a https://$gateway/oauth/token"
  token=$(sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p' <<<"$body")
  [[ -n $token ]] || fail "El gateway no dio token: $body"
  ok "Token obtenido (5 min, ligado al certificado de $id)"

  local headers=(-H "X-RID-Purpose: $purpose")
  [[ -n $end_user ]] && headers+=(-H "X-RID-End-User: $end_user")
  body=$(curl_quote "header = Authorization: Bearer $token" |
    curl -sS -K - --max-time 30 "${tls[@]}" "${headers[@]}" -w '\n%{http_code}' "https://$gateway/${path#/}")
  code=${body##*$'\n'}
  body=${body%$'\n'*}
  case $code in
    2??) ok "HTTP $code: la llamada pasó por el gateway hasta el proveedor" ;;
    401) warn "HTTP 401: token inválido o vencido" ;;
    403) warn "HTTP 403: el gateway negó la llamada. Razón: $(sed -n 's/.*"code" *: *"\([^"]*\)".*/\1/p' <<<"$body")" ;;
    404) warn "HTTP 404: no hay ruta publicada en $path (revisa la URL en la ficha de la API)" ;;
    429) warn "HTTP 429: límite de la suscripción alcanzado" ;;
    *) warn "HTTP $code" ;;
  esac
  info "Respuesta (no se guarda en ningún lado):"
  printf '%s\n' "$body" | head -c 2000; echo
}

case ${1-} in
  check) shift; cmd_check "$@" ;;
  csr) shift; cmd_csr "$@" ;;
  call) shift; cmd_call "$@" ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
