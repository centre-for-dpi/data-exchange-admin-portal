#!/bin/sh
# Scheduled backups of the Compose PostgreSQL with pgBackRest (M6-06, ADR-0026). Runs in the
# `pgbackrest` service, which shares the database's data, socket and repository volumes.
#
#   rid-backup-scheduler          # prepare, then a backup a day at RID_BACKUP_HOUR (UTC): a full
#                                 # one on RID_BACKUP_FULL_DAY (0 = Sunday), differential otherwise
#   rid-backup-scheduler --once   # prepare and take a full backup now, then exit
#
# "Prepare" creates the stanza (idempotent), checks that WAL archiving reaches the repository and
# takes a first full backup when the repository has none. pgBackRest expires what falls outside
# the retention (pgbackrest.conf) after each backup.
set -eu

STANZA=rid
HOUR=${RID_BACKUP_HOUR:-2}
FULL_DAY=${RID_BACKUP_FULL_DAY:-0}

log() { echo "rid-backup-scheduler: $*"; }

backup() {
  log "starting $1 backup"
  pgbackrest --stanza="$STANZA" --type="$1" backup
}

until pgbackrest --stanza="$STANZA" stanza-create; do
  log "database not ready, retrying in 10 s"
  sleep 10
done
pgbackrest --stanza="$STANZA" check

if [ "${1:-}" = --once ]; then
  backup full
  exit 0
fi

if ! pgbackrest --stanza="$STANZA" --output=json info | grep -q '"type":"full"'; then
  backup full
fi

done_on=""
while true; do
  hour=$(date -u +%H)
  hour=${hour#0}
  today=$(date -u +%F)
  if [ "$hour" -eq "$HOUR" ] && [ "$done_on" != "$today" ]; then
    kind='diff'
    if [ "$(date -u +%w)" -eq "$FULL_DAY" ]; then kind='full'; fi
    if backup "$kind"; then
      done_on=$today
    else
      log "$kind backup failed, retrying in 10 min"
      sleep 600
      continue
    fi
  fi
  sleep 60
done
