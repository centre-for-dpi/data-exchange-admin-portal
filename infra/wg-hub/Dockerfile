# WireGuard hub of the kit nodes (M4-03, ADR-0023): the tunnel interface, an nginx stream that
# routes each TLS connection to its node by SNI, and the agent the portal's reconciler drives.
# GPL tools (wireguard-tools, iptables) run in this container only, never linked with our code.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
RUN apk add --no-cache wireguard-tools wireguard-go iptables iproute2 nginx nginx-mod-stream nodejs
COPY hub-agent.mjs /den/hub-agent.mjs
VOLUME /var/lib/wg-hub
EXPOSE 51820/udp 8443 8090
ENTRYPOINT ["node", "/den/hub-agent.mjs"]
