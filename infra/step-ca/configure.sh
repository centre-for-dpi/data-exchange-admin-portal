#!/bin/bash
# Runs as the command of the step-ca image, after its entrypoint has initialised the CA on the
# first start (DOCKER_STEPCA_INIT_*). On every start it sets the portal's JWK provisioner the way
# ARCHITECTURE.md §4.4 describes, then starts the CA. Idempotent: it rewrites the same values.
#   - template app.tpl: subject = CN only (the token's subject, rid-app-<uuid>), key usage for TLS
#     client authentication only;
#   - durations: 90 days by default; the portal asks for lifecycle.certificateValidityDays, which
#     the country configuration caps at 397 days.
set -eo pipefail
STEPPATH="$(step path)"
CONFIG="${STEPPATH}/config/ca.json"
PROVISIONER="${DOCKER_STEPCA_INIT_PROVISIONER_NAME:-rid-portal}"

step ca provisioner update "${PROVISIONER}" \
  --ca-config="${CONFIG}" \
  --x509-template=/rid/app.tpl \
  --x509-min-dur=5m \
  --x509-default-dur=2160h \
  --x509-max-dur=9528h >/dev/null

exec /usr/local/bin/step-ca --password-file "${STEPPATH}/secrets/password" "${CONFIG}"
