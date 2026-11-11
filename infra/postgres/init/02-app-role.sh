#!/bin/sh
# Two database roles (CLAUDE.md, ARCHITECTURE.md §7):
#   - $POSTGRES_USER ("rid"): owns the schema and runs migrations.
#   - rid_app: used by the running API; no DDL. Gets DML on everything the owner creates, except
#     UPDATE/DELETE on audit_event, which the migration revokes (append-only audit log).
# Also creates rid_test for integration tests with the same privileges.
# Runs once, on first start with an empty data volume.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$RID_APP_DB_PASSWORD" <<'EOSQL'
CREATE ROLE rid_app LOGIN PASSWORD :'app_password';
CREATE DATABASE rid_test OWNER :"USER";
EOSQL

for db in "$POSTGRES_DB" rid_test; do
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$db" <<'EOSQL'
GRANT CONNECT ON DATABASE :"DBNAME" TO rid_app;
GRANT USAGE ON SCHEMA public TO rid_app;
-- Objects the owner creates from now on (any schema, including pg-boss's) are usable by rid_app.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT USAGE ON SCHEMAS TO rid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT USAGE, SELECT ON SEQUENCES TO rid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT EXECUTE ON FUNCTIONS TO rid_app;
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT USAGE ON TYPES TO rid_app;
EOSQL
done
