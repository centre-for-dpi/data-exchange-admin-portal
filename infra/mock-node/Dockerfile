# Simulated kit node (M4-03): a TEST FIXTURE, not the kit (ADR-0011). It enrolls with a token,
# brings up its WireGuard tunnel to the hub, serves a mock provider over mTLS on its tunnel
# address and sends heartbeats. No installer, no database connectors, no API generation.
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53
RUN apk add --no-cache wireguard-tools wireguard-go openssl iproute2
COPY mock-node.mjs /den/mock-node.mjs
VOLUME /var/lib/mock-node
CMD ["node", "/den/mock-node.mjs"]
