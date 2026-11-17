#!/bin/sh
# Two database roles (CLAUDE.md, ARCHITECTURE.md §7):
#   - $POSTGRES_USER ("den"): owns the schema and runs migrations.
#   - den_app: used by the running API; no DDL. Gets DML on everything the owner creates, except
#     UPDATE/DELETE on audit_event, which the migration revokes (append-only audit log).
# Also creates den_test for integration tests with the same privileges.
# Runs once, on first start with an empty data volume.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$DEN_APP_DB_PASSWORD" <<'EOSQL'
CREATE ROLE den_app LOGIN PASSWORD :'app_password';
CREATE DATABASE den_test OWNER :"USER";
EOSQL

for db in "$POSTGRES_DB" den_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'EOSQL'
GRANT CONNECT ON DATABASE :"DBNAME" TO den_app;
GRANT USAGE ON SCHEMA public TO den_app;
-- Objects the owner creates from now on (any schema, including pg-boss's) are usable by den_app.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT USAGE ON SCHEMAS TO den_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO den_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT USAGE, SELECT ON SEQUENCES TO den_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT EXECUTE ON FUNCTIONS TO den_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT USAGE ON TYPES TO den_app;
EOSQL
done
