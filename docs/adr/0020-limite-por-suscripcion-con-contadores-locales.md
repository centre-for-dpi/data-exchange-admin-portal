# ADR-0020 — Límite por suscripción con contadores locales en cada nodo del gateway

- Estado: Aceptado
- Fecha: 2026-11-14

## Contexto
Cada suscripción tiene un límite de peticiones por minuto (`SPEC.md`, M3-05). La SPIKE S-2 mostró que `limit-count` de APISIX puede aplicarlo sin código propio: OPA pone el límite y la suscripción en cabeceras, y el plugin las usa como `count` y como clave.

Queda el almacenamiento del contador. Con la política `local`, cada nodo de APISIX cuenta por su lado, en su memoria compartida. Las políticas que comparten el contador entre nodos (`redis`, `redis-cluster`, `redis-sentinel`) requieren un servidor compatible con Redis. El stack excluye Redis (CLAUDE.md, ADR-0002: se usa pg-boss en su lugar) para no sumar otro servicio con estado que operar en cada país. Producción prevé al menos dos nodos del gateway (`ARCHITECTURE.md §11`).

## Decisión
- Contadores **locales** (`policy: local`) en cada nodo.
- El portal publica en el bundle de OPA el límite **dividido por el número de nodos del gateway** (redondeado hacia arriba), tomado de la configuración del despliegue (`gateway.nodes`, 1 por omisión). Así la suma de los nodos se acerca al límite de la suscripción.
- Si el balanceador de capa 4 frente al gateway puede repartir por hash del origen, se recomienda usarlo: las llamadas de una aplicación van entonces al mismo nodo, y el límite se acerca al exacto.

## Alternativas consideradas
- **Valkey (BSD-3) o Redis con `policy: redis-cluster`:** da un contador exacto en todo el clúster. Pero suma un servicio con estado, alta disponibilidad y respaldo propios en cada despliegue, solo para el límite. Además contradice la regla del stack de no agregar Redis. Se puede reconsiderar con un ADR nuevo si un despliegue necesita límites exactos con muchos nodos.
- **Contadores locales sin dividir el límite:** con N nodos, la suscripción podría hacer hasta N veces su límite. Es demasiado holgado para un control que el proveedor acordó.
- **Contar en el portal o en OPA:** pone una escritura en el camino de cada llamada y contradice que el tráfico no pase por el portal (ADR-0005).

## Consecuencias
- El límite es aproximado con varios nodos. Si el balanceo es desparejo, una suscripción puede pasar algo su límite en un nodo, o recibir 429 un poco antes en otro. Esto se documenta para el proveedor como "límite aproximado por minuto".
- Con un solo nodo (desarrollo, la demo, despliegues pequeños) el límite es exacto.
- Cambiar el límite de una suscripción no reinicia su contador: el nuevo valor aplica desde la siguiente actualización del bundle (S-2).
- Agregar o quitar nodos obliga a actualizar `gateway.nodes` en la configuración del despliegue. El runbook del operador (M6-07) lo incluye.
