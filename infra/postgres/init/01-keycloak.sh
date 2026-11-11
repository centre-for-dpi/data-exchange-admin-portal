#!/bin/sh
# Creates Keycloak's own database and role inside the dev PostgreSQL instance.
# Runs once, on first start with an empty data volume.
set -eu

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v kc_user="$KEYCLOAK_DB_USER" -v kc_password="$KEYCLOAK_DB_PASSWORD" <<'EOSQL'
CREATE ROLE :"kc_user" LOGIN PASSWORD :'kc_password';
CREATE DATABASE keycloak OWNER :"kc_user";
EOSQL
