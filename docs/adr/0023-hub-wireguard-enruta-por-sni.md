# ADR-0023 — El hub WireGuard enruta hacia los nodos por SNI

- Estado: Aceptado
- Fecha: 2026-11-15

## Contexto
Los nodos del kit corren en la red de cada entidad, detrás de su firewall, con salida a internet y sin puertos abiertos. Por eso cada nodo abre un túnel WireGuard hacia un hub de la plataforma (M4-03), y el gateway los llama por ese túnel (M4-04). `ARCHITECTURE.md §4.1` preveía que el upstream de APISIX apuntara a la dirección del nodo dentro del túnel (`<tunnelIp>:<port>`).

Para eso, APISIX tendría que tener una ruta IP hacia la subred del túnel a través del hub. Hay dos formas de dársela:
- capacidades de red (`NET_ADMIN`) en el contenedor o pod de APISIX, con una ruta estática;
- correr WireGuard dentro del espacio de red de APISIX.

En ambos casos, el hub debe reenviar paquetes entre la red de la plataforma y la de los nodos (`ip_forward`, NAT, reglas para que un nodo no llegue a otro ni a la plataforma). En Kubernetes (M6) eso exige rutas por nodo del clúster o `hostNetwork`.

El gateway ya habla TLS con los nodos, con su certificado de cliente por entidad (M3-03). Verifica el del nodo contra la CA de la red y para el nombre `rid-node-<nodeId>` (M4-02), que va como SNI.

## Decisión
El hub es un **enrutador TLS por SNI**, no un router IP. Es un contenedor propio (`wg-hub`) con:
- la interfaz WireGuard (`wg0`), en la primera dirección de `RID_WG_SUBNET`;
- un nginx `stream` con `ssl_preread`, que escucha en el 8443 de la red de la plataforma y envía cada conexión TLS al nodo cuyo nombre trae el SNI (`rid-node-<id>` → `<dirección del túnel>:<puerto de servicio>`). Un nombre desconocido no va a ningún lado;
- un agente HTTP interno (`hub-agent.mjs`, puerto 8090, token propio). El reconciliador del portal le entrega el estado deseado completo (peers y nombres) y le lee el estado real.

El upstream de una versión en un nodo apunta al hub (`wg-hub:8443`), con el nombre del nodo como SNI, `Host` y nombre verificado. El TLS sigue siendo de punta a punta entre el gateway y el nodo: el hub no ve el contenido ni tiene claves de TLS.

El hub **no reenvía paquetes**: `ip_forward` queda en 0 y el firewall del hub descarta todo lo nuevo que llega por `wg0`. Un nodo solo puede responder conexiones que abrió el hub. No llega a otros nodos, al hub ni a la plataforma.

## Alternativas consideradas
- **Ruta IP desde APISIX hacia el túnel** (lo que decía `ARCHITECTURE.md §4.1`). Da privilegios de red al gateway y convierte al hub en router, con NAT y reglas de aislamiento entre nodos. Además se rompe en silencio si APISIX se reinicia y pierde la ruta. En Kubernetes es frágil.
- **WireGuard dentro del espacio de red de APISIX** (sidecar). APISIX y el hub quedan atados: reiniciar uno deja al otro sin red, y cada réplica del gateway sería un extremo de túnel con su propia clave.
- **Un puerto del hub por nodo.** Necesita abrir y cerrar puertos al enrolar y dar de baja nodos, y no escala.
- **HAProxy** en lugar de nginx `stream`. Hace lo mismo, pero nginx ya está en la plataforma y su licencia (BSD-2) es más simple que la GPL de HAProxy, aunque esta también se permitiría en un contenedor propio.

## Consecuencias
- APISIX no necesita privilegios de red, y el hub se despliega como un servicio más. En Kubernetes es un Deployment con su Service, y APISIX lo alcanza por DNS.
- El backlog decía "la ruta apunta a la IP del túnel del nodo" (M4-04). Ahora la ruta apunta al hub con el nombre del nodo, y el hub resuelve la dirección del túnel. Se anota la interpretación en la historia.
- El hub ve, por cada conexión, qué nodo se llamó y cuándo, nunca el contenido. Sus logs de nginx no registran nada más.
- Cada nodo expone un solo puerto TLS en su dirección del túnel (`servicePort`, 8443 por defecto) y sus servicios por ruta (`servicePath`).
- Los componentes del hub con licencia GPL (wireguard-tools, iptables) corren en su contenedor y no se enlazan con nuestro código (regla 1 de `CLAUDE.md`). El agente es un script de Node sin dependencias, que llama a esas herramientas por línea de comandos.
- Con varias réplicas del gateway hay un solo hub. Un hub por zona, con nodos conectados a ambos, queda para M6.
