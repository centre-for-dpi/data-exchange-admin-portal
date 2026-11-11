# Backlog — Portal RID

Trabaja en orden. Un hito se cierra cuando todas sus historias están en `[x]` y su demo de cierre funciona. Las fechas son indicativas (calendario 2026–2027).

| Hito | Objetivo | Fechas indicativas |
| :-- | :-- | :-- |
| M0 | Fundaciones: monorepo, infraestructura local, configuración por país | 12–14 nov |
| M1 | **Flujo de punta a punta (demo de fin de noviembre)** | 17–28 nov |
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
- [ ] **M0-08 — Base del API**
  - Errores RFC 9457, `scopedRepo`, `AuditService` (aún sin cadena), tabla `outbox` y worker pg-boss vacío, OpenAPI del portal publicado en `/api/docs`.

**Cierre M0:** `pnpm infra:up && pnpm dev` muestra la web con login funcionando contra Keycloak.

---

## M1 — Flujo de punta a punta (demo fin de noviembre)

Meta: en la demo, una entidad publica una API, otra solicita acceso con finalidad, el proveedor aprueba y una llamada real pasa por APISIX; luego se revoca y la llamada falla en menos de 60 s.

- [ ] **SPIKE S-1 — Cabeceras de OPA visibles para otros plugins** (máx. 1 día)
  - Confirmar si las cabeceras de `send_headers_upstream` están disponibles para `limit-count` y `http-logger`, y cómo retirar `X-RID-End-User` en claro antes del upstream. Conclusión en `docs/spikes/S-1.md`. Si no, proponer alternativa (p. ej. `serverless-post-function` o plugin propio en Lua).
- [ ] **M1-01 — Modelo de datos base**
  - Prisma: Entity, User, Membership, Api, ApiVersion, Application, Credential, Subscription, Purpose, AuditEvent, Outbox, SyncState.
  - Seed: 3 entidades (proveedora de salud ficticia, proveedora socioeconómica ficticia, consumidora), usuarios por rol, catálogo de finalidades de `co.yaml`.
- [ ] **M1-02 — Sesión y contexto de entidad**
  - Login con Keycloak; el API resuelve usuario, roles de plataforma y membresías.
  - Selector de entidad activa en la UI; todo endpoint de entidad exige pertenencia (403/404 según `CLAUDE.md`).
- [ ] **M1-03 — Registrar API y versión**
  - `api_publisher` crea API y versión: subir OpenAPI 3.x (JSON/YAML), upstream `direct` o `node` (en M1, el nodo es el mock), campos expuestos, finalidades permitidas, clasificación.
  - Lint con Spectral (reglas mínimas: `operationId`, respuestas definidas); errores visibles por línea.
  - Estados `draft → in_review`.
- [ ] **M1-04 — Revisión y publicación**
  - `platform_reviewer` aprueba o pide cambios con comentario; al aprobar → `published` (el paso del regulador llega en M2).
  - Publicar encola la reconciliación del gateway.
- [ ] **M1-05 — Catálogo y detalle**
  - Lista con búsqueda y filtros (sector, entidad, clasificación); detalle con ficha del servicio y documentación interactiva (Scalar) en modo solo lectura.
- [ ] **M1-06 — Aplicaciones y credenciales OAuth2**
  - `app_developer` crea una aplicación; el reconciliador crea el cliente en `rid-gateway`; el secreto se muestra una sola vez.
  - Guía de integración con `curl` para obtener token.
- [ ] **M1-07 — Solicitud de acceso y aprobación**
  - Formulario: aplicación, versión, finalidad (solo las permitidas), detalle, base legal, operaciones.
  - Bandeja del `data_steward` de la proveedora: aprobar (puede reducir operaciones y vigencia) o rechazar con motivo.
  - Separación de funciones aplicada y probada.
- [ ] **M1-08 — Reconciliador de APISIX**
  - Outbox → pg-boss → reconciliador idempotente que crea upstream y ruta con los plugins de `ARCHITECTURE.md §4.1` (sin `limit-count` ni mTLS todavía).
  - Reconciliación completa periódica; `sync_state` actualizado.
  - Test de integración: borrar una ruta a mano en APISIX y verificar que el reconcile la recrea.
- [ ] **M1-09 — Bundle y política OPA**
  - `GET /api/v1/opa/bundle.tar.gz` con `ETag`; `data.json` según `ARCHITECTURE.md §4.2`.
  - `rid.authz` con las reglas 1–6 y razones de negación estables; `opa test` con casos positivos y negativos de cada regla.
  - La suscripción pasa a `active` cuando la revisión del bundle que la contiene fue descargada por OPA (se lee `/status` de OPA o métrica equivalente).
- [ ] **M1-10 — Revocación**
  - `data_steward` revoca; la llamada empieza a fallar con `403 no_subscription` en < 60 s (test automatizado).
- [ ] **M1-11 — Auditoría encadenada mínima**
  - Cadena de hash funcionando; línea de tiempo por objeto (API, suscripción) en la UI.
  - Endpoint de verificación de integridad.
- [ ] **M1-12 — Demo automatizada**
  - `pnpm demo` ejecuta el guion de `DEMO.md` contra el stack local y termina en verde.
  - Test e2e Playwright del flujo completo en la UI.

**Cierre M1:** demo en vivo según `DEMO.md`.

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
- [ ] **M6-01 — Revisión ASVS L2** con lista de verificación y correcciones.
- [ ] **M6-02 — Auditoría de accesibilidad** WCAG 2.1 AA de todas las pantallas.
- [ ] **M6-03 — Prueba de carga** con k6: 500 peticiones/s sostenidas, p95 agregado por el gateway < 50 ms.
- [ ] **M6-04 — Resiliencia**: con el portal caído, el tráfico sigue; con OPA sin bundle nuevo, se mantiene el último; test documentado.
- [ ] **M6-05 — Helm charts** para producción con la topología de `ARCHITECTURE.md §11`.
- [ ] **M6-06 — Respaldos y recuperación**: pgBackRest, procedimiento de restauración probado.
- [ ] **M6-07 — Runbook del operador**: alta de entidad, incidentes, rotación de la CA intermedia, revocación masiva.
- [ ] **M6-08 — Antivirus de documentos** (ClamAV) y catálogo público opcional.
- [ ] **M6-09 — Inglés completo** y plantilla `example.yaml` probada levantando un "país de ejemplo".

**Cierre M6:** despliegue en un entorno tipo producción del operador con las pruebas de M6-03 y M6-04 en verde.
