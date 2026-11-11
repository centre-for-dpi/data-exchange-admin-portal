# OPA (desarrollo)

`config.yaml` configura OPA para descargar el bundle `rid` desde el API del portal (`GET /api/v1/opa/bundle.tar.gz`, autenticado con `OPA_BUNDLE_TOKEN`) cada 10–20 s. En desarrollo el API corre en el host, así que OPA lo alcanza en `host.docker.internal:4000`.

- Hasta M1-09 el endpoint no existe: OPA registra errores de descarga cada pocos segundos y, al no tener políticas, niega todo. Es lo esperado.
- Los *decision logs* de OPA están desactivados a propósito: la entrada de cada decisión incluye las cabeceras de la petición (`Authorization`, `X-RID-End-User` en claro). Los metadatos de acceso salen por APISIX → Fluent Bit (ARCHITECTURE.md §8).
- `GET http://localhost:8181/v1/config` muestra la configuración activa (con las credenciales ocultas).
