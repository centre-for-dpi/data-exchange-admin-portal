#!/bin/bash
# Runs as the command of the step-ca image, after its entrypoint has initialised the CA on the
# first start (DOCKER_STEPCA_INIT_*). On every start it sets the portal's JWK provisioners the way
# ARCHITECTURE.md §4.4 describes, then starts the CA. Idempotent: it rewrites the same values.
#   - rid-portal, application certificates (M3-01), template app.tpl: subject = CN only (the
#     token's subject, rid-app-<uuid>), key usage for TLS client authentication only; 90 days by
#     default, the portal asks for lifecycle.certificateValidityDays (capped at 397 days);
#   - rid-gateway-tls, the gateway's TLS server certificate (M3-02), template gateway.tpl: the
#     gateway host names, server authentication only, 90 days. Development creates it with the
#     CA's password; the portal renews the certificate before it expires;
#   - rid-nodes, certificates of kit nodes (M4-02), template node.tpl: CN=rid-node and the node's
#     own name rid-node-<uuid> as its only DNS name, both from the portal's token; server
#     authentication (the gateway calls the node) and client authentication (the node calls the
#     portal's control channel); 90 days, renewed by the node.
set -eo pipefail
STEPPATH="$(step path)"
CONFIG="${STEPPATH}/config/ca.json"
PROVISIONER="${DOCKER_STEPCA_INIT_PROVISIONER_NAME:-rid-portal}"
GATEWAY_PROVISIONER="rid-gateway-tls"
NODE_PROVISIONER="rid-nodes"

step ca provisioner update "${PROVISIONER}" \
  --ca-config="${CONFIG}" \
  --x509-template=/rid/app.tpl \
  --x509-min-dur=5m \
  --x509-default-dur=2160h \
  --x509-max-dur=9528h >/dev/null

if ! grep -q "\"name\": \"${GATEWAY_PROVISIONER}\"" "${CONFIG}"; then
  step ca provisioner add "${GATEWAY_PROVISIONER}" --type JWK --create \
    --password-file "${STEPPATH}/secrets/password" --ca-config="${CONFIG}" >/dev/null
fi
step ca provisioner update "${GATEWAY_PROVISIONER}" \
  --ca-config="${CONFIG}" \
  --x509-template=/rid/gateway.tpl \
  --x509-min-dur=5m \
  --x509-default-dur=2160h \
  --x509-max-dur=2160h >/dev/null

if ! grep -q "\"name\": \"${NODE_PROVISIONER}\"" "${CONFIG}"; then
  step ca provisioner add "${NODE_PROVISIONER}" --type JWK --create     --password-file "${STEPPATH}/secrets/password" --ca-config="${CONFIG}" >/dev/null
fi
step ca provisioner update "${NODE_PROVISIONER}"   --ca-config="${CONFIG}"   --x509-template=/rid/node.tpl   --x509-min-dur=5m   --x509-default-dur=2160h   --x509-max-dur=2160h >/dev/null

exec /usr/local/bin/step-ca --password-file "${STEPPATH}/secrets/password" "${CONFIG}"
