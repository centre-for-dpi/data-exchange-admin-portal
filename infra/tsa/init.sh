#!/bin/sh
# Development TSA (ADR-0016): creates, once, the certificate chain of the RFC 3161 time-stamping
# authority in the tsa-data volume. Root and leaf are ECDSA P-256; the leaf carries the
# time-stamping extended key usage, critical, as RFC 3161 requires. Never used in production,
# where the country's accredited TSA signs.
set -eu
cd /tsa
if [ -f chain.pem ] && [ -f tsa.key ]; then
  echo "TSA chain already present"
  exit 0
fi
step certificate create "DEN Dev TSA Root" root.crt root.key \
  --profile root-ca --kty EC --crv P-256 --no-password --insecure --not-after 87600h -f
step certificate create "DEN Dev TSA" tsa.crt tsa.key \
  --template /init/leaf.tpl --ca root.crt --ca-key root.key \
  --kty EC --crv P-256 --no-password --insecure --not-after 43800h -f
cat tsa.crt root.crt > chain.pem
rm root.key
# The timestamp server runs as a non-root user (65532) and must read its key. Development only.
chmod 0644 tsa.key chain.pem root.crt tsa.crt
echo "TSA chain created"
