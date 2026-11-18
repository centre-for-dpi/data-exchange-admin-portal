# Backlog — Portal DEN

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
  - Realm `den-portal` con usuarios semilla (ver `DEMO.md`) y cliente `den-portal-web`.
  - Realm `den-gateway` vacío de aplicaciones, con mapper de audiencia y cuenta de servicio del portal con `manage-clients` solo en este realm.
  - Ambos como `realm-export.json` versionado.
  - _Notas de implementación:_ los archivos son `infra/keycloak/den-portal-realm.json` y `den-gateway-realm.json`. Los secretos y contraseñas son marcadores `${VAR}` que Keycloak resuelve desde `.env`. Además de los 5 personajes de `DEMO.md` hay `pablo.plataforma` (`platform_admin`), `sofia.auditora` (`auditor`) y `elena.admin` (`entity_admin`), para que M1-01 tenga un usuario por rol; todos tienen IDs fijos (tabla en `infra/keycloak/README.md`). `den-portal-web` es confidencial, con PKCE S256 obligatorio, sin password grant y con `aud = den-portal-api`. En `den-gateway` solo existen los scopes `basic`, `service_account` (solo `client_id`) y `den-gateway-audience`, así que los tokens de aplicación no llevan perfil, roles ni IP del cliente. Pruebas: estáticas en `pnpm test` y de integración en `pnpm test:integration` (login real Authorization Code + PKCE con cada usuario semilla y mínimo privilegio del provisionador).
- [x] **M0-04 — Gateway, OPA y proveedores de prueba**
  - APISIX con etcd, Admin API solo en la red interna de Compose.
  - OPA configurado para descargar el bundle desde `apps/api` (puede fallar hasta M1-09).
  - `mock-providers`: dos servicios Fastify ("afiliación en salud" y "registro socioeconómico") con 1.000 personas sintéticas generadas de forma determinista, recursos por ruta y registro de cabeceras `X-DEN-*` (ADR-0009). **Ningún dato real.**
  - _Notas de implementación:_ la Admin API de APISIX se publica solo en `127.0.0.1` y exige clave (ver M0-02); etcd no se publica. OPA usa `infra/opa/config.yaml`: descarga `bundle.tar.gz` desde `OPA_PORTAL_URL` (por defecto `host.docker.internal:4000/api/v1/opa`) con `OPA_BUNDLE_TOKEN`, cada 10–20 s; los *decision logs* están desactivados porque la entrada incluiría `Authorization` y `X-DEN-End-User`. Mocks: `salud` expone `getAfiliado` (`GET /afiliados/{numeroIdentificacion}`) y `verificarAfiliacion` (`POST /afiliados/verificaciones`, identificador en el cuerpo); `socioeconomico` expone `getHogar` (`GET /hogares/{numeroIdentificacion}`). Los datos no incluyen nombres ni otros atributos personales innecesarios; los identificadores van de `1000000001` a `1000001000`. Cada mock sirve su OpenAPI en `/openapi.yaml` y las pruebas validan sus respuestas contra ese mismo OpenAPI. Los logs del mock registran las cabeceras `X-DEN-*` y `X-Request-Id` y la plantilla de ruta, nunca el identificador; `X-DEN-End-User` se enmascara. La validación rechaza campos no declarados: el valor por defecto de Fastify los eliminaba en silencio. Pruebas de integración: Admin API con clave, etcd no expuesto, llamada real cliente → APISIX → mock con revisión de los logs del proveedor, y configuración de OPA.
- [x] **M0-05 — Verificación de licencias**
  - `pnpm license:check` lista licencias de todas las dependencias y falla ante cualquiera fuera de la lista permitida de `CLAUDE.md`.
  - Lista de excepciones explícita y comentada, por paquete y solo para paquetes de datos (ADR-0008).
  - _Notas de implementación:_ usa `pnpm licenses list` (sin dependencias nuevas), evalúa expresiones SPDX (`OR`/`AND`/`WITH`) y también falla si una excepción ya no se usa. Excepción inicial: `caniuse-lite` (CC-BY-4.0). `--verbose` lista cada paquete. `pnpm licenses` solo ve los binarios opcionales de la plataforma actual; la CI en Linux cubre los de Linux.
- [x] **M0-06 — Configuración por país**
  - `packages/config` carga `config/country/<código>.yaml` según `DEN_COUNTRY`, la valida con zod y falla al arrancar si es inválida.
  - `co.yaml` y `example.yaml` completos según `SPEC.md §10`.
  - _Notas de implementación:_ el esquema (`packages/config/src/schema.ts`) usa objetos estrictos, así que una clave desconocida o mal escrita falla. También valida zona horaria IANA, locale BCP 47, códigos `snake_case` únicos, color `#RRGGBB`, que el logo exista (ruta relativa al YAML) y que `country.code` coincida con el nombre del archivo. Los nombres de sectores y finalidades aceptan texto simple o `{ es, en }`. Se agregaron `lifecycle` (avisos y vigencias) y `retention`, opcionales y con los valores por defecto del SPEC. El directorio se toma de `DEN_CONFIG_DIR` o se busca hacia arriba (`config/country`). El API carga la configuración al arrancar y termina con código 1 y un mensaje claro si es inválida; en desarrollo lee el `.env` de la raíz. Los logos de `config/country/branding/` son marcas genéricas de relleno. Guardia de la regla de oro 6: `scripts/country-neutrality.test.mjs` falla si aparecen términos del primer despliegue en el código fuente. **Decisión posterior (ADR-0010):** `co.yaml` usa `mtls.required: false` hasta M3-10; el requisito se mantiene.
- [x] **M0-07 — Base de la web**
  - Layout, navegación por rol, i18n es/en con `next-intl`, tokens de diseño leídos de `branding` de la config, componentes base shadcn/ui.
  - Verificación de accesibilidad con axe en un test de Playwright de la página de inicio.
  - _Notas de implementación:_ Auth.js v5 sigue en beta; se fijó la versión exacta `next-auth@5.0.0-beta.32`. Si se vuelve un problema, la alternativa es `openid-client` (MIT). El login usa Authorization Code + PKCE + state + nonce. Los tokens viven solo en la cookie cifrada HttpOnly; la sesión que ve el navegador no los incluye (lo verifica el e2e). Cerrar sesión también cierra la sesión de Keycloak (logout iniciado por el cliente), así que en la demo se puede cambiar de usuario. Rutas con next-intl: español sin prefijo y `/en` para inglés, sin redirigir según el idioma del navegador (`localeDetection: false`). El branding (nombre, color y logo en `/branding/logo`) y las autoridades vienen de `co.yaml`; el color del texto sobre el primario se elige para cumplir AA. La navegación por rol está en `src/lib/navigation.ts` con pruebas, pero los roles llegan vacíos hasta M1-02 (vendrán del API). Las secciones de historias futuras muestran "Próximamente". E2E (`pnpm test:e2e`, con el stack arriba): axe WCAG 2.1 AA en inicio, en inglés y con sesión iniciada; enlace para saltar al contenido; cambio de idioma; login y logout reales con Keycloak.
- [x] **M0-08 — Base del API**
  - Errores RFC 9457, `scopedRepo`, `AuditService` (aún sin cadena), tabla `outbox` y worker pg-boss vacío, OpenAPI del portal publicado en `/api/docs`.
  - _Notas de implementación:_
    - **Prisma 7.10** con adaptador `pg`. Hay dos roles de base de datos: `den` es dueño del esquema y corre las migraciones (`DATABASE_MIGRATION_URL`); `den_app` es el rol del API en ejecución (`DATABASE_URL`), sin DDL. Los crea `infra/postgres/init/02-app-role.sh`, que también crea la base `den_test`.
    - **Auditoría solo de inserción:** `den_app` no tiene `UPDATE`, `DELETE` ni `TRUNCATE` sobre `audit_event`, y un trigger lo impide incluso al dueño del esquema. La purga por retención (5 años) necesitará un procedimiento explícito y auditado.
    - **UUIDv7** con `uuidv7()` de PostgreSQL 18.
    - **Esquema de pg-boss 12** generado como migración de Prisma (`pnpm --filter @den/api db:pgboss-migration`); el API corre pg-boss sin permisos de DDL. Al actualizar pg-boss hay que generar su migración de upgrade.
    - **Outbox:** un relay (cada 1 s) pasa los mensajes a colas con política `stately` por agregado, así que varios cambios seguidos se reconcilian una vez. La entrega es al menos una vez. `DEN_WORKER=off` desactiva el worker.
    - **`AuditService.record(tx, …)` y `OutboxService.enqueue(tx, …)` exigen el cliente de transacción**, para que el evento y el trabajo de sincronización queden en la misma transacción que el cambio. Los campos con nombre de secreto se redactan.
    - **`scopedRepo`** combina el filtro del llamador con `entityId` (no lo reemplaza), no expone operaciones por clave primaria e impide mover filas a otra entidad. La prueba con tablas reales llega en M1-01.
    - **Errores RFC 9457** en todo: también los que Fastify genera antes del handler (JSON mal formado → 400, cuerpo de más de 1 MiB → 413, tipo de contenido distinto de JSON → 415). Solo los errores de dominio llevan `detail`, porque los mensajes del framework pueden repetir la URL o parte del cuerpo.
    - **OpenAPI desde zod (ADR-0013)** en `/api/docs/openapi.json` con Scalar en `/api/docs`; una prueba exige que toda ruta esté documentada.
    - **Licencias:** se permitió EPL-2.0 (ADR-0012), que llega con el CLI de Prisma. Se descartó `@nestjs/swagger` porque arrastra `argparse` con PSF-2.0, que no está aprobada por la OSI.
    - **CI:** nuevo job con PostgreSQL (mismo Compose) que corre `pnpm --filter @den/api test:integration`.

**Cierre M0:** `pnpm infra:up && pnpm dev` muestra la web con login funcionando contra Keycloak.

---

## M1 — Flujo de punta a punta (demo fin de noviembre)

Meta: en la demo, una entidad publica una API, otra solicita acceso con finalidad, el proveedor aprueba y una llamada real pasa por APISIX; luego se revoca y la llamada falla en menos de 60 s.

- [x] **SPIKE S-1 — Cabeceras de OPA visibles para otros plugins** (máx. 1 día)
  - Confirmar si las cabeceras de `send_headers_upstream` están disponibles para `limit-count` y `http-logger`, y cómo retirar `X-DEN-End-User` en claro antes del upstream. Conclusión en `docs/spikes/S-1.md`. Si no, proponer alternativa (p. ej. `serverless-post-function` o plugin propio en Lua).
  - _Conclusión:_ sí, ambos plugins las ven, comprobado con tráfico real en APISIX 3.19. `X-DEN-End-User` se retira listándolo en `send_headers_upstream` sin que la política lo devuelva, sin código propio. OPA ve la ruta pública completa: `pathRegex` se ancla a ella. Se usa `request-id` para generar `X-Request-Id`, la razón de negación va en `X-DEN-Deny-Reason` y el 429 sale en problem+json con `response-rewrite`. `ARCHITECTURE.md` §4.1, §4.2 y §8 actualizados.
- [x] **M1-01 — Modelo de datos base**
  - Prisma: Entity, User, Membership, Api, ApiVersion, Application, Credential, Subscription, Purpose, AuditEvent, Outbox, SyncState.
  - Seed: 3 entidades (proveedora de salud ficticia, proveedora socioeconómica ficticia, consumidora), usuarios por rol, catálogo de finalidades de `co.yaml`.
  - _Notas de implementación:_
    - **Roles de plataforma** en `user_platform_role`, una fila por asignación para que quede auditable. El operador y el regulador no son `Entity`.
    - **Suscripciones:** `decisions[]` es la tabla `subscription_decision`. La regla "una suscripción viva por aplicación, versión y finalidad" la impone un índice único parcial (función `partialIndexes` de Prisma, en preview).
    - **"Nada se borra"** también lo impone la base: `den_app` no tiene `DELETE` sobre las tablas de dominio. Solo lo conserva en `user_platform_role` y `api_version_purpose`, cuyas filas se revocan o editan, siempre con auditoría.
    - **`Api.status`** se guarda (desnormalizado) para filtrar el catálogo y se actualiza en la misma transacción que las versiones.
    - **Finalidades:** la tabla `purpose` es el catálogo. El seed la carga desde `co.yaml` (`source = config`) y el operador podrá agregar más (M2-10).
    - **Seed idempotente** (`pnpm db:seed`): lee los usuarios del realm de Keycloak (misma fuente de IDs) y los sectores y el tipo de identificador desde la configuración del país. Todo lo que crea queda auditado como `system:seed`. `pedro.publicador` pertenece a dos entidades para probar el selector de M1-02.
    - Quedan para sus historias: `Document` (M2-07), `Node` (M4), `Notification` (M2-08) y el estado de "pedir información" (M2-06).
- [x] **M1-02 — Sesión y contexto de entidad**
  - Login con Keycloak; el API resuelve usuario, roles de plataforma y membresías.
  - Selector de entidad activa en la UI; todo endpoint de entidad exige pertenencia (403/404 según `CLAUDE.md`).
  - _Notas de implementación:_
    - **Validación del token en el API** con `jose`: firma RS256 contra el JWKS del realm, emisor, audiencia `den-portal-api` y expiración.
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
    - **Ruleset DEN con Spectral** (Apache-2.0): parte de OAS con todas las reglas apagadas y activa solo `oas3-schema`, `operationId` (obligatorio y único), respuesta exitosa, parámetros válidos y `den-no-id-in-query` (si `lint.noIdInQuery`). Esta última compara palabras del nombre (camelCase, guiones) para no marcar `valid` o `unidad`. Cada problema trae la línea (1-based) y la web la muestra.
    - **La revisión de "descripciones en español" queda para M4-06**, porque necesita detectar el idioma.
    - **Una versión con errores de lint queda en borrador:** se puede reemplazar el documento (`PUT .../openapi`) y el envío a revisión devuelve 400 con `openapi:<línea>`.
    - **Upstream:** `direct` exige HTTPS. `node` lleva `servicePath`, y `nodeId` es opcional hasta M4 (en M1 el nodo es el mock). X-Road llega en M4-05.
    - **El OpenAPI se guarda como `json` (no `jsonb`)** para conservar el orden del documento.
    - **El predicado del índice parcial de suscripciones** se escribió tal como lo normaliza PostgreSQL, porque si no Prisma veía una diferencia en cada migración.
    - **Máquina de estados** en `domain/api-version/state-machine.ts`: una transición inválida devuelve 409.
    - **Permisos:** `api.write` es solo para `api_publisher`; `api.read` es para todos los miembros, el operador y el regulador.
    - **Seguridad del lint** (hallazgos de la revisión automática, corregidos con pruebas): el documento es entrada no confiable. Spectral corre con un resolver sin lectores HTTP ni de archivos, así que solo se resuelven `$ref` locales (`#/...`); la regla `den-no-external-ref` marca los externos. Antes se comprobó que el resolver por defecto hacía la petición, es decir, que el SSRF era real. Un pre-parseo con `yaml` (`maxAliasCount: 100`) y un límite de 2 MiB del documento parseado evitan las bombas de alias YAML; sin esa defensa, una sola subida tumbaba el proceso por falta de memoria.
    - **Imports de Spectral:** sus paquetes son CommonJS y deben importarse por defecto. Vitest ocultaba el error y la prueba `pnpm --filter @den/api test:dist` (también en la CI) lo detecta ejecutando el código compilado con Node.
- [x] **M1-04 — Revisión y publicación**
  - `platform_reviewer` aprueba o pide cambios con comentario; al aprobar → `published` (el paso del regulador llega en M2).
  - Publicar encola la reconciliación del gateway.
  - _Notas de implementación:_
    - **Endpoints de plataforma** `/review/api-versions` (cola, ficha, `approve`, `request-changes`), protegidos con `@PlatformAccess`: deciden `platform_admin` y `platform_reviewer`, el regulador solo lee y cualquier otro rol recibe 403.
    - **Aprobar** registra `approved_operator` y, en la misma transacción, publica: `published`, `publishedAt`, `Api.status = published` y un mensaje `gateway.sync` / `apiVersion:<id>` en el outbox (M1-08 lo consume). Ambas transiciones quedan auditadas.
    - **Versiones `sensitive`**, con `approval.regulatorForSensitive` activo, quedan en `approved_operator` esperando al regulador (M2-04).
    - **Pedir cambios** exige un comentario de al menos 10 caracteres. Las decisiones quedan en `api_version_review`, solo de inserción para `den_app`, y el publicador las ve en su versión.
    - **Separación de funciones y conflicto de interés** (reforzados tras la revisión automática de seguridad): el revisor no puede pertenecer a la entidad proveedora (con ningún rol), ni haber creado la API o la versión, ni haberla enviado. Esto se verifica aunque haya dejado la entidad, y la condición sobre quien envió se repite dentro del `UPDATE` para cubrir carreras. El paso del regulador también se exige cuando algún dato expuesto es `sensitive`, aunque la API no esté clasificada así.
    - **Web:** consola del operador con la cola y la ficha de revisión (aviso de minimización, datos expuestos, finalidades, operaciones y lint), formularios de decisión accesibles y vista de solo lectura para el regulador.
- [x] **M1-05 — Catálogo y detalle**
  - Lista con búsqueda y filtros (sector, entidad, clasificación); detalle con ficha del servicio y documentación interactiva (Scalar) en modo solo lectura.
  - _Notas de implementación:_
    - **Endpoints `/catalog/*`:** búsqueda por texto en nombre, resumen y etiquetas, filtros por sector, entidad y clasificación, paginación por cursor, entidades con APIs publicadas, ficha y OpenAPI. Solo aparecen versiones `published` y `deprecated`.
    - **Datos personales en las tarjetas:** cada tarjeta lista los datos personales y sensibles que expone la API.
    - **OpenAPI del catálogo:** se sirve con `servers` reemplazado por la URL pública del gateway (`DEN_GATEWAY_PUBLIC_URL`), para no publicar las direcciones internas del proveedor.
    - **`@OptionalAuth`:** sin token, el catálogo responde 401, salvo con `features.publicCatalog`, que deja ver solo APIs `public` (SPEC §2.3). Un token inválido siempre da 401. En la web, un anónimo ve la invitación a iniciar sesión.
    - **Scalar (MIT) empaquetado en la web, no desde CDN:** solo lectura (sin "Test Request" ni cliente), sin telemetría ni fuentes externas; el e2e verifica que no haya peticiones a otros hosts.
    - **Contraste de Scalar:** su paleta por defecto no cumplía WCAG AA según axe; se corrigió con `customCss`.
    - **Descripción en Markdown** con `react-markdown` (MIT), sin HTML crudo.
    - **Pendiente:** el botón "Solicitar acceso" llega con M1-07 y "probar en sandbox" con M4-08.
    - **Pendiente:** el modo `publicCatalog: true` no tiene prueba automatizada, porque `co.yaml` lo tiene apagado.
    - **Pendiente, por investigar:** en dos corridas e2e la web recibió `ECONNRESET` del API; no se pudo reproducir con el log del API a la vista. Mitigación: un reintento único en las lecturas (GET).
- [x] **M1-06 — Aplicaciones y credenciales OAuth2**
  - `app_developer` crea una aplicación; el reconciliador crea el cliente en `den-gateway`; el secreto se muestra una sola vez.
  - Guía de integración con `curl` para obtener token.
  - _Notas de implementación:_ el portal genera el secreto (32 bytes aleatorios) y lo muestra una sola vez en la respuesta del `POST` (`Cache-Control: no-store`). En la base queda su hash SHA-256 y, solo mientras el reconciliador no lo haya aplicado, una copia sellada con AES-256-GCM (`DEN_SECRETS_KEY`, ligada al id de la credencial) que el reconciliador borra al crear el cliente: así el controlador nunca llama a la Admin API de Keycloak y el secreto no sobrevive en claro en ninguna tabla ni en la auditoría. El id de la aplicación se genera en el servicio (UUIDv7) porque el `clientId` determinista `den-app-<id>` se necesita dentro de la misma transacción. El reconciliador de Keycloak (outbox `keycloak.sync` → pg-boss) es idempotente (`created`/`updated`/`unchanged`), actualiza `sync_state` y corre una reconciliación completa cada 5 min; si el cliente desapareció de Keycloak y ya no hay secreto sellado, marca error y pide rotar la credencial (M3). La web muestra el aprovisionamiento como "Activándose", "Lista" o error y se refresca sola mientras está pendiente. El e2e obtiene un token `client_credentials` real de `den-gateway` con `azp = den-app-<id>` y `aud = den-gateway`.
- [x] **M1-07 — Solicitud de acceso y aprobación**
  - Formulario: aplicación, versión, finalidad (solo las permitidas), detalle, base legal, operaciones.
  - Bandeja del `data_steward` de la proveedora: aprobar (puede reducir operaciones y vigencia) o rechazar con motivo.
  - Separación de funciones aplicada y probada.
  - _Notas de implementación:_
    - **API en dos lados:** el consumidor usa `/entities/:id/subscriptions` (leen todos los miembros, solicita el `app_developer`). El proveedor usa `/entities/:id/access-requests`: leen `data_steward`, `entity_admin`, `entity_viewer` y `api_publisher`, y decide solo el `data_steward`. Una solicitud solo existe a través de la entidad consumidora o de la proveedora; desde cualquier otra responde 404.
    - **Validaciones al solicitar:** la versión debe estar publicada (los borradores dan 404), la finalidad debe estar permitida por esa versión y las operaciones deben existir en su OpenAPI. Si no se marca ninguna operación, se piden todas las de solo lectura (GET/HEAD); si la versión no tiene ninguna, hay que elegir. La vigencia tiene el tope de `subscriptionMaxValidityMonths` según la clasificación. La regla de "una sola solicitud viva" (índice parcial) responde 409.
    - **La aprobación solo reduce:** operaciones, meses y límite por minuto no pueden superar lo solicitado (ni el `defaultRateLimit` de la versión cuando no se pidió límite). La vigencia empieza a contar desde la decisión. Los meses solicitados se guardan en `requested_validity_months` (nueva columna, rellenada desde la vigencia en las filas existentes).
    - **Interpretación:** se exige `X-DEN-End-User` (`endUserIdentificationRequired`) para las clasificaciones `personal` y `sensitive` (SPEC.md §5).
    - **Separación de funciones:** no decide quien hizo la solicitud ni quien creó la aplicación que la hizo, aunque sea `data_steward` de la proveedora. Se verifica antes y otra vez dentro del `UPDATE`. `subscription_decision` es solo de inserción para `den_app`.
    - **Datos sensibles:** con `approval.regulatorForSensitive`, la aprobación del proveedor lleva a `pending_regulator`; la decisión del regulador queda para M2-04. La regla se comparte con la publicación de APIs (`domain/approval.ts`).
    - **Gateway:** aprobar encola `policy.sync` (aggregate `subscription:<id>`). M1-09 lo consume y pasa la suscripción a `active` cuando OPA descarga el bundle; mientras tanto la UI muestra "Aprobada (activándose)".
    - **Pendientes:** la autoaprobación de sandbox (`features.sandbox.autoApprove`) queda para M4-08, porque exige el upstream de pruebas. Pedir información y desistir quedan para M2-06, y el adjunto del acuerdo para M2-07.
    - **Web:** botón "Solicitar acceso" en la ficha del catálogo (solo para `app_developer`), formulario accesible, solicitudes en "Mis aplicaciones" con su ficha, y bandeja "Solicitudes" (pendientes y todas) con los formularios de aprobar y rechazar.
- [x] **M1-08 — Reconciliador de APISIX**
  - Outbox → pg-boss → reconciliador idempotente que crea upstream y ruta con los plugins de `ARCHITECTURE.md §4.1` (sin `limit-count` ni mTLS todavía).
  - Reconciliación completa periódica; `sync_state` actualizado.
  - Test de integración: borrar una ruta a mano en APISIX y verificar que el reconcile la recrea.
  - _Notas de implementación:_
    - **Plugins:** `request-id`, `openid-connect` (con validación de `aud = den-gateway`), `proxy-rewrite` (reescribe al `servicePath` y quita las cabeceras que solo pone el gateway), `opa`, `prometheus` y `http-logger` con los campos de §8.
    - **Diseño:** el estado deseado es una función pura (`desired-state.ts`). La comparación con APISIX acepta los valores por defecto que este agrega, así que dos pasadas seguidas no escriben nada. La pasada completa corre al arrancar y cada 5 minutos, y borra objetos `den-` huérfanos sin tocar los demás.
    - **Pruebas:** contra APISIX real. Crear, idempotencia, ruta borrada a mano y recreada, plugin `opa` quitado a mano y repuesto, huérfanos, upstream no servible y versión retirada. El CI levanta ahora `etcd` y `apisix` en el job de integración del API.
    - **Nodos (hasta M4):** `DEN_DEV_NODES` mapea cada entidad a su mock, y el mock atiende también bajo su `servicePath` (`/salud/...`), como lo haría un nodo. Un upstream con `nodeId`, sin nodo de desarrollo o `direct` con mTLS queda en error de `sync_state`, sin escribir nada (falla cerrado).
    - **e2e:** al publicar desde la UI la ruta aparece sola. Responde 401 sin token o con un token falso. Con un token válido de aplicación llega a OPA, que hoy responde 503 porque `den/authz` aún no existe; M1-09 lo convierte en `403 no_subscription`.
    - **Cola:** el worker procesa en lotes de 10, consulta cada segundo y hace que falle solo el trabajo con error. Había un atraso de trabajos `gateway.sync` acumulado desde M1-04, que retrasaba las rutas nuevas.
    - **Privacidad, regla 2:** el access log de nginx en APISIX escribía la ruta con el número de identificación. Queda desactivado y el error log en nivel `error`, con una prueba de regresión en `tests/infra`. Pendiente para M5-01: un error real de nginx todavía puede incluir la línea de la petición.
    - **Limpieza:** la prueba de integración borra al terminar las rutas que crea, porque localmente APISIX se comparte entre la base de desarrollo y la de pruebas.
- [x] **M1-09 — Bundle y política OPA**
  - `GET /api/v1/opa/bundle.tar.gz` con `ETag`; `data.json` según `ARCHITECTURE.md §4.2`.
  - `den.authz` con las reglas 1–6 y razones de negación estables; `opa test` con casos positivos y negativos de cada regla.
  - La suscripción pasa a `active` cuando la revisión del bundle que la contiene fue descargada por OPA (se lee `/status` de OPA o métrica equivalente).
  - Prueba de punta a punta (pendiente de la revisión de seguridad de M1-08): ninguna cabecera `X-DEN-*` enviada por el cliente llega al proveedor si la política no la devuelve. `X-DEN-End-User` nunca llega en claro, y `X-DEN-Purpose` llega solo con el valor validado.
  - _Notas de implementación:_
    - **Política:** `den.authz` implementa las reglas 1–6 con las razones `no_subscription`, `app_suspended`, `operation_not_allowed`, `purpose_not_allowed`, `subscription_expired` y `end_user_required`. Tiene 22 pruebas `opa test`, con 100 % de cobertura (el CI exige 90 %). La hora se fija en las pruebas con `with time.now_ns`.
    - **Bundle:** se arma desde la base en cada consulta, con un tar propio (sin dependencias) reproducible. ETag = revisión, y responde 304. La sal del hash del funcionario (`DEN_END_USER_HASH_SALT`) es obligatoria: sin ella el bundle no se sirve.
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
    - **Pruebas:** manipulaciones de la cadena con datos sintéticos (pruebas unitarias, para no romper la cadena real de `den_test`), y concurrencia, reversión y verificación contra PostgreSQL.
- [x] **M1-12 — Demo automatizada**
  - `pnpm demo` ejecuta el guion de `DEMO.md` contra el stack local y termina en verde.
  - Test e2e Playwright del flujo completo en la UI.
  - _Notas de implementación:_
    - **`pnpm demo`** (`scripts/demo.mjs`, sin dependencias): los cinco personajes inician sesión en Keycloak con Authorization Code + PKCE, igual que en la web, y usan el API del portal. Narra los 10 pasos y comprueba lo que se promete a la audiencia: ruta creada sola, `403 no_subscription` antes de suscribirse, activación, 200 con las cabeceras que recibe el proveedor (sin el funcionario en claro), `purpose_not_allowed`, revocación en menos de 60 s, línea de tiempo y cadena íntegra. Termina con código 1 en el primer paso que falle. Usa una API por corrida (`afiliacion-<corrida>`) para poder repetirse. Corrida local: 21 s, activación en 2,1 s y revocación en 12,2 s.
    - **e2e:** `demo.spec.ts` (antes `call.spec.ts`) recorre los 10 pasos en la UI.
    - **`DEMO.md` corregido:** el `curl` del paso 7 no enviaba `X-DEN-End-User`, así que una API `personal` respondía `403 end_user_required` en vivo. El `403 no_subscription` se muestra en el paso 4 (hace falta un token), y se agregaron el comando para ver las cabeceras en el mock y el bucle de la revocación.

**Cierre M1:** demo en vivo según `DEMO.md`. ✅ Ensayada de forma automática (`pnpm demo` y `e2e/demo.spec.ts`, en verde el 2026-11-12); falta la presentación en vivo.

---

## MT — Transparencia para el titular (ADR-0015, ADR-0016)

Objetivo: que el ciudadano vea en la Carpeta Ciudadana Digital quién consultó sus datos, cuándo y para qué; que reciba avisos; y que cada consulta tenga un comprobante verificable que nadie, ni el operador, pueda alterar sin que se note. Se adelanta a M2 por decisión del dueño del producto (2026-11-12).

- Alcance de esta versión: solo las consultas que pasan por el gateway.
- Para la siguiente: X-Road, con el modelo distribuido de Estonia y Ucrania, en el que cada registro reporta sus consultas.
- Fuera de alcance: intentos rechazados, reclamos, huella del contenido y consentimiento.
- La sección de la Carpeta la construye su equipo. Aquí se entregan el API, el protocolo, el verificador y una Carpeta de referencia (mock) para pruebas y demo.

- [x] **MT-01 — Titular declarado en el OpenAPI**
  - Extensión `x-den-data-subject` por operación: parámetro de ruta, cabecera `X-DEN-Data-Subject` (cuando el identificador va en el cuerpo) o `none`. Tipo de documento opcional, por defecto el primero de `identifiers.person`.
  - Regla de lint: en APIs `personal` y `sensitive`, toda operación debe declararla (error al enviar a revisión).
  - El revisor y el catálogo muestran dónde está el titular de cada operación. Los mocks declaran sus titulares.
  - _Notas de implementación:_
    - **Formato:** `x-den-data-subject` puede ser `none`, `{ in: path, name, documentType? | documentTypeParam? }` o `{ in: header, documentType? }`. Es un chequeo propio del lint, no de Spectral, porque depende de la clasificación de la API y de `identifiers.person` del país.
    - **Errores:** con su línea. En APIs `personal` y `sensitive` la declaración es obligatoria (`den-data-subject-required`). Siempre se validan la forma (`-invalid`), que los parámetros existan en la plantilla de la ruta (`-parameter`) y el tipo de documento (`-document-type`). Una declaración inválida cuenta como no declarada.
    - **Datos y UI:** `listOperations` y los contratos (`operationSchema`) exponen `dataSubject`. La ficha de versión (publicador y revisor) y el catálogo muestran el titular de cada operación. El catálogo explica que, si va en la cabecera, hay que enviarla.
    - **Mocks:** `getAfiliado` y `getHogar` declaran el titular en la ruta (CC); `verificarAfiliacion`, en la cabecera.
    - **Versiones ya publicadas sin declaración:** se registran sin titular hasta que el proveedor suba una versión que lo declare.
- [x] **MT-02 — Seudónimo del titular en el gateway**
  - El bundle incluye, por operación, cómo extraer el titular. OPA calcula `X-DEN-Subject-Ref = HMAC-SHA-256(clave, país|tipo|número)`. La clave va en el bundle y es obligatoria (`DEN_SUBJECT_REF_KEY`).
  - Sin titular declarado en la petición → `403 data_subject_required`. `X-DEN-Data-Subject` en claro nunca llega al proveedor.
  - `opa test` con casos de cada regla; e2e: el proveedor recibe la referencia y no la cabecera en claro.
  - _Notas de implementación:_
    - **Bundle:** cada operación lleva `subject`. Si el titular va en la ruta, trae una expresión con grupos de captura alrededor del número (y del tipo, si viene en otro parámetro). Si va en la cabecera, trae el tipo por defecto. Si no tiene titular, `none`. La configuración agrega `subjectRefKey`, `country` y `documentTypes`.
    - **Clave:** `DEN_SUBJECT_REF_KEY` es obligatoria (32 caracteres o más); sin ella el bundle no se sirve (falla cerrado, como la sal del funcionario).
    - **Seudónimo:** `HMAC-SHA-256(clave, país|tipo|número)`. El número se normaliza (sin espacios, puntos ni guiones, en mayúsculas) y debe tener entre 3 y 20 caracteres alfanuméricos; el tipo debe ser del país. La cabecera acepta `TIPO:NÚMERO` o solo `NÚMERO`, que toma el tipo de la operación o el primero del país.
    - **Negación:** si la operación declara titular y no se puede leer (falta, está repetido, mal formado o el tipo no existe) → `403 data_subject_required`. Es la última razón del orden de negación.
    - **Operaciones sin titular:** las `none` y las de versiones anteriores a MT-01 pasan sin seudónimo.
    - **APISIX:** el cliente no puede enviar `X-DEN-Subject-Ref` (`proxy-rewrite`). OPA decide `X-DEN-Subject-Ref` y `X-DEN-Data-Subject`, y como nunca devuelve la segunda, el número en claro no llega al proveedor. Los logs de analítica no incluyen el seudónimo (prueba unitaria).
    - **Proveedor:** recibe `X-DEN-Subject-Ref` (ADR-0015). El mock enmascara `x-den-data-subject` en sus logs como defensa en profundidad.
    - **Revisión de seguridad (ADR-0017):** la cabecera `X-DEN-Data-Subject` que declaraba el consumidor se reemplazó por `in: body` con un puntero JSON. El plugin propio de APISIX `den-data-subject` lee el número del cuerpo (en memoria, con tope de 64 KiB, después de validar el token) y lo pasa a OPA en `X-DEN-Body-Subject`. Un valor que envíe el cliente se descarta y nunca llega al proveedor. El lint rechaza `in: header`, punteros inválidos y operaciones sin cuerpo JSON. La lista de plugins de APISIX queda explícita en `config.yaml`. El e2e comprueba que un POST sin cabeceras obtiene el mismo seudónimo que la ruta, que las cabeceras falsificadas sobre otra persona no lo cambian y no llegan al proveedor, y que un cuerpo sin número se niega. Una segunda revisión endureció el plugin: exige `Content-Type` JSON, rechaza nombres de miembro repetidos (I-JSON) y valores con `:`, para que gateway y proveedor no lean personas distintas; y OPA falla cerrado con las operaciones de APIs personales o sensibles sin declaración válida.
    - **Pruebas:** 35 `opa test` con 100 % de cobertura. El e2e `subject.spec.ts`, contra el gateway real, comprueba que la misma persona tiene el mismo seudónimo con el número en la ruta o en el cuerpo, que el número en claro no llega, que sin él se niega, que los cuerpos ambiguos (nombres repetidos, sin `Content-Type` JSON, con `:`) se niegan, que otra persona tiene otro seudónimo y que un seudónimo falsificado se sobrescribe.
- [x] **MT-03 — Registro de consultas por titular**
  - APISIX `tcp-logger` → Fluent Bit (perfil base, búfer en disco) → colector `POST /internal/subject-access` (token de servicio) → tabla de solo inserción, enriquecida con la entidad proveedora, la API, los datos expuestos y la finalidad.
  - Retención `retention.subjectAccessMonths`. Prueba de que el número de documento no aparece en logs, búferes ni tablas.
  - Cada registro guarda **de dónde salió el titular** (`path` o `body`). Los dos salen de la propia petición: desde ADR-0017 el consumidor ya no lo declara.
  - _Notas de implementación:_ solo se registran las llamadas que llegaron al proveedor (`$upstream_status` presente, es decir, OPA las dejó pasar), así una cabecera `X-DEN-Subject-Ref` falsificada en una llamada rechazada no deja rastro. La clave de idempotencia es nodo + `$request_id` de nginx (el `X-Request-Id` lo elige el cliente). El colector nunca responde 4xx por el contenido de un registro (Fluent Bit reintentaría el lote para siempre): lo descarta y lo cuenta por motivo. Consumidor, aplicación, finalidad y API salen de la suscripción, no de las cabeceras. La tabla no admite `UPDATE`/`DELETE`/`TRUNCATE` del rol `den_app`; solo la función `purge_subject_access_records` borra lo vencido, y cada purga queda en la bitácora (`subject_access.purged`). Pruebas: `subject-access.int.test.ts` y `e2e/subject.spec.ts`.
- [x] **MT-04 — Evidencia verificable**
  - Lotes Merkle (RFC 9162) con punto de control firmado (JWS EdDSA y JWKS), sello RFC 3161 de una TSA independiente (contenedor de desarrollo) y anclaje en la bitácora.
  - Comprobante por consulta y verificador abierto (`packages/transparency-verifier` y CLI).
  - Pruebas de alteración, borrado e inserción detectados; si la TSA no responde, el lote queda pendiente y se reintenta.
  - _Notas de implementación:_ el sellador corre en el API cada `DEN_TRANSPARENCY_SEAL_INTERVAL_SECONDS`, con hasta `DEN_TRANSPARENCY_BATCH_MAX` registros por lote. La hoja es el JSON canónico (RFC 8785) del registro, sin el `X-Request-Id` que elige el cliente. La TSA sella los bytes del JWS, no el payload, así el sello cubre también la firma. JWKS y puntos de control son públicos (solo hashes); comprobante y verificación completa requieren `audit.read`, y el ciudadano lo recibe en MT-05. La clave de firma de desarrollo vive en `.env.example`, marcada como de desarrollo; en producción sale del gestor de secretos. Pruebas: vectores de Certificate Transparency y pruebas exhaustivas de inclusión, un comprobante sellado por la TSA real y verificado con la CLI, alteración, borrado e inserción detectados, TSA caída que se recupera, y tablas de solo inserción. Ver ARCHITECTURE §13.
- [x] **MT-05 — API para el titular**
  - Realm `den-citizens` (simula Autenticación Digital) con ciudadanos semilla.
  - `GET /api/v1/data-subjects/me/accesses` y su comprobante, solo con token de ciudadano y desde aplicaciones ciudadanas autorizadas.
  - Pruebas: otro ciudadano no ve nada, sin token 401, token de otro emisor 401.
  - _Notas de implementación:_ el API calcula el seudónimo del titular a partir del documento verificado del token, con la misma normalización y la misma clave que OPA. Un vector compartido entre los tests de Rego y los del API amarra las dos implementaciones. Además, la e2e lo prueba de punta a punta: `ciudadana.demo` entra por el realm real y ve justo las consultas que el gateway registró con su número. Solo se aceptan tokens con la audiencia `den-transparency-api` y emitidos a `carpeta-ciudadana` (`DEN_CITIZEN_CLIENTS`). Un token del portal recibe 401 en la API del titular, y uno ciudadano recibe 401 en el portal. Si el titular pide el comprobante de una consulta ajena, recibe 404. El ciudadano no puede editar su documento en el realm. El acceso administrativo auditado al registro por titular sigue pendiente (ADR-0015).
- [x] **MT-06 — Avisos**
  - El titular se suscribe por clasificación de datos (`PUT /data-subjects/me/alerts`). Webhook firmado a la Carpeta (outbox, con reintentos) con un identificador opaco: sin número ni contacto.
  - _Notas de implementación:_ la firma sigue el estándar Standard Webhooks, probado con el vector de la especificación. El aviso entra al outbox en la misma transacción que el registro y solo para filas nuevas, así un reintento del pipeline no notifica dos veces. La entrega se reintenta con espera exponencial y se omite si el ciudadano apagó los avisos mientras tanto. El cambio de avisos se audita con la aplicación ciudadana como actor. Pruebas de integración con un servidor que hace de Carpeta: firma válida, cuerpo sin número ni seudónimo, `webhook-id` estable, reintento ante 503 y aviso omitido tras apagarlo.
- [x] **MT-07 — Carpeta de referencia y demo**
  - Mock de la Carpeta con login del ciudadano, la sección "¿Quién consultó mis datos?", avisos por Mailpit y verificación del comprobante.
  - e2e con axe; paso 11 en `DEMO.md` y en `pnpm demo`.
  - _Notas de implementación:_ la carpeta está en `infra/mock-citizen-app` (Fastify, sin framework de UI, es/en, CSP estricta) y corre con `pnpm dev` en el puerto 3100. Los webhooks se verifican con la librería de referencia de Standard Webhooks, como prueba de interoperabilidad. El correo vive solo en la carpeta. El comprobante se verifica con el verificador abierto y material público. La e2e `carpeta.spec.ts` cubre el cierre del hito: login con la identidad simulada, activar avisos, llamada por el gateway, correo en Mailpit sin datos, la consulta en la tabla y "Comprobante válido", con axe en cada pantalla. `pnpm demo` agrega el paso 11, que verifica el comprobante desde el script.

**Cierre MT:** el ciudadano de la demo ve en la Carpeta de referencia la consulta de carlos, recibe el aviso y verifica el comprobante sin depender del portal. **Cerrado** (2026-11-13): `e2e/carpeta.spec.ts` y el paso 11 de `pnpm demo`.

---

## M2 — Gobierno completo

- [x] **M2-01 — Alta de entidades**: flujo `requested → under_review → active/rejected` con documento de designación; invitaciones automáticas a los responsables.
  - _Notas de implementación:_
    - **Cuentas (ADR-0018).** El realm `den-portal` permite autorregistro, con verificación de correo obligatoria. Una cuenta nueva no tiene roles.
    - **Solicitud.** Es una fila `Entity` en `requested`, con su máquina de estados en `domain/entity/state-machine.ts`. El revisor puede devolverla a `requested` con comentario. El identificador y la identificación tributaria se reservan solo al enviar (índices únicos parciales sobre `under_review`, `active`, `suspended` y `offboarded`). Así un borrador nunca enviado no bloquea a nadie, y el rechazo los libera. Crear una solicitud exige correo verificado, y cada persona tiene hasta 3 abiertas.
    - **Documento de designación.** Modelo `Document` y `StorageService` en volumen local, solo PDF, con SHA-256 y límite de 10 MiB. M2-07 reutiliza ambos.
    - **Al aprobar.** El solicitante queda como `entity_admin`. Se crea una invitación por correo para cada responsable: datos → `data_steward`, técnico → `api_publisher` + `app_developer`. Las invitaciones se aceptan con el correo verificado y vencen en 14 días. El correo sale desde el outbox (`invitation.email`, nodemailer a Mailpit).
    - **Separación de funciones.** Nadie revisa su propia solicitud ni una que lo designa.
    - **Pruebas.** 23 pruebas de integración (autorización, auditoría, documentos, invitaciones). La e2e `onboarding.spec.ts` cubre registro, solicitud, aprobación e invitación aceptada, con axe.
    - **Alta directa por el operador.** `POST /admin/entities` (solo `platform_admin`, permiso `entity_admin.create`) recibe los mismos datos de la solicitud, más el administrador de la entidad y el fundamento (`basis`): el acto o la decisión que la incorporó. Ese fundamento reemplaza al documento de designación, porque no hay solicitante. La entidad queda `active` de una vez y se audita como `entity.created` con `via: operator` y el fundamento. El administrador y los responsables reciben invitaciones (si comparten correo, una sola con la unión de roles). El operador no puede nombrarse a sí mismo administrador ni responsable designado, así las funciones de plataforma y de entidad quedan separadas. La pantalla es `/operator/entities/new`, el mismo formulario de la solicitud; tras un error conserva lo escrito. Pruebas: `entity-status.int.test.ts` y `e2e/entity-admin.spec.ts`.
    - **Pendientes resueltos después.** El aviso al solicitante se hizo en M2-08 y la suspensión y la baja en M2-11.
- [x] **M2-02 — Miembros e invitaciones**: `entity_admin` invita por correo, asigna/quita roles, revoca membresías. CA: un miembro revocado pierde acceso en la siguiente petición.
  - _Notas de implementación:_
    - **API** bajo `/entities/:entityId`:
      - `invitations`: `GET`, `POST` y `POST :id/revoke`;
      - `members/:id/roles` (`PUT`) y `members/:id/revoke` (`POST`).
    - **Permisos.** El permiso nuevo `entity.members.write` es solo del `entity_admin`. Leer miembros e invitaciones es para admin y viewer. Quien no es de la entidad recibe 404.
    - **Invitación.** Va a un correo, igual que en el alta (ADR-0018). Se envía por el outbox (`invitation.email`) y vence en 14 días. No se puede duplicar una pendiente ni invitar a un miembro activo. Una vencida se cierra (`invitation.expired`) al invitar de nuevo.
    - **Miembro revocado.** Se le puede volver a invitar, y vuelve solo con los roles de la invitación nueva.
    - **Invitaciones de un exadministrador.** Si a un administrador se le revoca el acceso o se le quita `entity_admin`, sus invitaciones pendientes se retiran en la misma transacción, y queda auditado. Así no puede volver a entrar con una invitación que dejó enviada.
    - **Último administrador.** La entidad nunca queda sin un `entity_admin` activo. Se comprueba dentro de la transacción, con bloqueo de la fila de la entidad.
    - **CA.** Los roles se leen de la base en cada petición (ADR-0004). El test lo prueba: la entidad responde 404 en la petición siguiente a la revocación.
    - **Web.** "Mi entidad" muestra los datos, los miembros con edición de roles y revocación, las invitaciones pendientes y el formulario para invitar.
    - **Pruebas.** 10 de integración, con autorización por rol y entidad y auditoría. La e2e `members.spec.ts` recorre invitar, aceptar, cambiar roles y revocar, con axe.
- [x] **M2-03 — Matriz de permisos completa**: matriz de `SPEC.md §2` implementada como política central (`authz.policy.ts`); test generado por tabla para cada endpoint × rol.
  - _Notas de implementación:_
    - **Política central.** Vive en `apps/api/src/auth/authz.policy.ts`.
    - **Declaración obligatoria.** Cada ruta declara su acceso, y el decorador nuevo `@SignedIn` cubre las de "cualquier sesión, solo lo propio" (`/me`, invitaciones, solicitudes de alta y finalidades). El guard falla cerrado ante una ruta sin declaración.
    - **Matriz publicada.** `docs/AUTHZ.md` se genera desde la política y las rutas; `authz.matrix.test.ts` falla si está desactualizada. El mismo test exige que toda ruta declare su acceso, que las de entidad vivan bajo `/entities/:entityId` y que ninguna escritura sea de sesión opcional.
    - **Test generado.** `authz.matrix.int.test.ts` recorre todas las rutas protegidas con 11 tipos de llamante: los 5 roles de entidad, los 4 de plataforma, un miembro de otra entidad y un usuario sin roles, más la petición sin sesión. Espera 401, 403, el 404 del guard o que la petición llegue al handler, según la política. Las verificaciones completas de la bitácora y del registro de transparencia solo se prueban en sus negaciones, porque recorren toda la base.
    - **Verificación del test.** Si el guard concede un permiso que la política niega, el test lo detecta; lo comprobé con una mutación temporal.
- [x] **M2-04 — Aprobación del regulador**: publicaciones y suscripciones `sensitive` pasan por `regulator` cuando la config lo exige.
  - _Notas de implementación:_
    - **Cuándo pide regulador.** Se usa la regla compartida `domain/approval.ts`: clasificación `sensitive`, o cualquier dato expuesto marcado como sensible, con `features.approval.regulatorForSensitive`.
    - **API.** `GET /regulator/approvals` es la bandeja. Las versiones se deciden en `POST /regulator/api-versions/:id/approve|request-changes` y las suscripciones en `POST /regulator/subscriptions/:id/approve|reject`. Los permisos de plataforma nuevos `regulator.read` y `regulator.decide` son solo del regulador.
    - **Versiones.** `approved_operator → approved_regulator → published` encola la ruta del gateway. Devolver una versión (`approved_operator → changes_requested`, transición nueva) exige motivo, y el proveedor lo lee en su ficha.
    - **Suscripciones.** `pending_regulator → approved` encola el `policy.sync`. La vigencia que dio el responsable de datos empieza a contar desde la decisión del regulador. Rechazar exige motivo.
    - **Separación de funciones.** El regulador no decide sobre algo que creó, envió, solicitó o ya decidió en un paso anterior, ni sobre algo de una entidad a la que pertenece. Cubre a la persona que tenga a la vez los roles de operador y de regulador.
    - **Web.** La vista del regulador muestra la bandeja. La ficha de revisión de la versión y la solicitud muestran los formularios de decisión.
    - **Pruebas.** 8 de integración. La e2e `regulator.spec.ts` publica una API sensible, aprueba la solicitud y la deja activándose, con axe. La matriz de autorización generada cubre las rutas nuevas.
- [x] **M2-05 — Ciclo de vida de versiones**: nueva versión mayor, cambios compatibles en versión publicada (lint de compatibilidad contra la anterior), `deprecated` con fecha de retiro, `retired` con revocación y aviso previo.
  - _Notas de implementación (ADR-0019):_
    - **Una versión por mayor.** Mientras una mayor no esté retirada, crear otra con la misma mayor da 409 y sugiere la mayor siguiente. La mayor nueva pasa por la revisión completa y convive en `/v{N+1}`.
    - **Cambio compatible = revisión en sitio.** `PUT .../openapi` sobre una versión publicada pasa el lint DEN y la comprobación de compatibilidad (`domain/api-version/compatibility.ts`). Sube la menor (1.0 → 1.1) con el mismo id, la misma ruta y las mismas suscripciones. El documento anterior queda en `api_version_revision`. Se encolan `gateway.sync` y `policy.sync`, y las operaciones nuevas no se conceden a las suscripciones existentes.
    - **Cambio incompatible.** Responde 400 con cada motivo; uno igual al publicado, 409.
    - **Deprecación.** `POST .../deprecate {sunsetAt}` respeta `lifecycle.apiRetirementNoticeDays` (90 días). El gateway responde con `Deprecation` (RFC 9745) y `Sunset` (RFC 8594) mediante `response-rewrite`, y se rechazan las solicitudes de acceso nuevas (409).
    - **Retiro.** `VersionLifecycleService`, cada `DEN_LIFECYCLE_INTERVAL_SECONDS` (300 s), retira las versiones cuya fecha pasó: la ruta sale del gateway, las suscripciones vivas se revocan y las pendientes se rechazan. Todo queda en la bitácora, y el estado de la API se recalcula. Es idempotente.
    - **Pruebas.** 6 de compatibilidad y 6 de integración. La e2e `lifecycle.spec.ts` cubre revisión compatible, rechazo incompatible, deprecación y cabeceras reales del gateway, con axe.
    - **Pendiente para M2-08.** Los avisos a los consumidores sobre la deprecación y el retiro próximo.
- [x] **M2-06 — Ciclo de vida de suscripciones**: pedir información, desistir, suspender/reactivar, expiración automática, aviso de renovación a 30 días, renovación prellenada.
  - _Notas de implementación:_
    - **Pedir información.** Estado nuevo `info_requested`: `POST .../access-requests/:id/request-info`, del responsable de datos. El solicitante responde con `POST .../subscriptions/:id/provide-info` y puede corregir el detalle de la finalidad y la base legal; la solicitud vuelve a `pending_provider`. Mientras espera la respuesta, no se puede aprobar.
    - **Desistir.** `POST .../subscriptions/:id/withdraw`, mientras esté pendiente.
    - **Suspender, reactivar y revocar.** Permiso nuevo `access_request.suspend`: el responsable de datos, el operador (`platform_admin`) y el regulador. Una suspensión del operador o del regulador solo la levantan ellos, y el proveedor recibe 403. Cada cambio encola el `policy.sync`.
    - **Vencimiento y aviso.** `SubscriptionLifecycleService`, cada `DEN_LIFECYCLE_INTERVAL_SECONDS`:
      - pasa a `expired` lo que superó `validUntil`;
      - `lifecycle.subscriptionRenewalNoticeDays` antes del vencimiento, avisa por correo al solicitante una sola vez (outbox `subscription.renewal_notice`). No avisa si ya hay una renovación en curso.
    - **Renovación prellenada.** Es una solicitud nueva con `renewsSubscriptionId`, con la misma aplicación, versión y finalidad, y solo de una suscripción activa. Convive con la activa hasta que se decide; hay como máximo una renovación viva por suscripción (índice parcial) y ninguna solicitud duplicada fuera de renovaciones (índice y comprobación en el API). En la web llega prellenada desde "Pedir la renovación".
    - **Renovación y suspensión.** Suspender o revocar una suscripción cierra sus renovaciones vivas en la misma transacción: las pendientes se rechazan (o se retiran si esperaban respuesta) y las ya concedidas se revocan. Además, una renovación solo se aprueba, por el proveedor o el regulador, si la suscripción que renueva sigue activa. Así una renovación no devuelve un acceso suspendido o revocado (revisión de seguridad).
    - **Pruebas.** 12 de integración, más la matriz de autorización generada. La e2e `subscription-lifecycle.spec.ts` cubre pregunta y respuesta, aprobación, suspensión, reactivación y renovación, con axe.
    - **Pendiente para M2-08.** Llevar los avisos al portal y a las preferencias del usuario.
- [x] **M2-07 — Documentos y acuerdos**: subir PDF del acuerdo (hash SHA-256, límite de tamaño), plantilla de acuerdo modelo descargable desde la config del país.
  - _Notas de implementación:_
    - **Acuerdo.** `PUT /entities/:e/subscriptions/:id/agreement` recibe el PDF, mientras el proveedor no haya decidido. Usa el mismo `StorageService` y las mismas reglas que el documento de designación: SHA-256, firma `%PDF-`, 10 MiB y token antes de leer el cuerpo. El documento pertenece a la entidad consumidora.
    - **Descarga.** Es para la consumidora y para la proveedora, y por esta última también el operador y el regulador. Va siempre como adjunto, con `Digest`, sin caché y con CSP `sandbox`.
    - **Plantilla.** `documents.agreementTemplate` de la config del país (ruta relativa al YAML, validada al cargar). Para Colombia hay un acuerdo modelo en Markdown editable. La web la sirve en `/files/agreement-template`.
    - **Eliminación por orden judicial** (SPEC §5). `POST /documents/:id/purge {order}`, solo `platform_admin`. Borra los bytes y deja la fila, su SHA-256, la orden y el evento `document.purged`; las descargas responden 410 (código `gone`).
    - **Registro de documentos.** `GET /documents` (solo `platform_admin`, permiso `document.list`) lista solo metadatos: nombre, tipo, tamaño, SHA-256, entidad dueña y eliminación con su orden. Filtra por entidad, tipo y estado, y pagina por cursor. La pantalla `/operator/documents` filtra con un formulario GET y elimina por orden legal: pide la referencia de la orden y una confirmación explícita, comprobada también en la acción del servidor.
    - **Pruebas.** 4 de integración y 1 de configuración. La e2e `agreements.spec.ts` cubre adjuntar, descargar desde ambos lados, la plantilla y la eliminación desde la consola (después la descarga responde 410), con axe.
- [x] **M2-08 — Notificaciones**: en el portal y por correo (Mailpit en dev) para los eventos de `SPEC.md §7`; preferencias por usuario.
  - _Notas de implementación:_
    - **Origen único: la bitácora.** `AuditService.record` deja un mensaje `notification.dispatch` en el outbox, en la misma transacción, para las acciones de `notifications/notifying-actions.ts`. Así un aviso existe solo si el cambio se confirmó.
    - **Destinatarios.** Un worker los calcula con el estado de ese momento (`notification-rules.ts`): responsables de datos de la proveedora, solicitante, desarrolladores de la consumidora, operadores, regulador y solicitante del alta. Nunca avisa a quien hizo la acción.
    - **Idempotencia.** Una fila por evento y persona (`@@unique([sourceSeq, userId])`), y el correo se marca al enviarse, así que los reintentos no duplican.
    - **Tipos y preferencias.** 15 tipos (`NOTIFICATION_KINDS`). Cada persona elige cuáles quiere por correo. Los de seguridad (acceso suspendido o revocado) no se pueden apagar, y la invitación ya tiene su propio correo. Los cambios de preferencias quedan en la bitácora.
    - **API.** `/me/notifications` (lista paginada con el conteo de no leídos), `/:id/read`, `/read-all` y `/me/notification-preferences`.
    - **Web.** "Avisos" en el encabezado con el conteo, y página con la lista y las preferencias. Abrir un aviso lo marca leído y lleva a su página; solo redirige a rutas del portal.
    - **Cambio en M2-06.** El aviso de renovación pasa a este mecanismo, así no hay correos dobles.
    - **Pruebas.** 5 de integración. La e2e `notifications.spec.ts` usa el worker real y Mailpit, con axe.
    - **Pendiente para M3 y M4.** Los avisos de certificado por vencer y de nodo fuera de línea.
- [x] **M2-09 — Auditoría completa**: todos los eventos del dominio, filtros, exportación CSV/JSON con hash del archivo, anclaje diario, permisos sin `UPDATE`/`DELETE` en la tabla verificados por test.
  - _Notas de implementación:_
    - **Todos los eventos.** El catálogo `audit/actions.ts` lista las 62 acciones del dominio. `actions.test.ts` falla si el código registra una acción que no está en el catálogo, si una acción dinámica no tiene sus variantes declaradas o si falta su etiqueta en es o en. Agregué las etiquetas que faltaban.
    - **Filtros.** `GET /audit/events`: acción exacta o área, tipo y id del objeto, entidad, actor y rango de fechas. En la web van en la URL, que se puede compartir.
    - **Exportación.** `GET /audit/export?format=csv|json` con los mismos filtros y todos los campos, hashes incluidos, hasta 50 000 eventos por exportación.
      - Lleva su huella en `X-DEN-Export-SHA256` y `Digest`, y una firma JWS EdDSA (`X-DEN-Export-Signature`) sobre el manifiesto `{sha256, format, count, filters, exportedAt, firstSeq, lastSeq}`, verificable con `/transparency/jwks`.
      - El CSV neutraliza fórmulas, y cada exportación queda en la bitácora (`audit.exported`).
    - **Anclaje diario.** `AuditAnchorService`, cada hora, ancla cada día cerrado de la zona horaria del país: el hash del último evento encadenado, con sello de tiempo RFC 3161 de la TSA.
      - Queda en `audit_anchor`, de solo inserción también para el dueño del esquema, se registra como `audit.anchored` y se envía por correo a los reguladores.
      - `GET /audit/verify` comprueba que cada anclaje encuentre su evento con el mismo hash. Así se detecta el corte de la cola, que quedó pendiente desde M1-11.
    - **Permisos verificados por test.** Ni `den_app` ni el dueño del esquema pueden hacer UPDATE, DELETE ni TRUNCATE en `audit_event` ni en `audit_anchor`.
    - **Pruebas.** 8 de integración, 3 del catálogo y 3 de días locales. La e2e `audit-export.spec.ts` cubre filtrar, exportar firmado y verificar con anclajes, con axe.
- [x] **M2-10 — Catálogo de finalidades**: administración por el operador; las APIs eligen finalidades permitidas del catálogo.
  - _Notas de implementación:_
    - **Administración.** `/admin/purposes`: el operador (`platform_admin`, `platform_reviewer`) agrega, edita, desactiva y reactiva finalidades. El regulador solo lee.
      - Las finalidades de la config del país se editan en el YAML (409 aquí) y el seed las mantiene sincronizadas, sin tocar `active`. Las del operador se editan en el portal.
      - Nada se borra. Una finalidad desactivada no se ofrece para versiones ni solicitudes nuevas, y las suscripciones que ya la usan la conservan.
      - Todo queda en la bitácora: `purpose.created`, `purpose.updated`, `purpose.deactivated` y `purpose.activated`.
    - **Por API.** El responsable de datos (permiso nuevo `api.purposes.write`) elige las finalidades activas de cada versión no retirada (`PUT .../versions/:id/purposes`, `api_version.purposes_changed`). OPA autoriza por la finalidad de la suscripción, así que el cambio no toca el tráfico existente.
    - **Pruebas.** 5 de integración. La e2e `purposes.spec.ts` cubre alta en la consola, elección en la versión y desactivación, con axe.
- [x] **M2-11 — Suspensión y baja de entidades**: `active ⇄ suspended`, `active → offboarded` (SPEC.md §4.1 punto 4): la suspensión bloquea publicaciones nuevas y suspende en el gateway las suscripciones de la entidad como consumidora.
  - _Notas de implementación:_
    - **Quién decide.** `/admin/entities/:id/suspend|reactivate|offboard`, solo `platform_admin`. El revisor y el regulador solo ven la lista.
    - **Suspender.**
      - El bundle de OPA marca suspendidas las aplicaciones de la entidad, y el gateway responde `app_suspended`. Con `alsoAsProvider` (`providerSuspended`), sus APIs dejan de servir a otras entidades.
      - No toca el estado de cada suscripción: al reactivar, cada una vuelve como estaba.
      - Bloquea con 409 lo nuevo: APIs, versiones, envíos, revisiones compatibles, aprobaciones del operador y del regulador, y solicitudes de acceso.
    - **Dar de baja** (definitivo, también desde `suspended`). En una sola transacción auditada:
      - revoca o cierra las suscripciones vivas como consumidora y como proveedora;
      - retira sus versiones servidas y quita sus rutas. Para eso agregué `published → retired`, permitida solo en la baja.
      - revoca las membresías y las invitaciones pendientes.
    - **Avisos.** Los administradores de la entidad reciben un aviso de seguridad (`entity_status_changed`) que no se puede desactivar.
    - **Web.** "Entidades de la red" en la consola del operador.
    - **Pruebas.** 4 de integración, con el efecto en el bundle de OPA. La e2e `entity-admin.spec.ts` suspende y reactiva desde la consola, con axe.

**Cierre M2:** recorrido con los cuatro tipos de actor (proveedor, consumidor, operador, regulador) sin intervención técnica.

  - **Estado (2026-11-14).** Las historias de M2 están hechas, cada una con su e2e en la que intervienen los cuatro tipos de actor desde la UI:
    - `onboarding`: alta con autorregistro, aprobación del operador e invitación;
    - `members`: el administrador de la entidad invita, cambia roles y revoca;
    - `regulator`: publicación y suscripción sensibles;
    - `lifecycle`: revisión compatible, deprecación y cabeceras reales del gateway;
    - `subscription-lifecycle`: pregunta, respuesta, suspensión y renovación;
    - `agreements`: acuerdo de intercambio y plantilla;
    - `notifications`: avisos en el portal y en Mailpit;
    - `audit-export`: exportación firmada y anclajes;
    - `purposes`: catálogo de finalidades;
    - `entity-admin`: suspensión, reactivación y alta directa por el operador.
  - **Recorrido único** (`e2e/governance.spec.ts`, unos 2 minutos), alrededor de una entidad nueva:
    1. El operador la registra directamente.
    2. Su administrador se autorregistra y acepta la invitación.
    3. Una API de salud se publica con revisión del operador.
    4. La entidad nueva crea una aplicación y pide acceso con el acuerdo adjunto.
    5. La responsable de datos aprueba y el administrador recibe el aviso.
    6. La llamada pasa por el gateway.
    7. El operador suspende la entidad, el gateway la niega (`app_suspended`), y al reactivarla vuelve a pasar.
    8. El operador la da de baja: la suscripción se cierra y sus personas pierden el acceso.
    9. La exportación firmada de la bitácora contiene cada paso.

    El regulador tiene su propio recorrido (`regulator.spec.ts`), porque interviene solo con datos sensibles.
  - **Pendiente.** El despliegue en el VPS, acordado para el cierre de M2. Requiere activar en Keycloak el registro y la verificación de correo, y crear el volumen de documentos.

---

## M3 — Seguridad de credenciales y del tráfico

- [x] **SPIKE S-3 — Huella del certificado de cliente en APISIX y comparación con `cnf.x5t#S256`**
  - _Conclusión_ (`docs/spikes/S-3.md`, prototipo reproducible): funciona, comprobado con tráfico real en APISIX 3.19.
    - Un objeto SSL con `client.ca` rechaza en el handshake las llamadas sin certificado y las de otra CA.
    - Un plugin en la fase rewrite calcula la huella RFC 8705 desde `ssl_client_raw_cert` (no `$ssl_client_fingerprint`, que es SHA-1) y la pasa a OPA en una cabecera. La cabecera del cliente se reemplaza y la del gateway no llega al proveedor.
    - OPA niega con `certificate_mismatch`, `token_not_bound` y `certificate_revoked`.
    - Se revoca con datos del bundle: una lista de huellas vigentes por aplicación, sin CRL ni OCSP.
    - El TLS debe terminar en APISIX: en el VPS hace falta un nombre o puerto propio con paso directo TLS (ver M3-10).
- [x] **SPIKE S-4 — Keycloak `tls_client_auth` y tokens ligados a certificado**
  - _Conclusión_ (`docs/spikes/S-4.md`, prototipo reproducible con Keycloaks desechables): funciona en `client_credentials` con Keycloak 26.8.
    - Los clientes usan `client-x509`, con el sujeto exacto y la CA emisora fijados, y `tls.client.certificate.bound.access.tokens`.
    - El token trae `cnf.x5t#S256` con la misma fórmula del gateway (S-3).
    - Montaje recomendado: APISIX termina el único mTLS, también para el token (ruta en el gateway hacia `den-gateway`). Le pasa a Keycloak el certificado verificado en `SSL_CLIENT_CERT` y `ssl-client-verify`, con el proveedor `nginx` y `trust-proxy-verification`.
    - Keycloak cree en esa cabecera, así que toda otra vía hacia él (Traefik `/auth`, la red interna) debe borrarla.
    - Las opciones SPI deben ir en el formato nuevo de Keycloak 26.8 (`--spi-x509cert-lookup--provider`).
- [x] **SPIKE S-2 — Límite por suscripción**
  - _Conclusión_ (`docs/spikes/S-2.md`, prototipo reproducible): no hace falta plugin propio.
    - OPA devuelve `X-DEN-Subscription` y `X-DEN-Rate-Limit` desde el bundle, y `limit-count` usa `count: "$http_x_den_rate_limit"` y la suscripción como clave.
    - El cliente no puede subirse el límite ni reiniciar su contador. Cambiar el límite no reinicia el contador.
    - El 429 del gateway sale en problem+json y el del proveedor pasa intacto (condición sobre `upstream_status`).
    - Sin Redis, cada nodo cuenta por su lado: ADR-0020 reparte el límite entre los nodos del gateway.
- [x] **M3-01 — Integración con step-ca**: firma de CSR de aplicaciones con OTT del provisioner JWK; certificado descargable; aviso a 15 días del vencimiento.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §4.4`.
    - El `app_developer` pega en la ficha de la aplicación un CSR hecho en su servidor (el portal muestra el comando `openssl`). La clave privada nunca pasa por el portal.
    - El portal revisa el CSR antes de la CA (`pkijs`): CN = clientId y ningún otro nombre, clave ECDSA P-256/P-384 o RSA 2048-4096, firma válida. Luego lo hace firmar por step-ca con un OTT del provisioner `den-portal`, por `lifecycle.certificateValidityDays`.
    - La plantilla `infra/step-ca/app.tpl` emite solo `CN=<clientId>`, con uso de clave solo para autenticación de cliente. `configure.sh` la aplica en cada arranque de la CA.
    - El portal comprueba que el certificado devuelto tenga ese sujeto y esa clave y que encadene a la raíz. Guarda la cadena (pública), la huella `x5t#S256`, el serial y las fechas, y lo audita (`credential.created`, sin el PEM).
    - La cadena se descarga en `application/pem-certificate-chain`. Una aplicación tiene un solo certificado activo hasta la rotación de M3-04.
    - `lifecycle.certificateExpiryWarningDays` antes del vencimiento, los desarrolladores de la entidad reciben la notificación `certificate_expiring` (en el portal y por correo). Al vencer, el certificado pasa a `expired`. Los dos pasos se auditan.
    - Interpretación: el certificado se puede pedir aunque `features.mtls.required` esté apagado (la ficha dice que es opcional), para que las entidades lo tengan listo antes de M3-10.
    - Pendiente para M3-02: las huellas vigentes en el bundle de OPA. Pendiente para M3-10: el cliente `client-x509` en Keycloak.
    - Despliegue: el `.env` del VPS necesita `DEN_STEP_CA_URL`, `DEN_STEP_CA_PROVISIONER_PASSWORD` (= `STEP_CA_PASSWORD`) y `DEN_STEP_CA_ROOT_FILE` (`scripts/make-deploy-env.mjs` ya los genera). El montaje de `certs/` usa `subpath`, que pide Compose 2.26 o posterior.
- [x] **M3-02 — mTLS de cliente en el gateway**: objeto SSL con `client.ca`; llamadas sin certificado válido rechazadas; certificados revocados rechazados vía bundle OPA.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §4.1` y `§4.2`.
    - El reconciliador de APISIX mantiene el objeto SSL `den-ssl-gateway` en los nombres de `DEN_GATEWAY_TLS_HOSTS`. Su certificado de servidor lo emite step-ca con un provisioner propio, `den-gateway-tls` (plantilla `gateway.tpl`, solo autenticación de servidor). El portal genera la clave, la guarda sellada y renueva el certificado en el último tercio de su vida.
    - Con `features.mtls.required`, el objeto lleva `client.ca` con la intermedia y la raíz de la red. Una llamada sin certificado, o con uno de otra CA, no pasa el handshake.
    - El plugin propio `den-client-cert` (todas las rutas) borra la huella que mande el cliente y pone la del certificado verificado. OPA la lee y nunca la devuelve, así que no llega al proveedor.
    - El bundle trae por aplicación sus certificados vigentes (`clients[id].certificates`, en lugar de `revokedCertFingerprints`) y `config.mtlsRequired`. La política niega con `client_certificate_required`, `token_not_bound`, `certificate_mismatch` y `certificate_revoked`. También los aplica a todo token ligado, aunque el mTLS no sea obligatorio. Emitir o vencer un certificado encola `policy.sync`.
    - Probado con APISIX y step-ca reales: rechazo sin certificado y con otra CA, huella RFC 8705 correcta, huella falsificada borrada en HTTP y HTTPS, renovación. La política tiene 48 tests (cobertura 100 %).
    - Pendiente para M3-10: la ruta del token en el gateway hacia Keycloak (S-4), el cliente `client-x509` con tokens ligados, y la prueba de punta a punta con token ligado. Sin ellos, activar el flag niega todo el tráfico (`token_not_bound`). Por eso `co.yaml` sigue con `mtls.required: false`.
    - Revocar un certificado desde el portal llega con M3-04. La salida del bundle ya está probada con el estado `revoked`.
- [x] **M3-03 — mTLS hacia upstreams**: certificado del gateway emitido por step-ca y configurado en upstreams `node` y `direct` con mTLS.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §4.1`.
    - El gateway tiene un certificado de cliente por entidad proveedora, `CN=den-gateway.<slug>` (prefijo `DEN_GATEWAY_CLIENT_NAME`). Lo emite step-ca con el provisioner `den-portal` (solo autenticación de cliente). El portal guarda la clave sellada y lo renueva en el último tercio de su vida.
    - Es por proveedor y no compartido por una revisión de seguridad: con una sola identidad, una entidad podía apuntar su versión `direct` a la API mTLS de otra entidad y llegar a ella como el gateway (diputado confundido). Cada proveedor acepta solo su nombre.
    - Va en el objeto SSL de tipo `client` `den-ssl-gateway-client-<entityId>`, que los upstreams de la entidad referencian por id. El reconciliador lo asegura solo cuando una versión lo necesita: los upstreams sin mTLS no dependen de step-ca.
    - `direct` con `mtls` presenta ese certificado. Todo `direct` verifica ahora el certificado del proveedor (`tls.verify`), algo que antes no se hacía.
    - `node` sobre TLS (los nodos de M4; en desarrollo, `DEN_DEV_NODES` con `https://host:puerto`) presenta el certificado y verifica el del nodo contra la CA de la red, para el nombre del nodo.
    - Cierra también el DNS rebinding pendiente de M1-08: el upstream `direct` apunta a las direcciones que el reconciliador resolvió y encontró públicas, con el nombre como Host y SNI (`pass_host: rewrite`, `upstream_host`).
    - Probado con tráfico real (APISIX, step-ca y un servicio mTLS en el host): el nodo recibe `CN=den-gateway.salud` y el Host correcto. Sin el certificado del gateway, o con un nodo de otra CA, la llamada da 502.
    - En desarrollo APISIX alcanza el host (`host.docker.internal`, solo para estas pruebas); el despliegue lo quita.
- [x] **M3-04 — Rotación**: segunda credencial (secreto o certificado) con ventana de rotación; revocación de la anterior.
  - _Notas de implementación:_ detalle en `SPEC.md §4.3` y `ARCHITECTURE.md §4.3`.
    - Rotar el secreto (`POST …/credentials/secret`) da uno nuevo, que se muestra una sola vez, y deja el anterior `rotating` durante `lifecycle.credentialRotationDays` (configuración del país, 7 por defecto, máximo 30).
    - Pedir un certificado con uno vigente lo renueva del mismo modo. Hay una rotación a la vez por tipo de credencial.
    - Revocar (`POST …/credentials/{id}/revoke`, con motivo opcional para la bitácora) corta la credencial de inmediato: un certificado sale del bundle de OPA; un secreto deja de valer en Keycloak cuando corre el reconciliador. El secreto actual no se revoca (409): primero se rota.
    - Al terminar la ventana, el trabajo periódico pasa la credencial anterior a `expired`. El bundle excluye un certificado fuera de su ventana aunque el trabajo no haya corrido.
    - Keycloak guarda los dos secretos con su política de rotación (`den-secret-rotation`). Keycloak ignora los atributos de secreto rotado por la Admin API: se comprobó con Keycloak 26.8, y `tests/infra` lo prueba con la cuenta del provisionador.
    - Todo queda auditado: `credential.rotation_started`, `credential.revoked`, `credential.rotation_ended`.
    - Despliegue: en el VPS hay que aplicar la política con `node scripts/keycloak-client-policies.mjs`, porque su realm ya existe.
- [x] **M3-05 — Límites por suscripción**: `limit-count` según el resultado de S-2; 429 con problem+json; límite visible en la suscripción.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §4.1` y `§4.2`.
    - Cada ruta lleva `limit-count`: `count: $http_x_den_rate_limit`, clave `http_x_den_subscription`, ventana de 60 s, contadores locales.
    - OPA pone las dos cabeceras al permitir. El límite es el `rateLimitPerMinute` de la suscripción, o el de la versión, dividido por `DEN_GATEWAY_NODES` (ADR-0020) y redondeado hacia arriba.
    - El 429 propio del gateway sale en problem+json (`rate_limited`) por el plugin propio `den-rate-limited`, y el 429 de un proveedor pasa intacto. Se usó un plugin y no `response-rewrite`, como en S-2, porque las versiones deprecadas ya usan `response-rewrite` para sus cabeceras.
    - El límite que aplica ya se veía en la ficha de la suscripción. La guía de integración de la aplicación explica el 429 y las cabeceras `X-RateLimit-*`.
    - Probado con tráfico real (la prueba de S-2 convertida en integración):
      - cada suscripción tiene su propio límite;
      - el cliente no puede subirse el límite ni reiniciar su contador;
      - una llamada negada no consume el límite;
      - cambiar el límite no reinicia el contador;
      - el 429 del proveedor pasa intacto.
    - CI levanta además `opa` y `mock-salud` para la integración del API.
- [x] **M3-06 — Funcionario final**: `X-DEN-End-User` obligatorio según clasificación; hash con sal por despliegue; nunca se guarda en claro.
  - _Notas de implementación:_ la base existía desde M1-09: la suscripción marca `endUserIdentificationRequired` por la clasificación, OPA exige la cabecera y la convierte en HMAC con `DEN_END_USER_HASH_SALT`, y no la reenvía. Esta historia la completa:
    - La política exige también el funcionario si la clasificación **actual** de la ruta es `personal` o `sensitive`: una API reclasificada lo exige a las suscripciones anteriores.
    - El valor debe ser un identificador (1 a 128 caracteres ASCII visibles, sin espacios). Si no, se niega con `end_user_invalid`, una razón nueva, y no se calcula su hash.
    - En producción, el bundle rechaza la sal y la clave del seudónimo de ejemplo de `.env.example`: cada despliegue tiene las suyas.
    - Pruebas de que el valor en claro no sale: los formatos de log del gateway y una prueba estática de las listas permitidas de Fluent Bit (`tests/infra`). El e2e de la demo ya comprobaba que al proveedor solo llega el hash.
    - Al escribir esa prueba se encontró que el filtro del log de acceso descartaba `deny_reason`, así que la analítica perdía la razón de las negaciones. Se corrigió.
    - La guía de integración de la aplicación muestra la cabecera y explica qué valor va.
- [x] **M3-07 — Anti-suplantación de cabeceras**: test que envía `X-DEN-*` falsas desde el cliente y verifica que el proveedor recibe las correctas.
  - _Notas de implementación:_
    - Prueba de integración contra APISIX y OPA reales, con la **política real** (cargada en OPA bajo un paquete de prueba, sin tocar el bundle del portal) y la cadena de plugins del reconciliador. Un proveedor en el host devuelve las cabeceras que recibe.
    - Comprueba que:
      - el proveedor recibe los valores de OPA (entidad, aplicación, suscripción, operación, finalidad, límite, hash del funcionario y seudónimo del titular), nunca los falsos;
      - no llegan los valores en claro ni las entradas del gateway;
      - las variantes de mayúsculas y de guiones bajos y una cabecera repetida no cuelan nada;
      - una cabecera falsa no convierte una llamada negada en permitida.
    - La prueba encontró dos huecos:
      - una cabecera `X-DEN-*` fuera de las listas (por ejemplo `X-DEN-Deny-Reason`) llegaba al proveedor;
      - `X_DEN_Subscription` pasaba, porque APISIX acepta guiones bajos, y los servidores tipo CGI la leen igual que `X-DEN-Subscription`.
    - Se cerraron con el plugin propio `den-header-guard`, primero en la fase rewrite: borra toda `X-DEN-*` del cliente, guiones bajos incluidos, salvo `X-DEN-Purpose` y `X-DEN-End-User`.
    - Solo `openid-connect` queda fuera de la ruta de prueba: la política decodifica el token, y su firma la cubre el e2e del gateway.
    - La suplantación de `SSL_CLIENT_CERT` hacia Keycloak (S-4) va con M3-10.
- [x] **M3-08 — MFA para roles críticos**: roles de plataforma y `data_steward` exigen MFA en Keycloak.
  - _Notas de implementación:_
    - Interpretación (ADR-0021): segundo factor por **escalado de sesión**, no por un atributo `requires_mfa` sincronizado (lo que preveía `ARCHITECTURE.md §3.1`). El portal decide con los roles de PostgreSQL y el API lo exige en cada petición, así que el portal no necesita `manage-users` en `den-portal`.
    - Keycloak: el flujo `den-browser` tiene dos niveles, contraseña (`acr=password`) y TOTP (`acr=mfa`). Pedir `acr_values=mfa` en la misma sesión solo agrega el código. Quien no tiene uno pasa por `CONFIGURE_TOTP`. El código no se puede reutilizar y el refresh conserva el nivel. Todo probado contra Keycloak 26.8, también la importación con el marcador del secreto.
    - API: los roles de plataforma y `data_steward` reciben 403 `mfa_required` en toda ruta de entidad o de plataforma si el token no trae `acr=mfa`. Se comprueba después de los roles (otra entidad sigue siendo 404). `/me` informa `mfa.required` y `mfa.satisfied`. Un rol crítico recién otorgado exige el código desde la siguiente petición.
    - Web: con `/me` o con un 403 `mfa_required`, vuelve a iniciar sesión con `acr_values=mfa` y conserva el idioma. Una cookie de 2 minutos evita bucles: si no se consiguió el nivel, el encabezado muestra un aviso con un botón para reintentar.
    - Demo y desarrollo: los usuarios semilla con rol crítico traen la clave TOTP `DEN_DEMO_TOTP_SECRET`, aleatoria en el piloto. `pnpm demo:otp`, `pnpm demo`, los e2e y las pruebas de infraestructura generan el código. Como cada código sirve una vez, prueban el del periodo siguiente o el anterior antes de esperar.
    - Un Keycloak existente recibe el flujo con `scripts/keycloak-portal-mfa.mjs`, y con `--demo-otp` los códigos de demo.
    - La revisión de seguridad señaló el enrolamiento en el primer uso: con solo la contraseña de una cuenta crítica sin segundo factor, un atacante puede enrolar el suyo. Se mitigó así:
      - Keycloak le escribe al dueño de la cuenta en cada cambio de credencial, con un solo correo y sin correos por login fallido;
      - guarda esos eventos 90 días;
      - el runbook explica cómo responder.

      Cerrar del todo la ventana (enrolar al activar la cuenta o fuera de banda) queda como opción del despliegue (`ARCHITECTURE.md §3.1`).
    - Fuera de alcance: WebAuthn como segundo factor alternativo. Puede agregarse en Keycloak en el nivel 2 sin cambiar el portal.
- [x] **M3-09 — Cabeceras de seguridad de la web**: CSP, HSTS, `frame-ancestors`, cookies endurecidas; test automatizado.
  - _Notas de implementación:_
    - CSP con nonce por respuesta, que pone el proxy de Next: `script-src 'self' 'nonce-…' 'strict-dynamic'`, sin `unsafe-inline` ni `unsafe-eval` en producción.
      - `frame-ancestors`, `object-src` y `base-uri` en `'none'`.
      - `form-action` admite el propio origen y el de Keycloak: el navegador aplica la directiva a la redirección del inicio de sesión.
      - `style-src` admite estilos en línea (colores de la marca, Scalar).
    - HSTS (dos años, `includeSubDomains`) y el resto de las cabeceras en toda respuesta, desde `next.config`. HSTS va siempre, porque `next.config` se compila sin la URL pública y los navegadores lo ignoran sobre http.
    - Las rutas que no son páginas llevan una CSP que no carga nada.
    - Cookies: se verifica que las de Auth.js son `HttpOnly`, `SameSite=Lax` y de un solo host (`Secure` sobre HTTPS). Las propias ya lo eran.
    - Tests:
      - unitarios de la política;
      - e2e (`security-headers.spec.ts`), que comprueba las cabeceras y que cada script lleva el nonce de su respuesta;
      - la página corre sin ninguna violación de CSP: componentes cliente, catálogo y documentación con Scalar;
      - las cookies después del inicio de sesión.
- [x] **M3-10 — Reactivar mTLS obligatorio** (ADR-0010): `features.mtls.required: true` en `co.yaml`; `DEMO.md` y e2e usan certificado de cliente y token ligado. M3 no se cierra sin esta historia.
  - _Notas de implementación:_
    - Interpretación (ADR-0022): la aplicación se autentica con **su secreto**, y el token queda **ligado al certificado** que APISIX verificó (`tls.client.certificate.bound.access.tokens`). No se usa `client-x509`, que recomendaba S-4. Con él, una cabecera `SSL_CLIENT_CERT` inventada hacia Keycloak autenticaría a la aplicación con solo su certificado público. Además, la rotación del secreto (M3-04) dejaría de servir.
    - Ruta de token del gateway `den-oauth-token` (`POST /oauth/token`), del reconciliador de APISIX. Lleva a Keycloak el certificado verificado en `SSL_CLIENT_CERT` y `ssl-client-verify`, siempre reescritos, y borra sus otras grafías. Keycloak arranca con el proveedor x509 `nginx` y `trust-proxy-verification`.
    - El `tokenUrl` de las aplicaciones es esa ruta. La raíz de la red es pública (`GET /api/v1/pki/ca`), y la guía de la aplicación muestra los comandos con `--cert`, `--key` y `--cacert`.
    - Pruebas contra APISIX, Keycloak y step-ca reales (`token-route.int.test.ts`):
      - el token sale ligado a la huella del certificado del handshake;
      - una cabecera de certificado inventada no cambia cuál es;
      - por HTTP o directo a Keycloak sin certificado, no hay token;
      - un certificado válido no reemplaza al secreto;
      - sin certificado no hay sesión TLS.
    - `DEMO.md`, `pnpm demo` y los e2e usan certificado y token ligado. Las sondas sin token ("¿ya existe la ruta?") van al puerto HTTP local.
    - Cierre de M3 en el e2e del gateway y en `pnpm demo`: llamada con mTLS y token ligado, límite por suscripción (M3-05) y revocación del certificado efectiva en menos de 60 s (`403 certificate_revoked`).
    - Despliegue: nombre propio del gateway con router TCP `HostSNI` y paso directo TLS hacia el 9443, y `/auth` borra las cabeceras del certificado (`DEPLOYMENT.md §5.2`, `make-deploy-env.mjs --gateway-host`).
    - Al correr por primera vez los e2e de M3-04 aparecieron dos bugs de la ficha de la aplicación. Ambos están corregidos: los formularios quedan montados y deciden qué mostrar.
      - Al rotar el secreto, la página se volvía a renderizar con la rotación en curso y desmontaba el formulario. El secreto nuevo, que se muestra una sola vez, no llegaba a verse.
      - Al revocar una credencial pasaba lo mismo con el aviso "Credencial revocada.".
    - Un certificado recién emitido llega al gateway con el siguiente bundle de OPA (10–20 s); hasta entonces la llamada se niega como `certificate_revoked`. Los e2e lo esperan (`untilCertificateKnown`).
  - Despliegue (S-3): Traefik termina hoy el TLS del VPS y enruta `/gw` por ruta, así que no puede pasar el certificado del cliente. El gateway necesita un nombre propio con `HostSNI` y `tls.passthrough` hacia el 9443 de APISIX. El nombre DNS del gateway ya existe en el VPS de demo (2026-11-14). Allí el certificado de servidor del gateway lo emite step-ca, y la ruta del token va por el mismo nombre.
  - Lo pendiente de la revisión de seguridad de M1-08 (mTLS hacia upstreams `direct` y fijar la IP verificada) quedó hecho en M3-03.

**Cierre M3:** llamada con mTLS + token ligado al certificado + límite por suscripción, y revocación de certificado efectiva en < 60 s.

---

## M4 — Nodos del kit y onboarding (bootcamp)

- [x] **SPIKE S-5 — X-Road REST como upstream y propagación del consumidor**
  - _Conclusión_ (`docs/spikes/S-5.md`, prototipo reproducible contra un Security Server simulado según PR-REST 1.0.4): funciona sin plugin propio.
    - El upstream es el Security Server **del operador** (URL de la configuración del despliegue, no de la versión). La ruta reescribe a `/r1/{serviceId}/…`, con las partes del identificador **literales**: APISIX codifica `upstream_uri`, y una parte ya codificada llega doble codificada.
    - `proxy-rewrite` fija `X-Road-Client` (el subsistema del operador) y borra `X-Road-Security-Server`, `-Represented-Party`, `-Id` y `-Request-Hash` del consumidor.
    - El consumidor real viaja en las `X-DEN-*`, que X-Road pasa como cabeceras definidas por el usuario. OPA pone además `X-Road-UserId` (hash del funcionario) y `X-Road-Issue` (`den:subscription:<id>`).
    - Riesgo nuevo, el diputado confundido: todas las rutas `xroad` salen con la identidad del operador. El miembro del `serviceId` debe ser el miembro X-Road de la entidad que publica, y ese miembro lo registra el operador.
    - Queda por confirmar con un Security Server real (piloto) que las `X-DEN-*` llegan intactas al sistema del proveedor.
- [x] **M4-01 — Tokens de enrolamiento**: emisión de un solo uso (72 h) por entidad; listado y anulación.
  - _Notas de implementación:_
    - Interpretación: el token es **de un nodo**. Emitirlo registra el nodo (`enrollment_issued`, nombre único en la entidad), y el token enrola esa sola instalación del kit. Así el nodo ya tiene nombre e ID antes del bootcamp, y el estado `enrollment_issued` de `SPEC.md §4.6` tiene un dueño.
    - El token (`den-enroll-` + 256 bits) se muestra una vez (`cache-control: no-store`). Se guarda solo su SHA-256, que no sale del API ni va a la bitácora. Vale `DEN_NODE_ENROLLMENT_TTL_HOURS` (72 por defecto); vencido, se lista como `expired`.
    - Mientras el nodo no se enrola, se puede anular el token o emitir otro, que anula el vigente (motivo `superseded` en la bitácora).
    - Permisos: emiten y anulan `entity_admin` y `platform_admin` (`node.write`). Ven los nodos todos los miembros, el revisor y el regulador (`node.read`). La consola del operador lista todos los nodos de la red (`node.list`).
    - Auditoría: `node.created`, `node.enrollment_token_issued`, `node.enrollment_token_revoked`.
    - Web: "Mi entidad → Nodos del kit" (`/my-entity/nodes`) y "Consola del operador → Nodos de la red" (`/operator/nodes`).
- [x] **M4-02 — Enrolamiento y heartbeat**: endpoints de `ARCHITECTURE.md §10`; estados `enrollment_issued → enrolled → online/offline`; alerta a los 5 min sin heartbeat.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §10`.
    - Contrato v1 versionado en `docs/contracts/node-contract-v1.openapi.json`, generado desde el API (ADR-0011). Un test falla si se desactualiza.
    - Certificado del nodo: el CSR lleva siempre `CN=den-node` sin nombres. step-ca exige que el CN sea el `sub` del OTT y el kit no sabe su ID antes de enrolarse. El provisioner propio `den-nodes` (`node.tpl`) pone el nombre `den-node-<nodeId>` como único SAN DNS, con autenticación de servidor y de cliente. El portal comprueba ese nombre en lo que devuelve la CA.
    - Enrolamiento: cualquier rechazo del token es el mismo 401. La CA firma antes de la transacción, y un fallo antes del commit deja el token usable. Dirección `/32` del túnel nunca reutilizada. Clave WireGuard repetida: 409.
    - Canal de control (mTLS del nodo): ruta `den-node-control` del gateway hacia el API. La huella del certificado verificado vale solo con el token de control que agrega APISIX, comparado en tiempo constante.
      - Interpretación: el TLS del nodo termina en el gateway, como el de las aplicaciones (ADR-0022), y no en el API.
      - Sin mTLS obligatorio en la red, el objeto SSL igual exige el certificado en el canal de control (`skip_mtls_uri_regex` exime el resto). Así funciona en un país sin `features.mtls.required`.
    - Renovación con el certificado vigente. Durante 24 h, el reemplazado solo repite esa misma renovación: con la misma clave recibe el certificado vigente. Así quien tenga la clave reemplazada no certifica una propia, como señaló la revisión de seguridad. `GET /config` lista las versiones publicadas que sirve el nodo.
    - Entidad dada de baja: sus nodos pierden el canal de control. Entidad suspendida: sus nodos envían heartbeat, pero no renuevan.
    - `offline` a los 5 min sin heartbeat (también un enrolado que nunca envió uno). La notificación `node_offline` llega a los administradores de la entidad y a los `platform_admin`. Baja definitiva (`decommissioned`) por `entity_admin` o `platform_admin`.
    - Auditoría: `node.enrolled`, `node.online`, `node.offline`, `node.services_changed`, `node.certificate_renewed`, `node.decommissioned`.
    - Probado con step-ca real y la ruta de control en APISIX real (`node-control-route.int.test.ts`): heartbeat por mTLS, cabeceras falsas ignoradas, otro certificado de la red no abre el nodo, sin TLS no hay huella.
    - Despliegue: reiniciar step-ca crea el provisioner `den-nodes`. Variables nuevas en `DEPLOYMENT.md §4`.
- [x] **M4-03 — Hub WireGuard**: contenedor `wg-hub`, alta de peers por reconciliador, nodo simulado conectándose en Compose.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §10` y `DEPLOYMENT.md §3.14`.
    - Interpretación (ADR-0023): el hub enruta las conexiones TLS hacia los nodos **por SNI** (nginx `stream` con `ssl_preread`) y no reenvía paquetes. APISIX no necesita una ruta IP hacia el túnel ni privilegios de red, y el TLS sigue de punta a punta entre el gateway y el nodo.
    - Aislamiento: `ip_forward=0` y descarte de todo lo nuevo que llega por `wg0`. Un nodo no alcanza otros nodos, el hub ni la plataforma.
    - El agente del hub recibe el estado completo (peers y rutas SNI) y lo aplica con `wg syncconf`. Guarda el último estado en su volumen.
    - El reconciliador del portal (`wireguard.sync` y una pasada por minuto) incluye los nodos enrolados, en línea o sin conexión de entidades activas o suspendidas. Agrega o quita el peer en menos de un segundo después de enrolar o dar de baja.
    - El contrato v1 suma `gatewayClientName`: el nombre del certificado con el que el gateway llama al nodo (M3-03). El nodo acepta solo ese.
    - Nodo simulado `mock-node` (perfil `nodes`, utilería de pruebas, ADR-0011): espera el token, se enrola con `openssl` y `wg`, levanta el túnel, sirve `mock-salud` por mTLS y envía heartbeats por el gateway.
    - Pruebas:
      - hub en contenedores desechables (`tests/infra`): handshake, enrutamiento por SNI, nombres desconocidos sin destino, nodos sin acceso al hub, estados inválidos rechazados;
      - reconciliador contra PostgreSQL;
      - e2e: elena emite el token, el nodo simulado se enrola, se une al hub y queda "En línea".
    - Despliegue: el piloto publica UDP 51820 del hub (`docker-compose.deploy.yml`), y el firewall del host debe dejarlo pasar. Variables nuevas: `DEN_WG_HUB_AGENT_URL` y `DEN_WG_HUB_AGENT_TOKEN`.
- [x] **M4-04 — Upstream `node` real**: la ruta apunta a la IP del túnel del nodo; el detalle de API muestra el estado del nodo.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §4.1`.
    - Interpretación (ADR-0023): la ruta apunta al enrutador SNI del hub (`wg-hub:8443`) con el nombre del nodo (`den-node-<id>`) como SNI, `Host` y nombre verificado. El hub resuelve la dirección del túnel del nodo y su puerto de servicio. mTLS de punta a punta con el certificado del gateway para la entidad (M3-03) y la CA de la red.
    - Falla cerrado: un nodo de otra entidad, sin enrolar o dado de baja nunca se llama; el reconciliador borra la ruta. Un nodo `offline` conserva la suya. Enrolar o dar de baja un nodo reconcilia sus versiones. Al registrar, el `nodeId` debe ser de un nodo de la entidad que no esté dado de baja.
    - El detalle de la versión (proveedor y revisor) y el del catálogo (consumidor) muestran el nodo, su estado y su último heartbeat. El formulario de versión ofrece los nodos de la entidad. Sin nodo, sigue el servicio de prueba del entorno (`DEN_DEV_NODES`), como hasta M3.
    - e2e (`kit-node.spec.ts`): el nodo simulado se enrola, pedro publica una API en él, carlos la consume con mTLS y token ligado, y la llamada pasa por el túnel (el nodo la registra). El catálogo muestra el nodo en línea. Al darlo de baja, la ruta desaparece.
    - Despliegue: `DEN_GATEWAY_WG_HUB` (por defecto `wg-hub:8443`).
- [x] **M4-05 — Upstream `xroad`**: según S-5.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §4.1`.
    - El upstream guarda solo el `serviceId` y una ruta opcional. El Security Server es el del operador, de la configuración del despliegue (SSRF). `SPEC.md §3.1` se ajustó: ya no hay `securityServerUrl` por versión.
    - Ruta `/r1/{serviceId}{ruta}/…` con partes literales, validadas (letras, dígitos, espacio y `. _ - : ~`). `X-Road-Client` fijo y borrado de las cabeceras de control del consumidor. `X-Road-UserId` (hash del funcionario) y `X-Road-Issue` (`den:subscription:<id>`) desde la política.
    - Miembro X-Road de la entidad, registrado por el operador (`PUT /admin/entities/{id}/xroad-member`, único por entidad, auditado). Una versión `xroad` solo puede nombrar un servicio de ese miembro: se valida al registrar y en cada pasada del reconciliador, que falla cerrado.
    - Sobre HTTPS, certificado de cliente propio del gateway para X-Road (`den-ssl-gateway-xroad`).
    - La revisión de seguridad encontró que una parte `..` o una ruta con segmentos `..` podía llevar al Security Server a otro servicio, y que la instancia no estaba ligada. Se rechazan las partes de solo puntos y los segmentos vacíos, `.` y `..`, y la instancia debe ser la del operador. Se valida al registrar y en el reconciliador.
    - Probado contra APISIX y OPA reales, con la política real y un Security Server simulado (`xroad.int.test.ts`): URL y `X-Road-Client`, cabeceras de la política, cabeceras falsas del consumidor, truco de ruta, llamada negada. Además, 3 tests de política, el registro con y sin miembro, y un e2e del operador y del publicador.
    - Pendiente de confirmar con un Security Server real (piloto): que las `X-DEN-*` llegan intactas al sistema del proveedor (S-5).
    - Despliegue: `DEN_XROAD_SECURITY_SERVER_URL`, `DEN_XROAD_CLIENT` y `DEN_XROAD_SECURITY_SERVER_CA` (archivo PEM).
- [x] **M4-06 — Validaciones al enviar a revisión**: healthcheck a través del gateway y prueba de contrato con Schemathesis en sandbox; resultados adjuntos a la revisión.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §4.1`.
    - La versión declara un **upstream de sandbox** opcional, con datos sintéticos (nodo o URL, mismos controles que el upstream). Lo usan la prueba de contrato y, en M4-08, las aplicaciones sandbox.
    - Mientras la versión está en revisión, el reconciliador mantiene dos rutas de verificación estrechas, detrás de `DEN_VALIDATION_TOKEN`: GET a la raíz del servicio real (conectividad, nunca datos) y la ruta del sandbox para Schemathesis.
    - Al enviar a revisión se encola `version.validate`: healthcheck por el gateway (pasa con cualquier respuesta que no sea 5xx) y prueba de contrato con Schemathesis 4 (`infra/contract-runner`, contenedor con API interno).
    - Interpretación de "bloqueantes": la versión entra a revisión enseguida y las validaciones corren en segundo plano. El operador solo aprueba con validaciones superadas (409 si no). El proveedor las repite después de corregir. Sin sandbox, la prueba de contrato se omite y no bloquea.
    - Privacidad: de Schemathesis solo se guardan el nombre de la operación, los códigos de verificación fallidos y el código HTTP, nunca cuerpos ni comandos `curl` (regla 2). El runner descarta su informe.
    - La primera corrida encontró un bug real del proveedor de prueba de salud: un cuerpo que no es JSON daba 500 en lugar de 400. Se corrigió.
    - Web: resultados en la ficha de la versión (proveedor y revisor), botón "Repetir validaciones" y campos del sandbox en el formulario.
    - Pruebas contra APISIX real: rutas de verificación (solo con el token; la real, solo GET a la raíz), healthcheck, prueba de contrato con el runner, borrado al salir de revisión, y el bloqueo de la aprobación. Las pruebas de integración del resto del API corren con `DEN_VERSION_VALIDATION=off`.
    - Despliegue: servicio `contract-runner` y variables `DEN_VALIDATION_TOKEN`, `DEN_GATEWAY_INTERNAL_URL`, `DEN_CONTRACT_RUNNER_URL`, `DEN_CONTRACT_RUNNER_TOKEN` y `DEN_CONTRACT_RUNNER_GATEWAY_URL`.
- [x] **M4-07 — Lista de preparación del bootcamp**: por entidad, checklist de prerrequisitos (servidor, usuario de solo lectura, salida 443, responsables designados, caso de uso) con estado visible para el operador.
  - _Notas de implementación:_
    - Cinco requisitos por entidad. "Responsables designados" se calcula: está listo cuando la entidad tiene miembros activos con `api_publisher` y `data_steward`. Los otros cuatro los marca el `entity_admin`, o el `platform_admin` en el bootcamp, con una nota opcional para el operador (nunca contraseñas). Cada cambio queda auditado (`bootcamp.item_updated`).
    - Ven la lista los miembros, el revisor y el regulador (`bootcamp.read`). La consola del operador muestra el avance de cada entidad activa y lo que falta, las menos avanzadas primero (`bootcamp.list`).
    - Interpretación: los requisitos son del kit, no de un país, así que viven en el código y sus textos en i18n.
    - Web: "Mi entidad → Preparación del bootcamp" y "Consola del operador → Preparación del bootcamp".
- [x] **M4-08 — Modo sandbox**: aplicaciones sandbox con aprobación automática hacia upstreams de prueba.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §4.1`.
    - El upstream de prueba es el `sandboxUpstream` que la versión declara (M4-06). El gateway lo sirve en `/sandbox{basePath}` con la misma cadena de plugins, sin el registro de transparencia: los datos son sintéticos.
    - Una aplicación sandbox solo pide acceso a versiones con sandbox (400 si no). Con `features.sandbox.autoApprove` su solicitud se aprueba al crearse, sin el responsable de datos ni el regulador. La decisión es del sistema (`subscription.approved` con `autoApproved`) y se activa con el siguiente bundle.
    - La separación vive en OPA: la suscripción de una aplicación sandbox apunta a la ruta del sandbox, y la política niega con `environment_mismatch` cruzar de un lado al otro (3 tests de política).
    - La suscripción de una aplicación sandbox muestra la ruta `/sandbox/…`, y el catálogo, la URL del sandbox de cada versión.
    - e2e: el cierre de M4 (`bootcamp-closing.spec.ts`) consume una API del nodo en sandbox: aprobada al instante, llamada por el túnel del nodo, y negada en la ruta real.
- [x] **M4-09 — Ficha del servicio imprimible**: vista e impresión/PDF desde el navegador.
  - _Notas de implementación:_
    - Página `/catalog/{api}/sheet/{versión}`, enlazada desde cada versión del catálogo. Muestra:
      - proveedor, responsable, sector, clasificación, estado y fechas;
      - estado del nodo;
      - URL en el gateway y del sandbox;
      - finalidades, límite y base legal;
      - datos expuestos (personales y sensibles);
      - operaciones con su titular;
      - descripción.
    - Sale de los datos del catálogo, así que nunca muestra nada del upstream y respeta quién puede ver la API.
    - Interpretación: el PDF lo hace el navegador ("Imprimir o guardar como PDF"), sin generar PDFs en el servidor. Los estilos de impresión ocultan el encabezado, el pie y el botón, y evitan cortar las tarjetas.
    - El nivel de servicio (SLA) de `SPEC.md §3` todavía no se captura en el formulario de versión: la ficha lo mostrará cuando exista.
    - e2e: ficha desde el catálogo, axe, emulación de impresión y PDF de Chromium.

**Cierre M4:** simulación de bootcamp: una entidad nueva enrola un nodo, publica una API instantánea y otra entidad la consume en sandbox el mismo día.

- _Hecho (`apps/web/e2e/bootcamp-closing.spec.ts`, verde, 1,2 min):_
  1. el operador registra una entidad nueva;
  2. su administradora crea su cuenta, acepta y toma el rol de publicación;
  3. emite el token del nodo, y el nodo simulado se enrola, se une al hub y queda en línea;
  4. publica una API sobre el nodo, con sandbox en el mismo nodo;
  5. las validaciones pasan (healthcheck por el hub, Schemathesis en el sandbox) y el operador la aprueba;
  6. `carlos.dev`, de otra entidad, la pide con una aplicación sandbox: se aprueba al instante y se activa;
  7. la llamada con mTLS y token ligado pasa por el túnel del nodo, y la misma aplicación es negada en la ruta real (`environment_mismatch`).

---

## M5 — Uso, indicadores y observabilidad

- [x] **M5-01 — Pipeline de logs**: `http-logger` con el formato de `ARCHITECTURE.md §8` → Fluent Bit con filtro de lista permitida → OpenSearch. Test que verifica que ningún documento indexado contiene la ruta real ni query.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §8`.
    - **Fluent Bit.** Además de la lista permitida, da tipos a los campos (enteros, latencias en ms) y comprueba la forma de cada valor. Con eso un cliente no mete un número de identificación por `X-DEN-Purpose` o `X-Request-Id`.
    - **Llamadas negadas.** OPA nombra al consumidor conocido en su respuesta, y el log las atribuye a la aplicación (lo necesita M5-03). `den-header-guard` quita las cabeceras `X-DEN-*` que manda un proveedor, y Fluent Bit ignora una razón de negación si hubo upstream.
    - **OpenSearch.** El API mantiene la plantilla `den-access` (tipada, `dynamic: strict`) y la retención ISM desde `retention.accessLogMonths`, como un reconciliador más (`sync_state`).
    - **Error log de nginx** (lo pendiente de §8). Va por syslog a `fluent-bit-errors`, que enmascara la línea de la petición, la URI del upstream y los números.
    - **Pruebas.** Cubren el filtro en un Fluent Bit real (`tests/infra`), el pipeline completo con la llamada permitida y la negada (`apps/api/src/analytics/access-log.int.test.ts`: ningún documento tiene la ruta, la query ni el número) y el error enmascarado.
- [x] **M5-02 — Uso para proveedores**: llamadas por consumidor, finalidad, operación, códigos de respuesta, latencia; filtros por fecha.
  - _Notas de implementación:_ endpoint `GET /entities/:id/usage/provided?from&to&apiId&environment`, con el permiso `usage.provided.read` (los mismos roles que la bandeja de solicitudes, más el operador y el regulador). Pantalla `/my-apis/usage`.
    - **Contenido.** Totales: exitosas, negadas por el gateway, errores 4xx/5xx y latencia p50/p95. Llamadas por día, en la zona del país. Desgloses por entidad consumidora, finalidad, operación (con p95) y código.
    - **Sandbox aparte.** El tráfico del sandbox se ve por separado: es otra ruta.
    - **Interpretación.** "Latencia" es la del gateway (`latency_ms`); la del proveedor queda en el log (`upstream_latency_ms`) para M5-04. Una llamada sin consumidor identificable (401) aparece como "sin identificar".
- [x] **M5-03 — Uso para consumidores**: llamadas por aplicación y API, errores de autorización con su razón.
  - _Notas de implementación:_ endpoint `GET /entities/:id/usage/consumed?from&to&applicationId`, con el permiso `usage.consumed.read` (cualquier miembro, más el operador y el regulador). Pantalla `/my-apps/usage`.
    - **Alcance.** Se acota a los `clientId` de las aplicaciones de la entidad. Por API muestra la versión, la entidad proveedora y si fue el sandbox.
    - **Negaciones.** Cada negación del gateway aparece con su razón estable y su aplicación: OPA nombra al cliente conocido en la negación (M5-01). Ahora también el 429 de `den-rate-limited` lleva `rate_limited`.
    - **Sin atribuir.** Una llamada con un token que no se pudo ligar a una aplicación (401) no es de nadie, y la pantalla lo dice.
- [x] **M5-04 — Indicadores de la red**: los de `SPEC.md §8` para regulador y operador.
  - _Notas de implementación:_ endpoint `GET /network/indicators?from&to`, con el permiso `network.indicators.read` (`platform_admin`, `platform_reviewer`, `regulator`). Pantalla `/regulator/indicators`, enlazada desde las consolas del regulador y del operador.
    - **Fuentes.** Las llamadas salen de OpenSearch, y solo cuentan las rutas de producción (sin sandbox ni verificaciones). El resto sale del portal y de Prometheus.
    - **Consultas exitosas.** Es 2xx sobre las llamadas sin los 401/403, que se reportan aparte con su razón.
    - **APIs con consumo real.** Publicadas con al menos un 2xx de producción en el periodo.
    - **Tiempo a la primera API en uso.** Va del enrolamiento del primer nodo (si fue antes de la primera llamada exitosa, el camino del kit) o del alta de la entidad, hasta ese primer 2xx, dentro de la retención de los logs.
    - **Entidades conectadas por mes.** Se cuentan por el primer `publishedAt`, en la zona del país, en los últimos 12 meses.
    - **Tiempo de aprobación.** Mediana de horas entre la solicitud y la primera decisión `approved`/`rejected` de una persona, según la auditoría. Las aprobaciones automáticas del sandbox no cuentan.
    - **Disponibilidad.** `avg_over_time(up{job="apisix"})` en Prometheus (`DEN_PROMETHEUS_URL`); sin Prometheus, "sin datos". La provee M5-06.
    - **Pasos manuales evitados.** Es un campo nuevo del caso de uso del bootcamp (`manualStepsAvoided`, migración `20261208000000`), que el indicador suma.
- [x] **M5-05 — Mapa de intercambios**: grafo entidad consumidora → entidad proveedora con volumen.
  - _Notas de implementación:_ endpoint `GET /network/exchanges?from&to`, con el permiso `network.map.read` (los mismos roles que los indicadores). Pantalla `/regulator/exchange-map`, enlazada desde los indicadores.
    - **Aristas.** Salen de las llamadas de producción del periodo (entidad consumidora del log, entidad proveedora de la versión de la ruta). Se unen con las suscripciones activas de aplicaciones de producción: un intercambio acordado sin llamadas también aparece, con volumen 0.
    - **Gráfico.** Grafo bipartito con las consumidoras a la izquierda y las proveedoras a la derecha. El grosor es el volumen (escala de raíz, un solo tono) y lo acordado sin llamadas va en línea punteada gris, con leyenda. Cada enlace tiene tooltip con mouse y teclado, y debajo va la tabla con todos los valores.
- [x] **M5-06 — Métricas y alertas**: Prometheus + Alertmanager con las alertas de `ARCHITECTURE.md §9`; Grafana con un tablero de operador.
  - _Notas de implementación:_ detalle en `ARCHITECTURE.md §9` y `DEPLOYMENT.md §3.8.1`.
    - **Métricas del API.** `GET /metrics`, fuera de `/api/v1` y solo con `DEN_METRICS_TOKEN`, con `prom-client` (Apache-2.0). Publica la latencia por plantilla de ruta y lee de PostgreSQL en cada recolección la cola, `sync_state`, el atraso del bundle de OPA, los nodos y el vencimiento más próximo de certificados. OPA publica el estado de sus bundles (`status.prometheus`).
    - **Alertas.** Son las nueve de §9, con `promtool test rules` (cada una se dispara con su serie y ninguna con las sanas) en CI y en `tests/infra`.
    - **Alertmanager** avisa por correo al operador. Comprobado de punta a punta: `DenNodeOffline` llegó a Mailpit con los nodos fuera de línea del entorno de desarrollo.
    - **Grafana** tiene un tablero de operador aprovisionado desde archivo, con colores por umbral de alerta.
    - **Indicadores.** La disponibilidad del gateway de M5-04 sale de Prometheus (`DEN_PROMETHEUS_URL`).
- [x] **M5-07 — Consola de sincronización**: estado de `sync_state`, deriva detectada, reintento manual.
  - _Notas de implementación:_ `GET /admin/sync?system&status&q&cursor` (`sync.read`: `platform_admin`, `platform_reviewer`) y `POST /admin/sync/retry` (`sync.retry`: `platform_admin`). Pantalla `/operator/sync`.
    - **Deriva.** Es una escritura con el estado deseado ya aplicado; el detalle está en `ARCHITECTURE.md §4`. Columnas nuevas `drift_detected_at` y `drift_count` (migración `20261209000000`). Hoy la detectan APISIX (versiones) y Keycloak (clientes).
    - **Reintento.** Encola el trabajo del reconciliador dueño del objetivo y emite el evento de auditoría `sync.retry_requested`. OpenSearch tiene su propio tema (`opensearch.sync`).
    - **Filtro.** El filtro por defecto es "con problemas": no sincronizado, o con deriva en las últimas 24 horas.
- [x] **M5-08 — Guía de integración ampliada**: snippets curl, Java, Python, C#, Node con mTLS + token + cabeceras DEN.
  - _Notas de implementación:_
    - **Programas.** En la página de cada aplicación hay un programa completo por lenguaje, en pestañas accesibles, cada una con su nombre de archivo y un botón de copiar. Cada uno pide el token con `client_credentials` y llama a la API con `X-DEN-Purpose` y `X-DEN-End-User`. Con mTLS presentan el certificado de la aplicación y confían en la CA de la red. El secreto se lee de `DEN_CLIENT_SECRET`, nunca del código.
    - **Dependencias.** Ninguna fuera de la plataforma: Node usa `undici`, Python usa `requests` y Java parsea el token con un patrón.
    - **Prueba.** El e2e `guide.spec.ts` copia los cinco programas de la página y los ejecuta contra el gateway real con una suscripción activa. curl corre en un contenedor con OpenSSL, porque el curl de Windows (Schannel) no toma `--cert`/`--key`; la guía lo advierte.

**Cierre M5:** el regulador ve los indicadores de un mes simulado (generador de tráfico sintético).

- _Hecho (`apps/web/e2e/closing-m5.spec.ts`, verde):_
  1. `pnpm traffic:simulate` genera octubre de 2025 para las suscripciones activas de la red, bajo una etiqueta propia;
  2. el regulador ve los indicadores del mes: consultas exitosas (entre 90 % y 100 %), APIs con consumo real, las negaciones por razón y el mapa de intercambios, con axe sin violaciones;
  3. la responsable de datos de salud ve quién consume sus APIs ese mes, y el desarrollador de programas sociales ve las negaciones de sus aplicaciones con su razón;
  4. la etiqueta se borra al terminar.
- Disponibilidad del gateway: "sin datos" hasta que Prometheus (M5-06) lleve tiempo midiendo. El generador no la simula.

---

## M6 — Endurecimiento y producción

- [x] **SPIKE S-6 — Aserción firmada del gateway hacia el proveedor**
  - _Resultado:_ `docs/spikes/S-6.md` y ADR-0024. JWS ES256 por llamada en `X-DEN-Assertion`, firmado por el plugin `den-assertion` después de OPA y ligado a la petición (método y hash de la URI, `aud` = proveedor, `jti` = request id). La clave va en la metadata del plugin, cifrada en etcd. El prototipo pasa 13 de 13 verificaciones: firma, claims, cabecera falsa del cliente, alteración, repetición, otro proveedor, rotación y falla cerrada sin clave. La implementación es M6-10.
- [x] **M6-01 — Revisión ASVS L2** con lista de verificación y correcciones. Incluye:
  - el filtrado de salida del gateway por red (RFC 1918, link-local y subredes de la plataforma), pendiente de la revisión de seguridad de M1-08;
  - un `data_encryption.keyring` propio de APISIX por despliegue (S-6: el de fábrica es público, y con él se cifran en etcd las claves TLS y la de las aserciones);
  - la paginación de la cola de solicitudes de alta del operador (hoy solo muestra las 200 más antiguas).
  - _Notas de implementación:_ lista de verificación por capítulo en `docs/security/ASVS-L2.md`.
    - **Corregido:**
      - límites de peticiones en el API (por token o dirección, cuota estricta en rutas costosas) y en el proxy;
      - verificación del token antes de recibir una subida;
      - cabeceras de seguridad del API;
      - eventos `request_refused` y eventos de Keycloak;
      - política de contraseñas y URIs OIDC exactas;
      - segmentación en redes `gateway`/`providers`/`default`, que cubre el filtrado de salida del gateway;
      - keyring propio de APISIX;
      - solo los plugins que usa el portal;
      - `pnpm audit` en CI con plazos de corrección;
      - etiqueta GCM completa;
      - cola del operador paginada.
    - **Queda para M6-05:** TLS y autenticación entre componentes internos, Keycloak en modo producción, bóveda de secretos, SBOM y logs del API en el pipeline central.
    - **Antivirus:** M6-08.
    - **Decisión pendiente del operador:** segundo factor para `entity_admin` y `api_publisher` (ASVS 6.3.3).
- [x] **M6-02 — Auditoría de accesibilidad** WCAG 2.1 AA de todas las pantallas.
  - _Notas de implementación:_ resultado y estado por criterio en `docs/accessibility/WCAG-2.1-AA.md`.
    - **Revisión automatizada** (`apps/web/e2e/accessibility.spec.ts`): las 42 pantallas en español e inglés, cada una con el rol que más ve de ella. Por pantalla:
      - axe;
      - idioma, título y un solo `h1`;
      - enlace para saltar al contenido y foco visible;
      - espaciado de texto (1.4.12);
      - reflujo a 320 px (1.4.10).
      Una prueba falla si una página nueva no está en el recorrido. También cubre el aviso de sesión y las páginas de Keycloak.
    - **Corregido:**
      - errores del API en el idioma del usuario (ADR-0025);
      - aviso antes de que la sesión termine por inactividad (2.2.1);
      - reflujo del encabezado, las tablas, el formulario de solicitud y los gráficos;
      - un solo `h1` con Scalar;
      - Escape en los tooltips;
      - estado de la solicitud como región viva;
      - espaciado de texto en los gráficos y en Scalar.
    - **Fuera de la automatización:** prueba con lectores de pantalla (NVDA, VoiceOver) y con usuarios, como recomendación para el operador antes de producción.
- [ ] **M6-03 — Prueba de carga** con k6: 500 peticiones/s sostenidas, p95 agregado por el gateway < 50 ms.
  - _Avance (2026-11-16):_ resultados en `docs/performance/M6-03.md`.
    - **Hecho:**
      - `pnpm load:seed`: la red a la escala de SPEC §9, sintética y auditada;
      - `pnpm load:test`: k6 en su contenedor por la cadena completa con mTLS, más la latencia de APISIX leída en Prometheus.
    - **Corregido:**
      - la activación de suscripciones en lotes (no terminaba con miles pendientes);
      - el gateway consulta solo `den/authz/decision` (el p95 de OPA baja de 18,7 a 4,4 ms);
      - 64 conexiones a OPA por worker (había miles en TIME_WAIT);
      - `DEN_DEV_NODES` con prefijo.
    - **Resultado en la máquina de desarrollo:** pasa a 200/s (p95 del gateway 13,3 ms). A 500/s la CPU del equipo llega al 100 %, porque el generador comparte la máquina con todo el stack.
    - **Falta:** validar 500/s en el entorno tipo producción del cierre de M6, con el generador en otra máquina.
- [x] **M6-04 — Resiliencia**: con el portal caído, el tráfico sigue; con OPA sin bundle nuevo, se mantiene el último; test documentado.
  - _Notas de implementación:_ `pnpm resilience:test` y resultado en `docs/performance/M6-04.md`.
    - Con el portal caído durante 45 s: las llamadas permitidas y las negadas siguen, cada una como debe.
    - OPA y APISIX reinician sin el portal.
    - Al volver el portal, el registro de transparencia tiene todas las consultas de la caída y una revocación llega en 18 s.
    - **Corregido:** OPA guarda el último bundle en disco (volumen `opa-data`, `persist: true`). Antes, un OPA reiniciado sin el portal quedaba sin política y el gateway lo negaba todo.
- [ ] **M6-05 — Helm charts** para producción con la topología de `ARCHITECTURE.md §11`.
  - _Avance (2026-11-16):_ `infra/helm/den-platform` y `infra/helm/den`, en `DEPLOYMENT.md §9`. Completos y validados de forma estática con `helm lint`, `helm template` y kubeconform estricto (116 recursos). Sin instalar en ningún clúster por ahora, por decisión del equipo. Por eso la historia sigue abierta.
    - **Hecho:**
      - portal, gateway (APISIX con OPA local en el loopback y los Fluent Bit por pod), etcd de 3 miembros con mTLS y CA propia, Keycloak en modo producción con base propia, PostgreSQL con réplica (CloudNativePG, `verify-full`), step-ca con raíz fuera de línea, hub y runner;
      - OpenSearch con TLS y su plugin de seguridad, y Prometheus, Alertmanager y Grafana como subcharts;
      - PKI interna con cert-manager;
      - secretos por componente desde External Secrets con OpenBao;
      - NetworkPolicies de entrada y de salida, e ingress con Traefik;
      - realms de producción sin usuarios de demostración;
      - el primer `platform_admin` sin seed (`DEN_BOOTSTRAP_ADMIN_EMAIL`);
      - imágenes de producción del API y la web (816 MB y 1,33 GB, antes 2,9 y 3,2 GB), sin dependencias de desarrollo ni gestor de paquetes; `images.yml` las construye con SBOM, las escanea con Trivy y las publica con una etiqueta. Las cuatro pasan el escaneo en local;
      - logs del API enmascarados y en JSON para el colector del clúster (ASVS 16.4.3).
    - **Falta:**
      - instalarlo: kind con `pnpm helm:kind`, y luego el entorno del operador, con una restauración de Barman Cloud desde su almacenamiento (M6-06).
    - **Imágenes publicadas (2026-11-17):** `v0.1.0` en ghcr.io (API, web, hub y runner), escaneadas y con SBOM; el CI vuelve a estar en verde.
    - **Para M6-06:** CloudNativePG respalda con Barman, no con pgBackRest. El operador de pgBackRest (Crunchy) distribuye sus imágenes con términos no OSI, así que hace falta un ADR.
- [x] **M6-06 — Respaldos y recuperación**: pgBackRest, procedimiento de restauración probado.
  - _Hecho (2026-11-16):_ ADR-0026, con dos herramientas, una por topología:
    - **Compose (piloto): pgBackRest.** Archivado continuo del WAL (como mucho 5 minutos de pérdida) a un repositorio cifrado. El servicio `pgbackrest` toma un respaldo completo por semana y uno diferencial por día, y conserva cuatro semanas. Se restaura con `install.sh restore [instante]`. `pnpm restore:test`, también en CI, prueba la pérdida del volumen, la recuperación a un instante, el respaldo posterior y el repositorio ilegible sin su clave.
    - **Kubernetes: Barman Cloud**, el plugin oficial de CloudNativePG, en `den-platform`. Lleva las dos bases al almacenamiento S3-compatible del operador, con 30 días de retención. Validado solo de forma estática; su restauración se prueba al instalar el chart (M6-05).
    - Procedimientos en `OPERATIONS.md §6`. Un piloto existente necesita `PGBACKREST_REPO1_CIPHER_PASS`: `install.sh` la genera si falta (`DEPLOYMENT.md §5.4`).
- [x] **M6-07 — Runbook del operador**: alta de entidad, incidentes, rotación de la CA intermedia, revocación masiva.
  - _Hecho (2026-11-16):_ `docs/RUNBOOK.md`.
    - **Alta de entidad:** revisión de la solicitud y alta directa; los pasos después del alta, hasta la primera API publicada; suspensión y baja.
    - **Incidentes:** procedimiento general con severidades, y un playbook por caso: clave de una aplicación filtrada, entidad, cuenta o nodo comprometido, datos personales en un log, gateway o portal caído, bitácora alterada, base dañada, intermedia comprometida, nodos del gateway agregados o quitados.
    - **Rotación de la CA intermedia:** planificada en el piloto, con los comandos probados contra un step-ca desechable, y en Kubernetes, donde step-ca toma ahora la PKI del Secret en cada arranque; y la emergencia, con lo que la lista de huellas cubre y lo que no.
    - **Revocación masiva (herramienta nueva):** `platform_admin` con segundo factor, en Consola → Revocación masiva de certificados y por API. Filtra por entidad, por fecha de emisión y por intermedia, con vista previa. Revoca solo si el conjunto no cambió desde la vista previa (`expectedCount`, 409 si no). Audita cada certificado y la revocación entera, avisa a los desarrolladores (aviso de seguridad) y hace una sola sincronización de OPA. Pruebas de integración con step-ca real (autorización, filtros, conteo desactualizado, auditoría, OPA, avisos) y axe en la pantalla.
    - De paso, el chart fija `DEN_GATEWAY_NODES` desde `gateway.replicas`: con dos réplicas, cada nodo permitía el límite completo de la suscripción (ADR-0020).
    - Interpretación: "emitido" es cuando el portal emitió el certificado (`createdAt`), no su `notBefore`, que step-ca adelanta un minuto.
- [x] **M6-08 — Antivirus de documentos** (ClamAV) y catálogo público opcional.
  - _Hecho (2026-11-16):_
    - **Antivirus.** Con `DEN_CLAMAV_URL`, el API manda cada documento a `clamd` por el protocolo INSTREAM, después de comprobar que es un PDF y antes de guardarlo, sin dependencias nuevas.
      - Uno infectado se rechaza como error del campo (`document_infected`, traducido); el log guarda la firma y el SHA-256, nunca el nombre ni el contenido.
      - Si ClamAV no responde, la subida falla con 503 (falla cerrada).
      - Compose: perfil `antivirus` (`clamav/clamav:1.5.4`), que `install.sh` pregunta. Helm: activado con dos réplicas, sin root y con el sistema de archivos de solo lectura (probado con Docker), y NetworkPolicy: solo el API entra; sale solo a HTTPS público (firmas).
      - Pruebas: el cliente contra un clamd falso (limpio, infectado, error, puerto cerrado, sin respuesta) y la subida con transacción real (sin fila ni archivo si está infectado; 503 sin antivirus). Verificado contra un clamd real: PDF limpios pasan y EICAR se detecta. Un clamd real solo marca EICAR al inicio del archivo, y la comprobación de PDF lo rechaza antes.
    - **Catálogo público.** Ya existía detrás de `features.publicCatalog` (solo APIs `public` para anónimos). Ahora el anónimo no ve el contacto del responsable ni el estado de los nodos. Probado con el flag activado (una copia de `co.yaml`): lista, detalle, OpenAPI y token inválido.
- [x] **M6-09 — Inglés completo** y plantilla `example.yaml` probada levantando un "país de ejemplo".
  - _Hecho (2026-11-17):_
    - **Inglés.** Los catálogos de la web tienen las mismas 1264 claves en los dos idiomas; los 34 textos iguales son legítimos ("API", "Sector", "Client ID"). Los correos del API y la carpeta ciudadana ya eran bilingües y eligen el idioma por el locale del país.
      - Interpretación: el idioma por omisión de la web sigue siendo el español (regla 7). Para un país angloparlante se cambia `defaultLocale` en `apps/web/src/i18n/routing.ts`, junto con las URL de cierre de sesión del realm (`DEPLOYMENT.md §10`).
    - **País de ejemplo.** `pnpm example:country`:
      - convierte `example.yaml` en el país XX;
      - levanta un stack propio (`denxx`, puertos + 10000) sin tocar el de desarrollo;
      - arranca el portal con XX y comprueba la web en los dos idiomas con su marca;
      - corre la demo de punta a punta: 12 pasos en verde, con el sector, las finalidades y el tipo de documento de XX, y con la aserción firmada (M6-10) verificada por el proveedor.
    - **La demo ya no supone Colombia:** toma el sector, las finalidades y el tipo de documento de la configuración del país, y el contenedor del mock del proyecto Compose.
    - **Lo que encontró la prueba, corregido:**
      - la contraseña de demo por omisión (`demo`) incumplía la política del realm de M6-01 (12 caracteres): un entorno nuevo desde `.env.example` no podía importar el realm. Ahora es `den-demo-password`, y `install.sh` y `make-deploy-env` rechazan una más corta;
      - el realm `den-citizens` limitaba el tipo de documento a 10 caracteres (`NATIONAL_ID` tiene 11): ahora 32, el mismo tope que impone el esquema de la configuración;
      - una prueba de la configuración seguía esperando mTLS apagado en `co.yaml` desde M3-10.
- [x] **M6-10 — Aserción firmada del gateway (ADR-0024)**. Clave generada y rotada por el portal y empujada por el reconciliador a la metadata de `den-assertion`. JWKS público. Activación por configuración del país. `body_sha256` en operaciones con cuerpo. Verificación en los mocks y guía del proveedor.
  - _Hecho (2026-11-17):_
    - **Activación:** `features.gatewayAssertion` (activada en `co.yaml` y en `example.yaml`, apagada por omisión).
    - **Clave:** EC P-256 en `gateway_signing_key`, sellada con `DEN_SECRETS_KEY`, creada al primer uso y rotada cada `lifecycle.assertionKeyRotationDays` (90). Rotación inmediata del operador: `POST /admin/gateway-signing-keys/rotate`, `platform_admin`; con `compromised`, la anterior sale del JWKS. Cada clave nueva queda en la bitácora (`gateway_signing_key.created`).
    - **Reconciliador:** pone la clave en la metadata de `den-assertion` antes que las rutas, compara por emisor y `kid` (APISIX la guarda cifrada), la quita si el país apaga la aserción, y agrega el plugin a las rutas de las versiones servidas con `audience` = la entidad proveedora.
    - **JWKS público** en `GET /api/v1/gateway/jwks`: todas las claves usadas salvo las comprometidas, para que lo archivado siga verificando.
    - **Plugin:** `body_sha256` en POST, PUT y PATCH; un cuerpo mayor que `max_body_bytes` da 413 en vez de firmarse sin él.
    - **Mocks:** verifican como un proveedor real (Node, sin librerías), registran el resultado y pueden exigirla (`MOCK_ASSERTION_REQUIRED`). La demo comprueba que el proveedor la verificó.
    - **Guía del proveedor:** `docs/guias/entidades.md` §3.2, con ejemplos en Node.js y Python.
    - **Pruebas:**
      - de integración contra el APISIX real: firma ligada a la URI y al cuerpo, aserción del cliente descartada, rotación, clave comprometida fuera del JWKS, autorización y falla cerrada sin clave;
      - del verificador del mock: URI, cuerpo, `aud`, vencimiento, método y firma alterados;
      - unitarias del reconciliador y del estado deseado.

- [x] **M6-11 — Listas del operador sin tope oculto.** La cola de revisión de versiones (`GET /review/api-versions`, 200 más antiguas) y la lista de entidades de la consola (`GET /admin/entities`, 500 por nombre) se cortan sin avisar. Una red nacional puede pasar las 500 entidades. Paginación por cursor, como la cola de altas (M6-01, ASVS corrección 13).
  - _Origen (2026-11-17):_ la base de pruebas acumulada hizo fallar dos pruebas de integración que buscaban un elemento nuevo en esas listas.
  - _Hecho (2026-11-17):_
    - **API.**
      - La cola de revisión pagina por cursor, de la más antigua a la más nueva (`limit` 50, máximo 200).
      - La lista de entidades pagina por nombre (`limit` 100, máximo 500) y busca con `q` en el nombre corto, la razón social y el identificador.
      - Suspender, reactivar y dar de baja responden con la entidad, no con la lista entera.
    - **Consola.**
      - "Ver las siguientes" en la cola de revisión, y búsqueda con páginas en Entidades.
      - En Documentos, el filtro de entidad se acota con una búsqueda y avisa si la lista está cortada.
      - En Revocación masiva, el selector ofrece las entidades con certificados vigentes.
    - **Pruebas:** paginación sin repetir elementos, búsqueda por identificador y la cola recorrida por páginas.
- [x] **M6-12 — Rotación de `DEN_SECRETS_KEY`** (ASVS 11.1, el último pendiente de la revisión de M6-01).
  - _Hecho (2026-11-17):_
    - **Formato:** cada valor sellado nombra la clave que lo selló (`v2.<kid>…`, `kid` derivado de la clave).
    - **Claves anteriores:** `DEN_SECRETS_KEYS_PREVIOUS` (separadas por comas) sigue abriendo lo que sellaron, incluidos los valores `v1` sin identificador.
    - **Resellado:** `secrets:reseal` (`node dist/secrets/main.js` en la imagen) sella de nuevo con la actual los secretos de cliente pendientes, las claves de los certificados del gateway y las de las aserciones. Es idempotente, no toca lo que cambió mientras corría, se detiene sin perder nada si una clave falta y deja `secrets.resealed` en la bitácora.
    - **Procedimiento:** en `OPERATIONS.md §5.6`.
    - **Pruebas:** unitarias del formato y de las claves, y de integración del resellado completo con la clave anterior retirada después.

**Cierre M6:** despliegue en un entorno tipo producción del operador con las pruebas de M6-03 y M6-04 en verde.
  - _Estado (2026-11-17):_ M6-01, M6-02, M6-04 y M6-06 a M6-10 hechas. M6-11 también. Quedan abiertas M6-03 (la prueba de carga, en el entorno tipo producción) y M6-05 (instalar el chart), que dependen de ese entorno.

---

## P — Pilot follow-ups (found in the 2026-11-18 rehearsal)

Stories that came out of rehearsing the full onboarding by hand on the demo network, with accounts created from scratch.

- [x] **P-01 — Platform roles from the server's command line**
  - No screen grants platform roles, so a real operator could only use the seed's demo personas.
  - `./install.sh platform-role grant|revoke <email> <role> [--reason]` and `list` (in other deployments, `node dist/admin/platform-roles-cli.js` in the API container). The person registers, verifies the address and signs in once first.
  - Audited in the same transaction as the command-line actor (`platform_role.granted`, new `platform_role.revoked`). Refuses an address with no account, a disabled account, a role that is not a platform role, and revoking the last `platform_admin`.
  - _Not done:_ a console screen to grant and revoke platform roles (with MFA and audit); the command covers the pilot until then.
  - _Deployment:_ in the repository (53e2fea), not in the demo VPS's image yet; there it runs from a temporary one-off container (`/root/den-admin-cli/platform-role.sh`) until the next redeploy.
- [ ] **P-02 — Warn when a node serves a contract other than the published one**
  - Today the node sends the SHA-256 of each service's OpenAPI in every heartbeat (`services[].openapiSha256`) and the portal stores it, but nothing compares it with the published version's `openapiSha256`. If an entity changes its API without publishing a new version, nobody notices.
  - The portal compares, per published version with a `node` upstream, the hash the node reports for the service on that `servicePath` with the version's hash, and shows the result where the entity and the operator look: the version sheet (publisher, reviewer), the node page (entity admin) and the operator's sync console.
  - States: matches · differs (warning, with both hashes and since when) · not reported (the service has no OpenAPI on the node: the node's logs show `(unknown)` routes; a hint to add it).
  - On a change from "matches" to "differs", a notification to the entity's `api_publisher` and `entity_admin`, and an audit event. It never blocks traffic: the gateway keeps routing by the published contract.
  - Tests: comparison per service path, the three states, the notification on the transition only, authorization of each place it is shown (right role yes, others 403, another entity 404).
- [ ] **P-03 — The kit bundle from the portal: current version, checksum and how to install**
  - In _My entity → Kit nodes_, next to "Register a node": the kit's current version, its download link (the kit's GitHub Release), its size and SHA-256, and the exact commands to download, verify and install on the entity's server, with the portal's own URL filled in.
  - The operator sets the current version in the console (version, link, SHA-256, and the signature and `allowed_signers` once releases are signed, kit K5); audited. Shown to every member of a provider entity, and on the public site for entities that are not onboarded yet.
  - Optional mirror for entities whose servers can reach the portal but not GitHub: the operator uploads the bundle and the portal serves it under `/kit/<version>/`, anonymously (it holds nothing secret: the token is). The page then offers both links.
  - The checksum on the page is a convenience, not a guarantee: whoever controls the portal controls both the file and its checksum. The guarantee is the operator's signature with a key delivered through another channel; the page says so.
  - Tests: the version page per role (entity member yes, others per policy), the mirror's content type and caching, the console change audited, i18n in es and en, axe on the new screens.
- [ ] **P-04 — Providers come in through the node: upstream types allowed per country**
  - The kit's ADR-0001 and the entities guide say every provider connects through the node (or X-Road), but the portal still offers, stores and routes `direct` upstreams (an HTTPS API called without a node), and offers X-Road even where the deployment has no Security Server configured. In the rehearsal the labels misled too: "Existing API of the entity" reads as the right choice for any existing API, and "Node of the instant-APIs kit" as if the node only served instant APIs.
  - Country config `features.upstreams` (for example `[node, xroad]`), validated at startup; `direct` is opt-in per country. Nothing country-specific in code (rule 6).
  - The API enforces it (rule 3): creating or revising a version with an upstream type the country does not allow is a 400 with a problem code; `xroad` also needs the deployment's X-Road settings. The sandbox upstream follows the same rule.
  - The version form shows only the allowed types; with a single one (the node) it does not ask, it asks for the node and the service path. Labels: "Node of the entity (own API or instant API)", "Public API of the entity (HTTPS, no node)", "Service in X-Road".
  - Versions already published with a now-disallowed type keep working and are flagged to the operator (version sheet and sync console), who decides.
  - A portal ADR records the decision: the node is the default channel, why, and how a country enables `direct`.
  - Tests: config validation, 400 per disallowed type on create and revise, the form per configuration (one type, several), the flag on existing versions, authorization, i18n es/en, axe.
- [ ] **P-05 — A CSR command that works where people run it**
  - The command on the application page fails in Git Bash, the usual shell on Windows: MSYS turns `-subj "/CN=<client id>"` into `C:/Program Files/Git/CN=...`, OpenSSL rejects it, and the private key is left behind without its CSR.
  - Keep OpenSSL on the application's own server: the key is born where it is used and never travels. A key generated in the browser is easier but lands on someone's laptop and is exposed to any flaw in the portal, so it is not offered.
  - Tabs for Linux/macOS, Windows with Git Bash (`MSYS_NO_PATHCONV=1` prefix, harmless elsewhere) and Windows with PowerShell (OpenSSL path). Each one: `umask 077` (or the PowerShell equivalent) so the key is readable only by its owner, file names from the client ID, refusing to overwrite an existing key, and a check before pasting: `openssl req -in <file>.csr -noout -subject` shows `CN=<client id>`.
  - `scripts/entity-check.sh csr <client id>` already does all of this (fixed on 2026-11-18: it failed silently in Git Bash and left the key behind; now it passes `MSYS_NO_PATHCONV`, says why OpenSSL failed and removes a half-made key). The page offers it for download next to the commands.
  - Tests: the rendered commands per tab with a real client ID, run in CI on Linux; i18n es/en; axe on the page.
- [ ] **P-06 — The deployment `.env` sends uploaded documents to a folder the API cannot write**
  - Uploading the designation document of an onboarding request failed ("We could not complete the operation"; the API log says `EACCES: mkdir '/repo/apps/api/data'`). `scripts/make-deploy-env.mjs` copies `DEN_DOCUMENTS_DIR=data/documents` from `.env.example` (the development value) into the deployment's `.env`, and `env_file` overrides the image's `DEN_DOCUMENTS_DIR=/var/lib/den/documents`, where the `api-documents` volume is mounted. Every deployment made with `install.sh` or `make-deploy-env.mjs` has it, the operator's included.
  - Fix: the generator writes `/var/lib/den/documents` (or leaves the variable out so the image's value stands), `install.sh update` corrects an existing `.env`, and a test of the generator checks it. Until then: set the value in `.env` and recreate the API container (OPERATIONS.md).
  - Worked around on the demo VPS on 2026-11-18 (`.env` edited, backup in `/root/backups/env-before-docsdir-*`).
- [ ] **P-07 — Approving a version whose validations failed says so, and the failures say what to do**
  - The reviewer clicked approve, the API refused it (409) because the automatic validations had failed, and it read as approved. A healthcheck `504` was the gateway not reaching the node through the tunnel, but the sheet only said "server error".
  - Approve is disabled while the validations have not passed, with the reason next to it. Each failed check says what it means and what to try: 502/504 = the gateway cannot reach the node (check the node's status and tunnel); 404 on the service root is fine; a contract mismatch names the operations.
- [ ] **P-08 — Pilot accounts: the demo personas, and a verification link that lasts longer**
  - The pilot always loads the seed: the demo personas keep their platform roles with the installer's demo password. Offer, in `install.sh`, to disable them once the operator's own people have their roles (P-01), and say it in the operator guide.
  - The email verification link lasts 5 minutes (Keycloak's default `actionTokenGeneratedByUserLifespan`); two people in the rehearsal missed it. Set it in the realm (for example 60 minutes), for new realms and with the realm update script for existing ones.

