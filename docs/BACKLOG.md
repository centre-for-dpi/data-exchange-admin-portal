# Backlog — Portal RID

Trabaja en orden. Un hito se cierra cuando todas sus historias están en `[x]` y su demo de cierre funciona. Las fechas son indicativas (calendario 2026–2027).

| Hito | Objetivo | Fechas indicativas |
| :-- | :-- | :-- |
| M0 | Fundaciones: monorepo, infraestructura local, configuración por país | 12–14 nov |
| M1 | **Flujo de punta a punta (demo de fin de noviembre)** | 17–28 nov |
| MT | Transparencia para el titular: quién consultó mis datos, avisos y comprobante verificable | adelantado a M2 |
| M2 | Gobierno completo: entidades, roles, aprobaciones, auditoría | 1–12 dic |
| M3 | Seguridad de credenciales y del tráfico | 14 dic – 9 ene |
| M4 | Nodos del kit y onboarding (listo para el bootcamp) | 12–23 ene |
| M5 | Uso, indicadores y observabilidad | 26 ene – 6 feb |
| M6 | Endurecimiento y despliegue de producción | febrero |

Formato: `ID — título`. Criterios de aceptación (CA) debajo. **SPIKE** = investigación con tiempo acotado.

---

## M0 — Fundaciones

- [x] **M0-01 — Monorepo y calidad**
  - pnpm workspaces + Turborepo con `apps/web`, `apps/api`, `packages/contracts`, `packages/policy`, `packages/config`.
  - ESLint, Prettier, TypeScript estricto, Vitest configurado en todos los paquetes.
  - CI (GitHub Actions): lint, typecheck, test, `opa test`, license check.
  - _Notas de implementación:_ TypeScript fijado en `~6.0` porque typescript-eslint aún no soporta 7.x. NestJS 12 es solo ESM, así que todos los paquetes son ESM (`"type": "module"`). `packages/policy` no usa Vitest: sus pruebas son `opa test` (`pnpm test:policy`, con OPA local o en contenedor). Prettier no formatea Markdown para no reescribir la documentación.
- [x] **M0-02 — Infraestructura local**
  - `infra/compose/docker-compose.yml` con PostgreSQL, Keycloak, APISIX, etcd, OPA, step-ca, OpenSearch, Fluent Bit, Mailpit y mock-providers, todos con healthcheck.
  - `pnpm infra:up` deja todo sano en < 3 min en una laptop de 16 GB.
  - _Notas de implementación:_ medido en frío (volúmenes vacíos, imágenes ya descargadas): 11 servicios sanos en 105 s, incluida la reconstrucción del mock. `infra:up` usa `docker compose up --wait`, así que falla si algún servicio no queda sano. Todos los puertos se publican solo en `127.0.0.1` y se pueden mover con variables `*_PORT` en `.env` (los valores por defecto son los de este archivo). etcd y Fluent Bit no se publican. La Admin API de APISIX sí se publica en `127.0.0.1:9180`, porque el reconciliador corre en el host con `pnpm dev`, y exige `APISIX_ADMIN_KEY`. OpenSearch y Fluent Bit van en el perfil `observability`; `pnpm infra:up:core` arranca el resto. Keycloak usa su propia base dentro del mismo PostgreSQL de desarrollo. El filtro de lista permitida de Fluent Bit ya está activo (se adelantó de M5-01 por la regla de oro 2); la prueba automatizada sigue en M5-01. Los mocks son por ahora un esqueleto con `/health`; datos, OpenAPI y registro de cabeceras llegan en M0-04.
- [x] **M0-03 — Keycloak para desarrollo**
  - Realm `rid-portal` con usuarios semilla (ver `DEMO.md`) y cliente `rid-portal-web`.
  - Realm `rid-gateway` vacío de aplicaciones, con mapper de audiencia y cuenta de servicio del portal con `manage-clients` solo en este realm.
  - Ambos como `realm-export.json` versionado.
  - _Notas de implementación:_ los archivos son `infra/keycloak/rid-portal-realm.json` y `rid-gateway-realm.json`. Los secretos y contraseñas son marcadores `${VAR}` que Keycloak resuelve desde `.env`. Además de los 5 personajes de `DEMO.md` hay `pablo.plataforma` (`platform_admin`), `sofia.auditora` (`auditor`) y `elena.admin` (`entity_admin`), para que M1-01 tenga un usuario por rol; todos tienen IDs fijos (tabla en `infra/keycloak/README.md`). `rid-portal-web` es confidencial, con PKCE S256 obligatorio, sin password grant y con `aud = rid-portal-api`. En `rid-gateway` solo existen los scopes `basic`, `service_account` (solo `client_id`) y `rid-gateway-audience`, así que los tokens de aplicación no llevan perfil, roles ni IP del cliente. Pruebas: estáticas en `pnpm test` y de integración en `pnpm test:integration` (login real Authorization Code + PKCE con cada usuario semilla y mínimo privilegio del provisionador).
- [x] **M0-04 — Gateway, OPA y proveedores de prueba**
  - APISIX con etcd, Admin API solo en la red interna de Compose.
  - OPA configurado para descargar el bundle desde `apps/api` (puede fallar hasta M1-09).
  - `mock-providers`: dos servicios Fastify ("afiliación en salud" y "registro socioeconómico") con 1.000 personas sintéticas generadas de forma determinista, recursos por ruta y registro de cabeceras `X-RID-*` (ADR-0009). **Ningún dato real.**
  - _Notas de implementación:_ la Admin API de APISIX se publica solo en `127.0.0.1` y exige clave (ver M0-02); etcd no se publica. OPA usa `infra/opa/config.yaml`: descarga `bundle.tar.gz` desde `OPA_PORTAL_URL` (por defecto `host.docker.internal:4000/api/v1/opa`) con `OPA_BUNDLE_TOKEN`, cada 10–20 s; los *decision logs* están desactivados porque la entrada incluiría `Authorization` y `X-RID-End-User`. Mocks: `salud` expone `getAfiliado` (`GET /afiliados/{numeroIdentificacion}`) y `verificarAfiliacion` (`POST /afiliados/verificaciones`, identificador en el cuerpo); `socioeconomico` expone `getHogar` (`GET /hogares/{numeroIdentificacion}`). Los datos no incluyen nombres ni otros atributos personales innecesarios; los identificadores van de `1000000001` a `1000001000`. Cada mock sirve su OpenAPI en `/openapi.yaml` y las pruebas validan sus respuestas contra ese mismo OpenAPI. Los logs del mock registran las cabeceras `X-RID-*` y `X-Request-Id` y la plantilla de ruta, nunca el identificador; `X-RID-End-User` se enmascara. La validación rechaza campos no declarados: el valor por defecto de Fastify los eliminaba en silencio. Pruebas de integración: Admin API con clave, etcd no expuesto, llamada real cliente → APISIX → mock con revisión de los logs del proveedor, y configuración de OPA.
- [x] **M0-05 — Verificación de licencias**
  - `pnpm license:check` lista licencias de todas las dependencias y falla ante cualquiera fuera de la lista permitida de `CLAUDE.md`.
  - Lista de excepciones explícita y comentada, por paquete y solo para paquetes de datos (ADR-0008).
  - _Notas de implementación:_ usa `pnpm licenses list` (sin dependencias nuevas), evalúa expresiones SPDX (`OR`/`AND`/`WITH`) y también falla si una excepción ya no se usa. Excepción inicial: `caniuse-lite` (CC-BY-4.0). `--verbose` lista cada paquete. `pnpm licenses` solo ve los binarios opcionales de la plataforma actual; la CI en Linux cubre los de Linux.
- [x] **M0-06 — Configuración por país**
  - `packages/config` carga `config/country/<código>.yaml` según `RID_COUNTRY`, la valida con zod y falla al arrancar si es inválida.
  - `co.yaml` y `example.yaml` completos según `SPEC.md §10`.
  - _Notas de implementación:_ el esquema (`packages/config/src/schema.ts`) usa objetos estrictos, así que una clave desconocida o mal escrita falla. También valida zona horaria IANA, locale BCP 47, códigos `snake_case` únicos, color `#RRGGBB`, que el logo exista (ruta relativa al YAML) y que `country.code` coincida con el nombre del archivo. Los nombres de sectores y finalidades aceptan texto simple o `{ es, en }`. Se agregaron `lifecycle` (avisos y vigencias) y `retention`, opcionales y con los valores por defecto del SPEC. El directorio se toma de `RID_CONFIG_DIR` o se busca hacia arriba (`config/country`). El API carga la configuración al arrancar y termina con código 1 y un mensaje claro si es inválida; en desarrollo lee el `.env` de la raíz. Los logos de `config/country/branding/` son marcas genéricas de relleno. Guardia de la regla de oro 6: `scripts/country-neutrality.test.mjs` falla si aparecen términos del primer despliegue en el código fuente. **Decisión posterior (ADR-0010):** `co.yaml` usa `mtls.required: false` hasta M3-10; el requisito se mantiene.
- [x] **M0-07 — Base de la web**
  - Layout, navegación por rol, i18n es/en con `next-intl`, tokens de diseño leídos de `branding` de la config, componentes base shadcn/ui.
  - Verificación de accesibilidad con axe en un test de Playwright de la página de inicio.
  - _Notas de implementación:_ Auth.js v5 sigue en beta; se fijó la versión exacta `next-auth@5.0.0-beta.32`. Si se vuelve un problema, la alternativa es `openid-client` (MIT). El login usa Authorization Code + PKCE + state + nonce. Los tokens viven solo en la cookie cifrada HttpOnly; la sesión que ve el navegador no los incluye (lo verifica el e2e). Cerrar sesión también cierra la sesión de Keycloak (logout iniciado por el cliente), así que en la demo se puede cambiar de usuario. Rutas con next-intl: español sin prefijo y `/en` para inglés, sin redirigir según el idioma del navegador (`localeDetection: false`). El branding (nombre, color y logo en `/branding/logo`) y las autoridades vienen de `co.yaml`; el color del texto sobre el primario se elige para cumplir AA. La navegación por rol está en `src/lib/navigation.ts` con pruebas, pero los roles llegan vacíos hasta M1-02 (vendrán del API). Las secciones de historias futuras muestran "Próximamente". E2E (`pnpm test:e2e`, con el stack arriba): axe WCAG 2.1 AA en inicio, en inglés y con sesión iniciada; enlace para saltar al contenido; cambio de idioma; login y logout reales con Keycloak.
- [x] **M0-08 — Base del API**
  - Errores RFC 9457, `scopedRepo`, `AuditService` (aún sin cadena), tabla `outbox` y worker pg-boss vacío, OpenAPI del portal publicado en `/api/docs`.
  - _Notas de implementación:_
    - **Prisma 7.10** con adaptador `pg`. Hay dos roles de base de datos: `rid` es dueño del esquema y corre las migraciones (`DATABASE_MIGRATION_URL`); `rid_app` es el rol del API en ejecución (`DATABASE_URL`), sin DDL. Los crea `infra/postgres/init/02-app-role.sh`, que también crea la base `rid_test`.
    - **Auditoría solo de inserción:** `rid_app` no tiene `UPDATE`, `DELETE` ni `TRUNCATE` sobre `audit_event`, y un trigger lo impide incluso al dueño del esquema. La purga por retención (5 años) necesitará un procedimiento explícito y auditado.
    - **UUIDv7** con `uuidv7()` de PostgreSQL 18.
    - **Esquema de pg-boss 12** generado como migración de Prisma (`pnpm --filter @rid/api db:pgboss-migration`); el API corre pg-boss sin permisos de DDL. Al actualizar pg-boss hay que generar su migración de upgrade.
    - **Outbox:** un relay (cada 1 s) pasa los mensajes a colas con política `stately` por agregado, así que varios cambios seguidos se reconcilian una vez. La entrega es al menos una vez. `RID_WORKER=off` desactiva el worker.
    - **`AuditService.record(tx, …)` y `OutboxService.enqueue(tx, …)` exigen el cliente de transacción**, para que el evento y el trabajo de sincronización queden en la misma transacción que el cambio. Los campos con nombre de secreto se redactan.
    - **`scopedRepo`** combina el filtro del llamador con `entityId` (no lo reemplaza), no expone operaciones por clave primaria e impide mover filas a otra entidad. La prueba con tablas reales llega en M1-01.
    - **Errores RFC 9457** en todo: también los que Fastify genera antes del handler (JSON mal formado → 400, cuerpo de más de 1 MiB → 413, tipo de contenido distinto de JSON → 415). Solo los errores de dominio llevan `detail`, porque los mensajes del framework pueden repetir la URL o parte del cuerpo.
    - **OpenAPI desde zod (ADR-0013)** en `/api/docs/openapi.json` con Scalar en `/api/docs`; una prueba exige que toda ruta esté documentada.
    - **Licencias:** se permitió EPL-2.0 (ADR-0012), que llega con el CLI de Prisma. Se descartó `@nestjs/swagger` porque arrastra `argparse` con PSF-2.0, que no está aprobada por la OSI.
    - **CI:** nuevo job con PostgreSQL (mismo Compose) que corre `pnpm --filter @rid/api test:integration`.

**Cierre M0:** `pnpm infra:up && pnpm dev` muestra la web con login funcionando contra Keycloak.

---

## M1 — Flujo de punta a punta (demo fin de noviembre)

Meta: en la demo, una entidad publica una API, otra solicita acceso con finalidad, el proveedor aprueba y una llamada real pasa por APISIX; luego se revoca y la llamada falla en menos de 60 s.

- [x] **SPIKE S-1 — Cabeceras de OPA visibles para otros plugins** (máx. 1 día)
  - Confirmar si las cabeceras de `send_headers_upstream` están disponibles para `limit-count` y `http-logger`, y cómo retirar `X-RID-End-User` en claro antes del upstream. Conclusión en `docs/spikes/S-1.md`. Si no, proponer alternativa (p. ej. `serverless-post-function` o plugin propio en Lua).
  - _Conclusión:_ sí, ambos plugins las ven, comprobado con tráfico real en APISIX 3.19. `X-RID-End-User` se retira listándolo en `send_headers_upstream` sin que la política lo devuelva, sin código propio. OPA ve la ruta pública completa: `pathRegex` se ancla a ella. Se usa `request-id` para generar `X-Request-Id`, la razón de negación va en `X-RID-Deny-Reason` y el 429 sale en problem+json con `response-rewrite`. `ARCHITECTURE.md` §4.1, §4.2 y §8 actualizados.
- [x] **M1-01 — Modelo de datos base**
  - Prisma: Entity, User, Membership, Api, ApiVersion, Application, Credential, Subscription, Purpose, AuditEvent, Outbox, SyncState.
  - Seed: 3 entidades (proveedora de salud ficticia, proveedora socioeconómica ficticia, consumidora), usuarios por rol, catálogo de finalidades de `co.yaml`.
  - _Notas de implementación:_
    - **Roles de plataforma** en `user_platform_role`, una fila por asignación para que quede auditable. El operador y el regulador no son `Entity`.
    - **Suscripciones:** `decisions[]` es la tabla `subscription_decision`. La regla "una suscripción viva por aplicación, versión y finalidad" la impone un índice único parcial (función `partialIndexes` de Prisma, en preview).
    - **"Nada se borra"** también lo impone la base: `rid_app` no tiene `DELETE` sobre las tablas de dominio. Solo lo conserva en `user_platform_role` y `api_version_purpose`, cuyas filas se revocan o editan, siempre con auditoría.
    - **`Api.status`** se guarda (desnormalizado) para filtrar el catálogo y se actualiza en la misma transacción que las versiones.
    - **Finalidades:** la tabla `purpose` es el catálogo. El seed la carga desde `co.yaml` (`source = config`) y el operador podrá agregar más (M2-10).
    - **Seed idempotente** (`pnpm db:seed`): lee los usuarios del realm de Keycloak (misma fuente de IDs) y los sectores y el tipo de identificador desde la configuración del país. Todo lo que crea queda auditado como `system:seed`. `pedro.publicador` pertenece a dos entidades para probar el selector de M1-02.
    - Quedan para sus historias: `Document` (M2-07), `Node` (M4), `Notification` (M2-08) y el estado de "pedir información" (M2-06).
- [x] **M1-02 — Sesión y contexto de entidad**
  - Login con Keycloak; el API resuelve usuario, roles de plataforma y membresías.
  - Selector de entidad activa en la UI; todo endpoint de entidad exige pertenencia (403/404 según `CLAUDE.md`).
  - _Notas de implementación:_
    - **Validación del token en el API** con `jose`: firma RS256 contra el JWKS del realm, emisor, audiencia `rid-portal-api` y expiración.
    - **Roles desde PostgreSQL en cada petición:** una membresía revocada pierde el acceso en la siguiente llamada, aunque el token siga vigente (está probado).
    - **Primer login:** el usuario se registra sin roles, con auditoría `user.registered`.
    - **Rutas por entidad (ADR-0014):** los recursos de una entidad van bajo `/entities/{entityId}/...`. Un guard global aplica la tabla `auth/policy.ts`: otra entidad → 404, miembro sin rol → 403.
    - **Endpoints nuevos:** `GET /me`, `GET /entities/{id}` y `GET /entities/{id}/members` (paginado por cursor).
    - **Web:** la entidad activa va en una cookie validada contra `/me`; el selector tiene botón explícito, sin cambio al seleccionar (WCAG 3.2.2). La navegación usa los roles de plataforma más los de la entidad activa.
    - **Renovación del token:** el access token (5 min) se renueva con el refresh token 60 s antes de vencer, en el proxy. Se verificó con Keycloak real forzando el umbral.
    - **Pruebas:** 17 de autorización con tokens firmados en la prueba (corren en la CI) y 3 e2e con Keycloak real (roles en la navegación, operadora y cambio de entidad).
- [x] **M1-03 — Registrar API y versión**
  - `api_publisher` crea API y versión: subir OpenAPI 3.x (JSON/YAML), upstream `direct` o `node` (en M1, el nodo es el mock), campos expuestos, finalidades permitidas, clasificación.
  - Lint con Spectral (reglas mínimas: `operationId`, respuestas definidas); errores visibles por línea.
  - Estados `draft → in_review`.
  - _Notas de implementación:_
    - **Ruleset RID con Spectral** (Apache-2.0): parte de OAS con todas las reglas apagadas y activa solo `oas3-schema`, `operationId` (obligatorio y único), respuesta exitosa, parámetros válidos y `rid-no-id-in-query` (si `lint.noIdInQuery`). Esta última compara palabras del nombre (camelCase, guiones) para no marcar `valid` o `unidad`. Cada problema trae la línea (1-based) y la web la muestra.
    - **La revisión de "descripciones en español" queda para M4-06**, porque necesita detectar el idioma.
    - **Una versión con errores de lint queda en borrador:** se puede reemplazar el documento (`PUT .../openapi`) y el envío a revisión devuelve 400 con `openapi:<línea>`.
    - **Upstream:** `direct` exige HTTPS. `node` lleva `servicePath`, y `nodeId` es opcional hasta M4 (en M1 el nodo es el mock). X-Road llega en M4-05.
    - **El OpenAPI se guarda como `json` (no `jsonb`)** para conservar el orden del documento.
    - **El predicado del índice parcial de suscripciones** se escribió tal como lo normaliza PostgreSQL, porque si no Prisma veía una diferencia en cada migración.
    - **Máquina de estados** en `domain/api-version/state-machine.ts`: una transición inválida devuelve 409.
    - **Permisos:** `api.write` es solo para `api_publisher`; `api.read` es para todos los miembros, el operador y el regulador.
    - **Seguridad del lint** (hallazgos de la revisión automática, corregidos con pruebas): el documento es entrada no confiable. Spectral corre con un resolver sin lectores HTTP ni de archivos, así que solo se resuelven `$ref` locales (`#/...`); la regla `rid-no-external-ref` marca los externos. Antes se comprobó que el resolver por defecto hacía la petición, es decir, que el SSRF era real. Un pre-parseo con `yaml` (`maxAliasCount: 100`) y un límite de 2 MiB del documento parseado evitan las bombas de alias YAML; sin esa defensa, una sola subida tumbaba el proceso por falta de memoria.
    - **Imports de Spectral:** sus paquetes son CommonJS y deben importarse por defecto. Vitest ocultaba el error y la prueba `pnpm --filter @rid/api test:dist` (también en la CI) lo detecta ejecutando el código compilado con Node.
- [x] **M1-04 — Revisión y publicación**
  - `platform_reviewer` aprueba o pide cambios con comentario; al aprobar → `published` (el paso del regulador llega en M2).
  - Publicar encola la reconciliación del gateway.
  - _Notas de implementación:_
    - **Endpoints de plataforma** `/review/api-versions` (cola, ficha, `approve`, `request-changes`), protegidos con `@PlatformAccess`: deciden `platform_admin` y `platform_reviewer`, el regulador solo lee y cualquier otro rol recibe 403.
    - **Aprobar** registra `approved_operator` y, en la misma transacción, publica: `published`, `publishedAt`, `Api.status = published` y un mensaje `gateway.sync` / `apiVersion:<id>` en el outbox (M1-08 lo consume). Ambas transiciones quedan auditadas.
    - **Versiones `sensitive`**, con `approval.regulatorForSensitive` activo, quedan en `approved_operator` esperando al regulador (M2-04).
    - **Pedir cambios** exige un comentario de al menos 10 caracteres. Las decisiones quedan en `api_version_review`, solo de inserción para `rid_app`, y el publicador las ve en su versión.
    - **Separación de funciones y conflicto de interés** (reforzados tras la revisión automática de seguridad): el revisor no puede pertenecer a la entidad proveedora (con ningún rol), ni haber creado la API o la versión, ni haberla enviado. Esto se verifica aunque haya dejado la entidad, y la condición sobre quien envió se repite dentro del `UPDATE` para cubrir carreras. El paso del regulador también se exige cuando algún dato expuesto es `sensitive`, aunque la API no esté clasificada así.
    - **Web:** consola del operador con la cola y la ficha de revisión (aviso de minimización, datos expuestos, finalidades, operaciones y lint), formularios de decisión accesibles y vista de solo lectura para el regulador.
- [x] **M1-05 — Catálogo y detalle**
  - Lista con búsqueda y filtros (sector, entidad, clasificación); detalle con ficha del servicio y documentación interactiva (Scalar) en modo solo lectura.
  - _Notas de implementación:_
    - **Endpoints `/catalog/*`:** búsqueda por texto en nombre, resumen y etiquetas, filtros por sector, entidad y clasificación, paginación por cursor, entidades con APIs publicadas, ficha y OpenAPI. Solo aparecen versiones `published` y `deprecated`.
    - **Datos personales en las tarjetas:** cada tarjeta lista los datos personales y sensibles que expone la API.
    - **OpenAPI del catálogo:** se sirve con `servers` reemplazado por la URL pública del gateway (`RID_GATEWAY_PUBLIC_URL`), para no publicar las direcciones internas del proveedor.
    - **`@OptionalAuth`:** sin token, el catálogo responde 401, salvo con `features.publicCatalog`, que deja ver solo APIs `public` (SPEC §2.3). Un token inválido siempre da 401. En la web, un anónimo ve la invitación a iniciar sesión.
    - **Scalar (MIT) empaquetado en la web, no desde CDN:** solo lectura (sin "Test Request" ni cliente), sin telemetría ni fuentes externas; el e2e verifica que no haya peticiones a otros hosts.
    - **Contraste de Scalar:** su paleta por defecto no cumplía WCAG AA según axe; se corrigió con `customCss`.
    - **Descripción en Markdown** con `react-markdown` (MIT), sin HTML crudo.
    - **Pendiente:** el botón "Solicitar acceso" llega con M1-07 y "probar en sandbox" con M4-08.
    - **Pendiente:** el modo `publicCatalog: true` no tiene prueba automatizada, porque `co.yaml` lo tiene apagado.
    - **Pendiente, por investigar:** en dos corridas e2e la web recibió `ECONNRESET` del API; no se pudo reproducir con el log del API a la vista. Mitigación: un reintento único en las lecturas (GET).
- [x] **M1-06 — Aplicaciones y credenciales OAuth2**
  - `app_developer` crea una aplicación; el reconciliador crea el cliente en `rid-gateway`; el secreto se muestra una sola vez.
  - Guía de integración con `curl` para obtener token.
  - _Notas de implementación:_ el portal genera el secreto (32 bytes aleatorios) y lo muestra una sola vez en la respuesta del `POST` (`Cache-Control: no-store`). En la base queda su hash SHA-256 y, solo mientras el reconciliador no lo haya aplicado, una copia sellada con AES-256-GCM (`RID_SECRETS_KEY`, ligada al id de la credencial) que el reconciliador borra al crear el cliente: así el controlador nunca llama a la Admin API de Keycloak y el secreto no sobrevive en claro en ninguna tabla ni en la auditoría. El id de la aplicación se genera en el servicio (UUIDv7) porque el `clientId` determinista `rid-app-<id>` se necesita dentro de la misma transacción. El reconciliador de Keycloak (outbox `keycloak.sync` → pg-boss) es idempotente (`created`/`updated`/`unchanged`), actualiza `sync_state` y corre una reconciliación completa cada 5 min; si el cliente desapareció de Keycloak y ya no hay secreto sellado, marca error y pide rotar la credencial (M3). La web muestra el aprovisionamiento como "Activándose", "Lista" o error y se refresca sola mientras está pendiente. El e2e obtiene un token `client_credentials` real de `rid-gateway` con `azp = rid-app-<id>` y `aud = rid-gateway`.
- [x] **M1-07 — Solicitud de acceso y aprobación**
  - Formulario: aplicación, versión, finalidad (solo las permitidas), detalle, base legal, operaciones.
  - Bandeja del `data_steward` de la proveedora: aprobar (puede reducir operaciones y vigencia) o rechazar con motivo.
  - Separación de funciones aplicada y probada.
  - _Notas de implementación:_
    - **API en dos lados:** el consumidor usa `/entities/:id/subscriptions` (leen todos los miembros, solicita el `app_developer`). El proveedor usa `/entities/:id/access-requests`: leen `data_steward`, `entity_admin`, `entity_viewer` y `api_publisher`, y decide solo el `data_steward`. Una solicitud solo existe a través de la entidad consumidora o de la proveedora; desde cualquier otra responde 404.
    - **Validaciones al solicitar:** la versión debe estar publicada (los borradores dan 404), la finalidad debe estar permitida por esa versión y las operaciones deben existir en su OpenAPI. Si no se marca ninguna operación, se piden todas las de solo lectura (GET/HEAD); si la versión no tiene ninguna, hay que elegir. La vigencia tiene el tope de `subscriptionMaxValidityMonths` según la clasificación. La regla de "una sola solicitud viva" (índice parcial) responde 409.
    - **La aprobación solo reduce:** operaciones, meses y límite por minuto no pueden superar lo solicitado (ni el `defaultRateLimit` de la versión cuando no se pidió límite). La vigencia empieza a contar desde la decisión. Los meses solicitados se guardan en `requested_validity_months` (nueva columna, rellenada desde la vigencia en las filas existentes).
    - **Interpretación:** se exige `X-RID-End-User` (`endUserIdentificationRequired`) para las clasificaciones `personal` y `sensitive` (SPEC.md §5).
    - **Separación de funciones:** no decide quien hizo la solicitud ni quien creó la aplicación que la hizo, aunque sea `data_steward` de la proveedora. Se verifica antes y otra vez dentro del `UPDATE`. `subscription_decision` es solo de inserción para `rid_app`.
    - **Datos sensibles:** con `approval.regulatorForSensitive`, la aprobación del proveedor lleva a `pending_regulator`; la decisión del regulador queda para M2-04. La regla se comparte con la publicación de APIs (`domain/approval.ts`).
    - **Gateway:** aprobar encola `policy.sync` (aggregate `subscription:<id>`). M1-09 lo consume y pasa la suscripción a `active` cuando OPA descarga el bundle; mientras tanto la UI muestra "Aprobada (activándose)".
    - **Pendientes:** la autoaprobación de sandbox (`features.sandbox.autoApprove`) queda para M4-08, porque exige el upstream de pruebas. Pedir información y desistir quedan para M2-06, y el adjunto del acuerdo para M2-07.
    - **Web:** botón "Solicitar acceso" en la ficha del catálogo (solo para `app_developer`), formulario accesible, solicitudes en "Mis aplicaciones" con su ficha, y bandeja "Solicitudes" (pendientes y todas) con los formularios de aprobar y rechazar.
- [x] **M1-08 — Reconciliador de APISIX**
  - Outbox → pg-boss → reconciliador idempotente que crea upstream y ruta con los plugins de `ARCHITECTURE.md §4.1` (sin `limit-count` ni mTLS todavía).
  - Reconciliación completa periódica; `sync_state` actualizado.
  - Test de integración: borrar una ruta a mano en APISIX y verificar que el reconcile la recrea.
  - _Notas de implementación:_
    - **Plugins:** `request-id`, `openid-connect` (con validación de `aud = rid-gateway`), `proxy-rewrite` (reescribe al `servicePath` y quita las cabeceras que solo pone el gateway), `opa`, `prometheus` y `http-logger` con los campos de §8.
    - **Diseño:** el estado deseado es una función pura (`desired-state.ts`). La comparación con APISIX acepta los valores por defecto que este agrega, así que dos pasadas seguidas no escriben nada. La pasada completa corre al arrancar y cada 5 minutos, y borra objetos `rid-` huérfanos sin tocar los demás.
    - **Pruebas:** contra APISIX real. Crear, idempotencia, ruta borrada a mano y recreada, plugin `opa` quitado a mano y repuesto, huérfanos, upstream no servible y versión retirada. El CI levanta ahora `etcd` y `apisix` en el job de integración del API.
    - **Nodos (hasta M4):** `RID_DEV_NODES` mapea cada entidad a su mock, y el mock atiende también bajo su `servicePath` (`/salud/...`), como lo haría un nodo. Un upstream con `nodeId`, sin nodo de desarrollo o `direct` con mTLS queda en error de `sync_state`, sin escribir nada (falla cerrado).
    - **e2e:** al publicar desde la UI la ruta aparece sola. Responde 401 sin token o con un token falso. Con un token válido de aplicación llega a OPA, que hoy responde 503 porque `rid/authz` aún no existe; M1-09 lo convierte en `403 no_subscription`.
    - **Cola:** el worker procesa en lotes de 10, consulta cada segundo y hace que falle solo el trabajo con error. Había un atraso de trabajos `gateway.sync` acumulado desde M1-04, que retrasaba las rutas nuevas.
    - **Privacidad, regla 2:** el access log de nginx en APISIX escribía la ruta con el número de identificación. Queda desactivado y el error log en nivel `error`, con una prueba de regresión en `tests/infra`. Pendiente para M5-01: un error real de nginx todavía puede incluir la línea de la petición.
    - **Limpieza:** la prueba de integración borra al terminar las rutas que crea, porque localmente APISIX se comparte entre la base de desarrollo y la de pruebas.
- [x] **M1-09 — Bundle y política OPA**
  - `GET /api/v1/opa/bundle.tar.gz` con `ETag`; `data.json` según `ARCHITECTURE.md §4.2`.
  - `rid.authz` con las reglas 1–6 y razones de negación estables; `opa test` con casos positivos y negativos de cada regla.
  - La suscripción pasa a `active` cuando la revisión del bundle que la contiene fue descargada por OPA (se lee `/status` de OPA o métrica equivalente).
  - Prueba de punta a punta (pendiente de la revisión de seguridad de M1-08): ninguna cabecera `X-RID-*` enviada por el cliente llega al proveedor si la política no la devuelve. `X-RID-End-User` nunca llega en claro, y `X-RID-Purpose` llega solo con el valor validado.
  - _Notas de implementación:_
    - **Política:** `rid.authz` implementa las reglas 1–6 con las razones `no_subscription`, `app_suspended`, `operation_not_allowed`, `purpose_not_allowed`, `subscription_expired` y `end_user_required`. Tiene 22 pruebas `opa test`, con 100 % de cobertura (el CI exige 90 %). La hora se fija en las pruebas con `with time.now_ns`.
    - **Bundle:** se arma desde la base en cada consulta, con un tar propio (sin dependencias) reproducible. ETag = revisión, y responde 304. La sal del hash del funcionario (`RID_END_USER_HASH_SALT`) es obligatoria: sin ella el bundle no se sirve.
    - **Activación:** OPA no expone un "GET status", así que se usa su plugin `status`, que avisa al portal (`POST /api/v1/opa/status`) qué revisión activó. `policy_bundle` guarda qué suscripciones trae cada revisión, y las `approved` pasan a `active` con auditoría. `policy.sync` actualiza el `sync_state` `opa:bundle` para la consola del operador. La UI de la solicitud se refresca sola mientras está "Aprobada (activándose)".
    - **e2e (`call.spec.ts`, DEMO pasos 5–8):** llamada real con 200 y datos del mock. El proveedor recibe la suscripción, la operación, la entidad y la aplicación que puso OPA, aunque el cliente envíe valores falsos, y solo el hash del funcionario. Se prueban además las negaciones `purpose_not_allowed`, `end_user_required` y `operation_not_allowed` (el POST no solicitado). `gateway.spec.ts` ahora espera `403 no_subscription`.
    - **Además:** `pathRegex` acepta parámetros dentro de un segmento (`/{id}.json`). El refresco automático de la web pasó a un componente genérico.
- [x] **M1-10 — Revocación**
  - `data_steward` revoca; la llamada empieza a fallar con `403 no_subscription` en < 60 s (test automatizado).
  - _Notas de implementación:_
    - **API:** `POST /entities/:id/access-requests/:sid/revoke`, solo para el `data_steward` de la proveedora y con motivo obligatorio (10 caracteres o más). Vale para suscripciones `approved`, `active` y `suspended`; la revocación es final (409 en cualquier otro estado). Registra la decisión, `subscription.revoked` en auditoría y `policy.sync`.
    - **Gateway:** la siguiente revisión del bundle ya no lleva la suscripción, y OPA la descarga en 10–20 s.
    - **Interpretación (SPEC §4.4):** revocar no está sujeto a separación de funciones, porque solo quita acceso.
    - **Web:** formulario "Revocar acceso" en la ficha de la solicitud. El consumidor ve la suscripción "Revocada" con el motivo.
    - **e2e (`call.spec.ts`, DEMO paso 9):** tras la llamada exitosa, lucia revoca desde la UI y la misma llamada se repite cada segundo hasta recibir `403 no_subscription`. En local tardó 10,5 s; la prueba exige menos de 60 s.
- [x] **M1-11 — Auditoría encadenada mínima**
  - Cadena de hash funcionando; línea de tiempo por objeto (API, suscripción) en la UI.
  - Endpoint de verificación de integridad.
  - _Notas de implementación:_
    - **Cadena:** `hash = SHA-256(prev_hash ‖ JSON canónico)` con las claves ordenadas, porque `jsonb` no conserva el orden. Los valores se normalizan antes de hashear, así que el hash coincide al releerlos. Bajo un bloqueo consultivo de la transacción, `seq` = último + 1: una transacción revertida no deja huecos, a diferencia de una secuencia. Las escrituras de auditoría quedan serializadas (aceptable a esta escala; ver ARCHITECTURE §7).
    - **Eventos previos a M1-11:** la tabla rechaza `UPDATE` incluso para el dueño, así que los eventos anteriores no se pueden rellenar. La cadena empieza en el primer evento con hash y la verificación informa cuántos quedan sin encadenar. Un despliegue nuevo no tiene ninguno.
    - **Verificación:** `GET /api/v1/audit/verify` (operador, revisor, regulador y auditor) recorre toda la cadena por lotes. Detecta un evento modificado (`hash_mismatch`), un enlace roto o un génesis borrado (`prev_hash_mismatch`), un hueco (`gap`) y un evento insertado por fuera (`missing_hash`). Pendiente para M2-09 con el anclaje diario: borrar los últimos eventos (truncar la cola) no se detecta solo con la cadena.
    - **Línea de tiempo:** para la plataforma en `GET /audit/timeline/{subscription|api}/:id` (la de una API incluye sus versiones), con eventos recientes paginados. Para cada entidad en `GET /entities/:id/audit/timeline/...`: una suscripción la ven la consumidora y la proveedora, y otra entidad recibe 404. La entidad solo ve los nombres de su propia gente; los demás aparecen como "Persona de {entidad}". Se muestran el estado anterior y el nuevo y el comentario, no los snapshots completos.
    - **Web:** página "Auditoría" con "Verificar integridad" (formulario GET, sin JavaScript) y eventos recientes que enlazan a la línea de tiempo, y la línea de tiempo dentro de las fichas de solicitud y de API. e2e del paso 10 de la demo con axe.
    - **Pruebas:** manipulaciones de la cadena con datos sintéticos (pruebas unitarias, para no romper la cadena real de `rid_test`), y concurrencia, reversión y verificación contra PostgreSQL.
- [x] **M1-12 — Demo automatizada**
  - `pnpm demo` ejecuta el guion de `DEMO.md` contra el stack local y termina en verde.
  - Test e2e Playwright del flujo completo en la UI.
  - _Notas de implementación:_
    - **`pnpm demo`** (`scripts/demo.mjs`, sin dependencias): los cinco personajes inician sesión en Keycloak con Authorization Code + PKCE, igual que en la web, y usan el API del portal. Narra los 10 pasos y comprueba lo que se promete a la audiencia: ruta creada sola, `403 no_subscription` antes de suscribirse, activación, 200 con las cabeceras que recibe el proveedor (sin el funcionario en claro), `purpose_not_allowed`, revocación en menos de 60 s, línea de tiempo y cadena íntegra. Termina con código 1 en el primer paso que falle. Usa una API por corrida (`afiliacion-<corrida>`) para poder repetirse. Corrida local: 21 s, activación en 2,1 s y revocación en 12,2 s.
    - **e2e:** `demo.spec.ts` (antes `call.spec.ts`) recorre los 10 pasos en la UI.
    - **`DEMO.md` corregido:** el `curl` del paso 7 no enviaba `X-RID-End-User`, así que una API `personal` respondía `403 end_user_required` en vivo. El `403 no_subscription` se muestra en el paso 4 (hace falta un token), y se agregaron el comando para ver las cabeceras en el mock y el bucle de la revocación.

**Cierre M1:** demo en vivo según `DEMO.md`. ✅ Ensayada de forma automática (`pnpm demo` y `e2e/demo.spec.ts`, en verde el 2026-11-12); falta la presentación en vivo.

---

## MT — Transparencia para el titular (ADR-0015, ADR-0016)

Objetivo: que el ciudadano vea en la Carpeta Ciudadana Digital quién consultó sus datos, cuándo y para qué; que reciba avisos; y que cada consulta tenga un comprobante verificable que nadie, ni el operador, pueda alterar sin que se note. Se adelanta a M2 por decisión del dueño del producto (2026-11-12).

- Alcance de esta versión: solo las consultas que pasan por el gateway.
- Para la siguiente: X-Road, con el modelo distribuido de Estonia y Ucrania, en el que cada registro reporta sus consultas.
- Fuera de alcance: intentos rechazados, reclamos, huella del contenido y consentimiento.
- La sección de la Carpeta la construye su equipo. Aquí se entregan el API, el protocolo, el verificador y una Carpeta de referencia (mock) para pruebas y demo.

- [x] **MT-01 — Titular declarado en el OpenAPI**
  - Extensión `x-rid-data-subject` por operación: parámetro de ruta, cabecera `X-RID-Data-Subject` (cuando el identificador va en el cuerpo) o `none`. Tipo de documento opcional, por defecto el primero de `identifiers.person`.
  - Regla de lint: en APIs `personal` y `sensitive`, toda operación debe declararla (error al enviar a revisión).
  - El revisor y el catálogo muestran dónde está el titular de cada operación. Los mocks declaran sus titulares.
  - _Notas de implementación:_
    - **Formato:** `x-rid-data-subject` puede ser `none`, `{ in: path, name, documentType? | documentTypeParam? }` o `{ in: header, documentType? }`. Es un chequeo propio del lint, no de Spectral, porque depende de la clasificación de la API y de `identifiers.person` del país.
    - **Errores:** con su línea. En APIs `personal` y `sensitive` la declaración es obligatoria (`rid-data-subject-required`). Siempre se validan la forma (`-invalid`), que los parámetros existan en la plantilla de la ruta (`-parameter`) y el tipo de documento (`-document-type`). Una declaración inválida cuenta como no declarada.
    - **Datos y UI:** `listOperations` y los contratos (`operationSchema`) exponen `dataSubject`. La ficha de versión (publicador y revisor) y el catálogo muestran el titular de cada operación. El catálogo explica que, si va en la cabecera, hay que enviarla.
    - **Mocks:** `getAfiliado` y `getHogar` declaran el titular en la ruta (CC); `verificarAfiliacion`, en la cabecera.
    - **Versiones ya publicadas sin declaración:** se registran sin titular hasta que el proveedor suba una versión que lo declare.
- [x] **MT-02 — Seudónimo del titular en el gateway**
  - El bundle incluye, por operación, cómo extraer el titular. OPA calcula `X-RID-Subject-Ref = HMAC-SHA-256(clave, país|tipo|número)`. La clave va en el bundle y es obligatoria (`RID_SUBJECT_REF_KEY`).
  - Sin titular declarado en la petición → `403 data_subject_required`. `X-RID-Data-Subject` en claro nunca llega al proveedor.
  - `opa test` con casos de cada regla; e2e: el proveedor recibe la referencia y no la cabecera en claro.
  - _Notas de implementación:_
    - **Bundle:** cada operación lleva `subject`. Si el titular va en la ruta, trae una expresión con grupos de captura alrededor del número (y del tipo, si viene en otro parámetro). Si va en la cabecera, trae el tipo por defecto. Si no tiene titular, `none`. La configuración agrega `subjectRefKey`, `country` y `documentTypes`.
    - **Clave:** `RID_SUBJECT_REF_KEY` es obligatoria (32 caracteres o más); sin ella el bundle no se sirve (falla cerrado, como la sal del funcionario).
    - **Seudónimo:** `HMAC-SHA-256(clave, país|tipo|número)`. El número se normaliza (sin espacios, puntos ni guiones, en mayúsculas) y debe tener entre 3 y 20 caracteres alfanuméricos; el tipo debe ser del país. La cabecera acepta `TIPO:NÚMERO` o solo `NÚMERO`, que toma el tipo de la operación o el primero del país.
    - **Negación:** si la operación declara titular y no se puede leer (falta, está repetido, mal formado o el tipo no existe) → `403 data_subject_required`. Es la última razón del orden de negación.
    - **Operaciones sin titular:** las `none` y las de versiones anteriores a MT-01 pasan sin seudónimo.
    - **APISIX:** el cliente no puede enviar `X-RID-Subject-Ref` (`proxy-rewrite`). OPA decide `X-RID-Subject-Ref` y `X-RID-Data-Subject`, y como nunca devuelve la segunda, el número en claro no llega al proveedor. Los logs de analítica no incluyen el seudónimo (prueba unitaria).
    - **Proveedor:** recibe `X-RID-Subject-Ref` (ADR-0015). El mock enmascara `x-rid-data-subject` en sus logs como defensa en profundidad.
    - **Revisión de seguridad (ADR-0017):** la cabecera `X-RID-Data-Subject` que declaraba el consumidor se reemplazó por `in: body` con un puntero JSON. El plugin propio de APISIX `rid-data-subject` lee el número del cuerpo (en memoria, con tope de 64 KiB, después de validar el token) y lo pasa a OPA en `X-RID-Body-Subject`. Un valor que envíe el cliente se descarta y nunca llega al proveedor. El lint rechaza `in: header`, punteros inválidos y operaciones sin cuerpo JSON. La lista de plugins de APISIX queda explícita en `config.yaml`. El e2e comprueba que un POST sin cabeceras obtiene el mismo seudónimo que la ruta, que las cabeceras falsificadas sobre otra persona no lo cambian y no llegan al proveedor, y que un cuerpo sin número se niega. Una segunda revisión endureció el plugin: exige `Content-Type` JSON, rechaza nombres de miembro repetidos (I-JSON) y valores con `:`, para que gateway y proveedor no lean personas distintas; y OPA falla cerrado con las operaciones de APIs personales o sensibles sin declaración válida.
    - **Pruebas:** 35 `opa test` con 100 % de cobertura. El e2e `subject.spec.ts`, contra el gateway real, comprueba que la misma persona tiene el mismo seudónimo con el número en la ruta o en el cuerpo, que el número en claro no llega, que sin él se niega, que los cuerpos ambiguos (nombres repetidos, sin `Content-Type` JSON, con `:`) se niegan, que otra persona tiene otro seudónimo y que un seudónimo falsificado se sobrescribe.
- [x] **MT-03 — Registro de consultas por titular**
  - APISIX `tcp-logger` → Fluent Bit (perfil base, búfer en disco) → colector `POST /internal/subject-access` (token de servicio) → tabla de solo inserción, enriquecida con la entidad proveedora, la API, los datos expuestos y la finalidad.
  - Retención `retention.subjectAccessMonths`. Prueba de que el número de documento no aparece en logs, búferes ni tablas.
  - Cada registro guarda **de dónde salió el titular** (`path` o `body`). Los dos salen de la propia petición: desde ADR-0017 el consumidor ya no lo declara.
  - _Notas de implementación:_ solo se registran las llamadas que llegaron al proveedor (`$upstream_status` presente, es decir, OPA las dejó pasar), así una cabecera `X-RID-Subject-Ref` falsificada en una llamada rechazada no deja rastro. La clave de idempotencia es nodo + `$request_id` de nginx (el `X-Request-Id` lo elige el cliente). El colector nunca responde 4xx por el contenido de un registro (Fluent Bit reintentaría el lote para siempre): lo descarta y lo cuenta por motivo. Consumidor, aplicación, finalidad y API salen de la suscripción, no de las cabeceras. La tabla no admite `UPDATE`/`DELETE`/`TRUNCATE` del rol `rid_app`; solo la función `purge_subject_access_records` borra lo vencido, y cada purga queda en la bitácora (`subject_access.purged`). Pruebas: `subject-access.int.test.ts` y `e2e/subject.spec.ts`.
- [ ] **MT-04 — Evidencia verificable**
  - Lotes Merkle (RFC 9162) con punto de control firmado (JWS EdDSA y JWKS), sello RFC 3161 de una TSA independiente (contenedor de desarrollo) y anclaje en la bitácora.
  - Comprobante por consulta y verificador abierto (`packages/transparency-verifier` y CLI).
  - Pruebas de alteración, borrado e inserción detectados; si la TSA no responde, el lote queda pendiente y se reintenta.
- [ ] **MT-05 — API para el titular**
  - Realm `rid-citizens` (simula Autenticación Digital) con ciudadanos semilla.
  - `GET /api/v1/data-subjects/me/accesses` y su comprobante, solo con token de ciudadano y desde aplicaciones ciudadanas autorizadas.
  - Pruebas: otro ciudadano no ve nada, sin token 401, token de otro emisor 401.
- [ ] **MT-06 — Avisos**
  - El titular se suscribe por clasificación de datos (`PUT /data-subjects/me/alerts`). Webhook firmado a la Carpeta (outbox, con reintentos) con un identificador opaco: sin número ni contacto.
- [ ] **MT-07 — Carpeta de referencia y demo**
  - Mock de la Carpeta con login del ciudadano, la sección "¿Quién consultó mis datos?", avisos por Mailpit y verificación del comprobante.
  - e2e con axe; paso 11 en `DEMO.md` y en `pnpm demo`.

**Cierre MT:** el ciudadano de la demo ve en la Carpeta de referencia la consulta de carlos, recibe el aviso y verifica el comprobante sin depender del portal.

---

## M2 — Gobierno completo

- [ ] **M2-01 — Alta de entidades**: flujo `requested → under_review → active/rejected` con documento de designación; invitaciones automáticas a los responsables.
- [ ] **M2-02 — Miembros e invitaciones**: `entity_admin` invita por correo, asigna/quita roles, revoca membresías. CA: un miembro revocado pierde acceso en la siguiente petición.
- [ ] **M2-03 — Matriz de permisos completa**: matriz de `SPEC.md §2` implementada como política central (`authz.policy.ts`); test generado por tabla para cada endpoint × rol.
- [ ] **M2-04 — Aprobación del regulador**: publicaciones y suscripciones `sensitive` pasan por `regulator` cuando la config lo exige.
- [ ] **M2-05 — Ciclo de vida de versiones**: nueva versión mayor, cambios compatibles en versión publicada (lint de compatibilidad contra la anterior), `deprecated` con fecha de retiro, `retired` con revocación y aviso previo.
- [ ] **M2-06 — Ciclo de vida de suscripciones**: pedir información, desistir, suspender/reactivar, expiración automática, aviso de renovación a 30 días, renovación prellenada.
- [ ] **M2-07 — Documentos y acuerdos**: subir PDF del acuerdo (hash SHA-256, límite de tamaño), plantilla de acuerdo modelo descargable desde la config del país.
- [ ] **M2-08 — Notificaciones**: en el portal y por correo (Mailpit en dev) para los eventos de `SPEC.md §7`; preferencias por usuario.
- [ ] **M2-09 — Auditoría completa**: todos los eventos del dominio, filtros, exportación CSV/JSON con hash del archivo, anclaje diario, permisos sin `UPDATE`/`DELETE` en la tabla verificados por test.
- [ ] **M2-10 — Catálogo de finalidades**: administración por el operador; las APIs eligen finalidades permitidas del catálogo.

**Cierre M2:** recorrido con los cuatro tipos de actor (proveedor, consumidor, operador, regulador) sin intervención técnica.

---

## M3 — Seguridad de credenciales y del tráfico

- [ ] **SPIKE S-3 — Huella del certificado de cliente en APISIX y comparación con `cnf.x5t#S256`**
- [ ] **SPIKE S-4 — Keycloak `tls_client_auth` y tokens ligados a certificado**
- [ ] **SPIKE S-2 — Límite por suscripción**
- [ ] **M3-01 — Integración con step-ca**: firma de CSR de aplicaciones con OTT del provisioner JWK; certificado descargable; aviso a 15 días del vencimiento.
- [ ] **M3-02 — mTLS de cliente en el gateway**: objeto SSL con `client.ca`; llamadas sin certificado válido rechazadas; certificados revocados rechazados vía bundle OPA.
- [ ] **M3-03 — mTLS hacia upstreams**: certificado del gateway emitido por step-ca y configurado en upstreams `node` y `direct` con mTLS.
- [ ] **M3-04 — Rotación**: segunda credencial (secreto o certificado) con ventana de rotación; revocación de la anterior.
- [ ] **M3-05 — Límites por suscripción**: `limit-count` según el resultado de S-2; 429 con problem+json; límite visible en la suscripción.
- [ ] **M3-06 — Funcionario final**: `X-RID-End-User` obligatorio según clasificación; hash con sal por despliegue; nunca se guarda en claro.
- [ ] **M3-07 — Anti-suplantación de cabeceras**: test que envía `X-RID-*` falsas desde el cliente y verifica que el proveedor recibe las correctas.
- [ ] **M3-08 — MFA para roles críticos**: roles de plataforma y `data_steward` exigen MFA en Keycloak.
- [ ] **M3-09 — Cabeceras de seguridad de la web**: CSP, HSTS, `frame-ancestors`, cookies endurecidas; test automatizado.
- [ ] **M3-10 — Reactivar mTLS obligatorio** (ADR-0010): `features.mtls.required: true` en `co.yaml`; `DEMO.md` y e2e usan certificado de cliente y token ligado. M3 no se cierra sin esta historia.
  - Pendiente de la revisión de seguridad de M1-08: mTLS hacia upstreams `direct`, y fijar en el upstream la IP que verificó el reconciliador (con `upstream_host`/SNI con el nombre original) para cerrar el DNS rebinding.

**Cierre M3:** llamada con mTLS + token ligado al certificado + límite por suscripción, y revocación de certificado efectiva en < 60 s.

---

## M4 — Nodos del kit y onboarding (bootcamp)

- [ ] **SPIKE S-5 — X-Road REST como upstream y propagación del consumidor**
- [ ] **M4-01 — Tokens de enrolamiento**: emisión de un solo uso (72 h) por entidad; listado y anulación.
- [ ] **M4-02 — Enrolamiento y heartbeat**: endpoints de `ARCHITECTURE.md §10`; estados `enrollment_issued → enrolled → online/offline`; alerta a los 5 min sin heartbeat.
- [ ] **M4-03 — Hub WireGuard**: contenedor `wg-hub`, alta de peers por reconciliador, nodo simulado conectándose en Compose.
- [ ] **M4-04 — Upstream `node` real**: la ruta apunta a la IP del túnel del nodo; el detalle de API muestra el estado del nodo.
- [ ] **M4-05 — Upstream `xroad`**: según S-5.
- [ ] **M4-06 — Validaciones al enviar a revisión**: healthcheck a través del gateway y prueba de contrato con Schemathesis en sandbox; resultados adjuntos a la revisión.
- [ ] **M4-07 — Lista de preparación del bootcamp**: por entidad, checklist de prerrequisitos (servidor, usuario de solo lectura, salida 443, responsables designados, caso de uso) con estado visible para el operador.
- [ ] **M4-08 — Modo sandbox**: aplicaciones sandbox con aprobación automática hacia upstreams de prueba.
- [ ] **M4-09 — Ficha del servicio imprimible**: vista e impresión/PDF desde el navegador.

**Cierre M4:** simulación de bootcamp: una entidad nueva enrola un nodo, publica una API instantánea y otra entidad la consume en sandbox el mismo día.

---

## M5 — Uso, indicadores y observabilidad

- [ ] **M5-01 — Pipeline de logs**: `http-logger` con el formato de `ARCHITECTURE.md §8` → Fluent Bit con filtro de lista permitida → OpenSearch. Test que verifica que ningún documento indexado contiene la ruta real ni query.
- [ ] **M5-02 — Uso para proveedores**: llamadas por consumidor, finalidad, operación, códigos de respuesta, latencia; filtros por fecha.
- [ ] **M5-03 — Uso para consumidores**: llamadas por aplicación y API, errores de autorización con su razón.
- [ ] **M5-04 — Indicadores de la red**: los de `SPEC.md §8` para regulador y operador.
- [ ] **M5-05 — Mapa de intercambios**: grafo entidad consumidora → entidad proveedora con volumen.
- [ ] **M5-06 — Métricas y alertas**: Prometheus + Alertmanager con las alertas de `ARCHITECTURE.md §9`; Grafana con un tablero de operador.
- [ ] **M5-07 — Consola de sincronización**: estado de `sync_state`, deriva detectada, reintento manual.
- [ ] **M5-08 — Guía de integración ampliada**: snippets curl, Java, Python, C#, Node con mTLS + token + cabeceras RID.

**Cierre M5:** el regulador ve los indicadores de un mes simulado (generador de tráfico sintético).

---

## M6 — Endurecimiento y producción

- [ ] **SPIKE S-6 — Aserción firmada del gateway hacia el proveedor**
- [ ] **M6-01 — Revisión ASVS L2** con lista de verificación y correcciones. Incluye el filtrado de salida del gateway por red (RFC 1918, link-local y subredes de la plataforma), pendiente de la revisión de seguridad de M1-08.
- [ ] **M6-02 — Auditoría de accesibilidad** WCAG 2.1 AA de todas las pantallas.
- [ ] **M6-03 — Prueba de carga** con k6: 500 peticiones/s sostenidas, p95 agregado por el gateway < 50 ms.
- [ ] **M6-04 — Resiliencia**: con el portal caído, el tráfico sigue; con OPA sin bundle nuevo, se mantiene el último; test documentado.
- [ ] **M6-05 — Helm charts** para producción con la topología de `ARCHITECTURE.md §11`.
- [ ] **M6-06 — Respaldos y recuperación**: pgBackRest, procedimiento de restauración probado.
- [ ] **M6-07 — Runbook del operador**: alta de entidad, incidentes, rotación de la CA intermedia, revocación masiva.
- [ ] **M6-08 — Antivirus de documentos** (ClamAV) y catálogo público opcional.
- [ ] **M6-09 — Inglés completo** y plantilla `example.yaml` probada levantando un "país de ejemplo".

**Cierre M6:** despliegue en un entorno tipo producción del operador con las pruebas de M6-03 y M6-04 en verde.
