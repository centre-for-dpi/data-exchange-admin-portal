# PostgreSQL with pgBackRest (MIT) for Compose: development and the single-host pilot (M6-06,
# ADR-0026). The pilot archives every WAL segment to an encrypted pgBackRest repository and the
# `pgbackrest` service takes the scheduled backups (docker-compose.deploy.yml); development runs
# it without archiving. Kubernetes uses CloudNativePG with Barman Cloud instead.
FROM postgres:18.6-alpine
RUN apk add --no-cache 'pgbackrest~2.58' \
 && mkdir -p /var/lib/pgbackrest /var/log/pgbackrest /tmp/pgbackrest \
 && chown postgres:postgres /var/lib/pgbackrest /var/log/pgbackrest /tmp/pgbackrest \
 && chmod 750 /var/lib/pgbackrest
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY backup-scheduler.sh /usr/local/bin/den-backup-scheduler
RUN chmod 755 /usr/local/bin/den-backup-scheduler
