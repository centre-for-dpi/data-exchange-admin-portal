#!/bin/sh
# Authentication of etcd (B-15, ADR-0031). Idempotent: Compose runs it before APISIX on every start.
#
# First run (authentication off, an etcd created by an earlier version included): creates
#   - `apisix`, whose role reads and writes only APISIX's prefix (APISIX_ETCD_PASSWORD);
#   - `healthcheck`, with no role and the public password `healthcheck`: the container's health
#     check logs in with it, since an anonymous call fails once authentication is on, and
#     `endpoint health` takes "permission denied" as healthy. It can read or write nothing;
#   - `root` (ETCD_ROOT_PASSWORD), for this script and the operator;
# then turns authentication on. The data in etcd stays as it is.
# Later runs (authentication on): as root, the same users and role exist, and APISIX's password is
# the one in .env (it is changed only when APISIX can no longer log in with it).
set -eu
: "${ETCD_ROOT_PASSWORD:?set ETCD_ROOT_PASSWORD in .env}"
: "${APISIX_ETCD_PASSWORD:?set APISIX_ETCD_PASSWORD in .env}"
PREFIX=${APISIX_ETCD_PREFIX:-/apisix}

ctl() {
  etcdctl --endpoints="${ETCD_ENDPOINTS:-http://etcd:2379}" --dial-timeout=5s \
    --command-timeout=10s "$@"
}

if ctl auth status 2>/dev/null | grep -q 'Authentication Status: false'; then
  enabled=false
  as_root() { ctl "$@"; }
else
  enabled=true
  as_root() { ctl --user="root:$ETCD_ROOT_PASSWORD" "$@"; }
  if ! as_root user get root >/dev/null 2>&1; then
    echo "etcd-init: cannot log in as root: etcd does not answer, or its authentication is on" \
      "and ETCD_ROOT_PASSWORD is not root's password (OPERATIONS.md, etcd credentials)" >&2
    exit 1
  fi
fi

user_exists() { as_root user get "$1" >/dev/null 2>&1; }
has_role() { as_root user get "$1" 2>/dev/null | grep -q "^Roles:.* $2\( \|$\)"; }

as_root role get apisix >/dev/null 2>&1 || as_root role add apisix >/dev/null
# Granting again what is granted changes nothing.
as_root role grant-permission apisix --prefix=true readwrite "$PREFIX" >/dev/null

user_exists apisix || as_root user add apisix --new-user-password="$APISIX_ETCD_PASSWORD" >/dev/null
has_role apisix apisix || as_root user grant-role apisix apisix >/dev/null
user_exists healthcheck || as_root user add healthcheck --new-user-password=healthcheck >/dev/null
user_exists root || as_root user add root --new-user-password="$ETCD_ROOT_PASSWORD" >/dev/null
has_role root root || as_root user grant-role root root >/dev/null

if [ "$enabled" = false ]; then
  as_root auth enable >/dev/null
  echo "etcd-init: authentication enabled"
elif ! ctl --user="apisix:$APISIX_ETCD_PASSWORD" get "$PREFIX" --prefix --keys-only --limit=1 \
  >/dev/null 2>&1; then
  printf '%s\n' "$APISIX_ETCD_PASSWORD" | as_root user passwd apisix --interactive=false >/dev/null
  echo "etcd-init: APISIX's password changed to the one in .env"
fi
echo "etcd-init: ready (APISIX reads and writes $PREFIX only)"
