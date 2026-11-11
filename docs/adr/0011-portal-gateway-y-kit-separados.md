# ADR-0011 — Dos entregables separados: portal + gateway, y kit de APIs instantáneas

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
La red tiene dos productos con usuarios, ciclos de entrega y lugares de despliegue distintos:

1. **Portal + gateway** (este repositorio): portal de desarrolladores y consola de gobierno, API del portal, reconciliadores, políticas OPA y la configuración del gateway central (APISIX). Lo opera el operador nacional en su infraestructura.
2. **Kit de APIs instantáneas**: lo que se entrega e instala en cada entidad proveedora (nodo con el servicio que expone sus datos, túnel WireGuard, certificado, instalador). Corre en la infraestructura de la entidad.

`SPEC.md §1` ya deja el kit fuera del alcance de este proyecto y `ARCHITECTURE.md §10` define el contrato entre ambos. Para pruebas, este repositorio tiene `infra/mock-providers`, que simula proveedores y, más adelante, un nodo.

## Decisión
- Se tratan como **dos entregables separados**, con su propio repositorio, versión y documentación. Este repositorio contiene solo el portal y el gateway.
- La **frontera** es el contrato de `ARCHITECTURE.md §10`: enrolamiento, heartbeat, renovación de certificado y configuración. Lo publica el portal y lo consume el kit. Cualquier cambio en ese contrato se versiona y se documenta aquí.
- `infra/mock-providers` y cualquier "nodo simulado" de M4 son **utilería de pruebas**, no una versión del kit. No se empaquetan, no se entregan a entidades y pueden simplificar lo que el kit real hará.
- Mientras el kit no tenga su repositorio, las pruebas de punta a punta se hacen aquí con los mocks.
- Lo que sea propio del kit (instalador, conectores a bases de datos de la entidad, generación automática de APIs, cliente WireGuard del nodo, agente de heartbeat) no se implementa en este repositorio.

## Alternativas consideradas
- **Monorepo con ambos productos:** facilita el desarrollo inicial, pero mezcla ciclos de entrega y superficies de seguridad distintas (el kit corre en redes de las entidades). Además, el kit podría necesitar dependencias que no deben entrar al portal (por ejemplo, drivers de bases de datos propietarias, ver ADR-0002).

## Consecuencias
- Las historias de M4 de este repositorio implementan el lado del portal y del gateway (tokens de enrolamiento, endpoints del contrato, hub WireGuard, upstream `node`). El nodo que se conecta en las pruebas es un simulador.
- Hace falta un documento de contrato versionado (por ejemplo, un OpenAPI de los endpoints de nodos) antes de que el kit empiece a consumirlo; se produce en M4-02.
