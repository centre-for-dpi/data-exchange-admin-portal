# OPA (desarrollo)

`config.yaml` configura OPA para descargar el bundle `rid` desde el API del portal (`GET /api/v1/opa/bundle.tar.gz`, autenticado con `OPA_BUNDLE_TOKEN`) cada 10–20 s. En desarrollo el API corre en el host, así que OPA lo alcanza en `host.docker.internal:4000`.

- Mientras el API no responde (por ejemplo, antes de `pnpm dev`), OPA registra errores de descarga cada pocos segundos y, sin políticas, el gateway niega todo. Es lo esperado: falla cerrado. `GET http://localhost:8181/health?bundles` responde 200 solo con el bundle activo.
- OPA reporta la revisión activa a `POST {url}/status`; con ese reporte el portal pasa a `active` las suscripciones aprobadas.
- Los *decision logs* de OPA están desactivados a propósito: la entrada de cada decisión incluye las cabeceras de la petición (`Authorization`, `X-RID-End-User` en claro). Los metadatos de acceso salen por APISIX → Fluent Bit (ARCHITECTURE.md §8).
- `GET http://localhost:8181/v1/config` muestra la configuración activa (con las credenciales ocultas).
