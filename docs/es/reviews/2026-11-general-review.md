# Revisión general del Portal DEN — noviembre de 2026

- **Fecha:** 2026-11-17
- **Commit revisado:** `efdcb06` (rama `main`, árbol limpio al empezar)
- **Método:** nueve revisores independientes, uno por área, contrastando el código con SPEC, ARCHITECTURE, AUTHZ, los ADR 0001–0028 y las reglas de oro de CLAUDE.md. Cada hallazgo alto pasó después por un segundo agente que no conocía la conclusión y debía establecer los hechos por su cuenta.
- **Alcance:** solo revisión. No se modificó código, no hay commits. Los tests escritos para demostrar hallazgos están sin commitear (sección 8).

Cada hallazgo lleva una marca de evidencia:

- **DEMOSTRADO**: hay un test o una ejecución que lo muestra. Se indica qué parte.
- **INFERENCIA**: sale de leer el camino de código completo; no se ejecutó.

---

## 1. Veredicto

**El núcleo de autorización está bien construido. Lo que falla está alrededor: el despliegue de piloto con Compose, la completitud del registro de transparencia y la convergencia del reconciliador de APISIX.** No hay ningún hallazgo crítico. Hay cinco altos, todos verificados por un segundo agente, y unos treinta medios.

Lo que no se encontró, buscándolo expresamente:

- Ningún IDOR ni fuga entre entidades en los endpoints del API.
- Ningún bypass de la autorización de tráfico: llamar sin suscripción, usar la de otro, saltarse finalidad, vigencia o certificado.
- Ningún cambio de estado de dominio sin evento de auditoría en la misma transacción.
- Ninguna forma de falsificar un comprobante de transparencia o de verificarlo en falso.
- Ningún camino por el que un cuerpo de petición o respuesta quede persistido.

### Lo que impediría ponerlo en producción con datos reales

| # | Hallazgo | Por qué bloquea |
| :-- | :-- | :-- |
| A-1 | La subida de documentos falla en el piloto instalado con `install.sh` | El alta de entidad con PDF de designación no funciona. Afecta al bootcamp de entidades. |
| A-2 | `api`, `web` y la app ciudadana reciben todos los secretos; el API tiene la credencial de un superusuario de PostgreSQL | Un fallo en cualquiera de los tres entrega la base, la CA y las claves de firma, y permite reescribir la bitácora. |
| A-3 | Los lotes de transparencia de más de 32 KB se pierden enteros | Con tráfico sostenido, el ciudadano deja de ver consultas sobre sus datos y nada lo avisa. |
| A-4 | Un consumidor evita el registro de transparencia con un `X-Request-Id` largo | Una entidad puede consultar a una persona sin dejar rastro para ella. |
| A-5 | El reconciliador borra en cada pasada el certificado de cliente de X-Road | Las rutas X-Road sobre HTTPS quedan caídas casi todo el tiempo, y la consola dice que están sincronizadas. |

Además, tres medios pesan como bloqueantes de la promesa del producto, aunque no de su funcionamiento:

- **M-14:** la TSA acreditada no se puede conectar; solo funciona la de desarrollo, que opera el mismo operador. La garantía "ni siquiera el operador" de ADR-0016 no se sostiene en el piloto.
- **M-11:** el token del consumidor llega al proveedor. Con `mtls.required: true` (Colombia) no es reutilizable; con `false` sí.
- **M-03:** en producción no hay forma auditada de crear un regulador, un revisor o un auditor, ni de retirar a un administrador.

### Límites de esta revisión

- **Los hallazgos se obtuvieron sin el stack levantado.** Las pruebas de integración y e2e se ejecutaron después, contra el stack local; sus resultados están en la sección 9. Ningún hallazgo se volvió a probar con tráfico real por APISIX, OPA o Keycloak.
- **`install.sh` no se ejecutó en esta revisión** (el autor lo ejecutó ese mismo día en un servidor limpio, sin errores) y los charts de Helm no se renderizaron (`helm` no está instalado).
- **Sí pasaron** `pnpm lint`, `pnpm typecheck`, `pnpm test` (248 tests del API más paquetes e infra), `pnpm test:policy` (68/68) y `pnpm license:check` (999 paquetes), ejecutados antes de que existieran los tests de la revisión.
- La sección 6 detalla qué quedó sin mirar.

---

## 2. Hallazgos altos

### A-1 · La subida de documentos falla en el piloto instalado con `install.sh`

- **Qué está mal:** el API recibe `DEN_DOCUMENTS_DIR=data/documents`, un valor de desarrollo, e intenta escribir en un directorio que no puede crear.
- **Dónde:** `.env.example:46`; `scripts/make-deploy-env.mjs:82-185` (copia la línea tal cual); `infra/compose/docker-compose.deploy.yml:199-204`; `apps/api/Dockerfile:30-35`; `apps/api/src/documents/storage.service.ts:16-19`.
- **Escenario:** `env_file` gana al `ENV` de la imagen. El API resuelve `/repo/apps/api/data/documents`, que es de root, y corre como `node`. Una persona que pide el alta de su entidad con el PDF de designación, o un consumidor que sube un acuerdo, recibe un error. El volumen `api-documents` queda vacío, así que `install.sh backup` no respaldaría nada.
- **Evidencia:** DEMOSTRADO que el contenedor `api` recibe ese valor (`.env` generado y `docker compose config`). El error de permiso se reprodujo en un contenedor que imita la propiedad de directorios del Dockerfile, no en la imagen real del API. No se comprobó el código HTTP que ve el cliente.
- **Incumple:** DEPLOYMENT §3.10 y OPERATIONS §6.
- **Corrección:** fijar `DEN_DOCUMENTS_DIR: /var/lib/den/documents` en el `environment:` del servicio `api` del overlay de despliegue, o comentar la variable en `.env.example`. Añadir el caso a `make-deploy-env.test.mjs`.

### A-2 · Todos los secretos en tres contenedores, y el API con credencial de superusuario

- **Qué está mal:** `api`, `web` y `citizen-app` cargan el `.env` completo; el proceso del API conserva la credencial del rol `den`, que es superusuario del clúster.
- **Dónde:** `infra/compose/docker-compose.deploy.yml:199,239,256`; `apps/api/Dockerfile:39`; `scripts/make-deploy-env.mjs:86-87`; `infra/compose/docker-compose.yml:20`.
- **Escenario:** una lectura de entorno o una ejecución de código en Next.js, o en la app ciudadana de referencia (un mock publicado en internet), entrega la contraseña de PostgreSQL, la de administrador de Keycloak, la de step-ca, la clave de firma de transparencia, la clave HMAC del seudónimo, la clave de la Admin API de APISIX y la de los respaldos. Con el rol `den` se desactivan los triggers de solo-inserción y se reescribe la bitácora y sus anclas.
- **Evidencia:** DEMOSTRADO con `docker compose config` (más de 100 variables en cada servicio). DEMOSTRADO en un PostgreSQL desechable que `den` es superusuario y que `SET session_replication_role = replica` o `DISABLE TRIGGER` saltan un trigger equivalente; la prueba no se hizo sobre la migración real. Los anclajes ya enviados por correo no se pueden reescribir.
- **Incumple:** DEPLOYMENT §3.2 ("the schema owner only runs migrations; the API runs as `den_app`") y ARCHITECTURE §7. El chart de Helm sí lo hace bien.
- **Corrección:** un servicio `migrate` de un solo uso con la URL del dueño, y listas `environment:` explícitas por servicio en lugar del `.env` completo.

### A-3 · Los lotes de transparencia de más de 32 KB se pierden enteros

- **Qué está mal:** el input `tcp` de Fluent Bit descarta cualquier mensaje JSON mayor que su búfer por defecto, y APISIX envía cada lote como un único arreglo JSON.
- **Dónde:** `infra/fluent-bit/transparency.yaml:21-28` (sin `buffer_size`); `apps/api/src/reconcilers/apisix/desired-state.ts:599-610` (`batch_max_size: 100`).
- **Escenario:** una ruta con datos de titular recibe más de 50 llamadas en un worker sin una pausa de un segundo. El lote supera los 32 KB, Fluent Bit cierra la conexión y lo descarta. APISIX ya dio el envío por bueno y no reintenta. El ciudadano no ve esas consultas, no recibe aviso y no hay comprobante. Solo queda una línea `warn` en el contenedor.
- **Evidencia:** DEMOSTRADO por ejecución con `fluent/fluent-bit:5.1.5-debug` (la imagen del compose) y el input del repositorio: 50 registros (32 741 bytes) salen 50; 51 registros (33 396 bytes) salen 0; un lote lleno de 100 sale 0. El emisor fue un script que imita a `tcp-logger`; el formato de arreglo y la ausencia de reintento salen del fuente de APISIX 3.19.0, no de un APISIX en marcha.
- **Por qué no se vio:** con tráfico esporádico los lotes son pequeños. `docs/performance/M6-03.md` carga 500 req/s con transparencia activa pero no cuenta los registros que llegaron.
- **Incumple:** ADR-0015 (decisión 3 y "Completitud"); ARCHITECTURE §13.
- **Corrección:** fijar `buffer_size` en el input (1–4 MB) o bajar `batch_max_size` para que el lote máximo quepa. Añadir una prueba de carga que compare llamadas servidas con filas insertadas, y una alerta de huecos.

### A-4 · Un consumidor evita el registro de transparencia con un `X-Request-Id` largo

- **Qué está mal:** el colector descarta el registro entero si `request_id` supera 200 caracteres, y ese campo lo elige el consumidor.
- **Dónde:** `apps/api/src/transparency/subject-access.service.ts:30,92-96,190-192`; `apps/api/src/reconcilers/apisix/desired-state.ts:207,521`; `infra/fluent-bit/transparency.lua:31-45`; `packages/policy/den/authz.rego:257`.
- **Escenario:** una aplicación con suscripción válida consulta datos de una persona enviando `X-Request-Id` de 201 caracteres. OPA autoriza y el proveedor responde. El colector marca el registro `invalid`, responde 200 a Fluent Bit y el registro se pierde para siempre. La única señal es un `warn` con conteos, sin métrica ni alerta, que no identifica a la aplicación. Combinado con A-3, cabeceras de varios KB tumban además el lote entero, con registros de otros consumidores.
- **Evidencia:** DEMOSTRADO en el colector (`subject-access.review.test.ts`). Que el gateway conserva el valor del cliente es INFERENCIA, confirmada por tres lecturas independientes del fuente de APISIX 3.19.0 (`request-id` solo genera un id si la cabecera falta).
- **Incumple:** ADR-0015 §3; ADR-0017, consecuencia 1 (nada depende de una afirmación del consumidor).
- **Corrección:** un campo opcional no verificable no debe invalidar el registro: truncarlo o anularlo en el colector y acotarlo en `transparency.lua`, como ya hace `allowlist.lua` en analítica. Añadir métrica y alerta de registros descartados por motivo.

### A-5 · El reconciliador borra en cada pasada el certificado de cliente de X-Road

- **Qué está mal:** la limpieza de huérfanos no cuenta `den-ssl-gateway-xroad` entre los SSL que debe conservar.
- **Dónde:** `apps/api/src/reconcilers/apisix/apisix.reconciler.ts:374-385` (`removeOrphans`); creación en `:399-417` y `:601-606`.
- **Escenario:** el operador configura un Security Server `https://` y se publica una versión `xroad`. Cada pasada completa crea el SSL y lo borra al final. El upstream queda apuntando a un SSL inexistente hasta la pasada siguiente (unos cinco minutos), que repite el ciclo. `sync_state` lo muestra `in_sync`.
- **Evidencia:** DEMOSTRADO a nivel de reconciliador (`orphans.review.test.ts`, que emite `DELETE ssls/den-ssl-gateway-xroad`). Que APISIX acepta el borrado y que las llamadas fallan después es INFERENCIA del fuente de APISIX 3.19.0 (`admin/ssl.lua` no tiene `delete_checker`).
- **Por qué no se vio:** `xroad.int.test.ts` usa un Security Server `http://` y no ejecuta `reconcileAll`.
- **Incumple:** ARCHITECTURE §4.1 y ADR-0007 (convergencia).
- **Corrección:** calcular el conjunto de SSL deseados y borrar solo lo que no esté en él; como mínimo, conservar ese id mientras haya una versión xroad servida sobre https.

---

## 3. Hallazgos medios

### 3.1 Cuentas, roles y segundo factor

**M-01 · Un rol de plataforma sin segundo factor lee expedientes de alta ajenos.**
- **Dónde:** `apps/api/src/entities/entity-requests.controller.ts:26`; `entity-requests.service.ts:90-109,214`; `apps/api/src/auth/auth.guard.ts:93`.
- **Escenario:** quien tenga solo la contraseña de un revisor, operador o regulador recibe 403 `mfa_required` en la cola de revisión, pero `GET /entity-requests/<id>` es `@SignedIn` y le devuelve el expediente: solicitante, designados, DPO, comentarios y el PDF. El id es el de la entidad, que `/catalog/entities` publica.
- **Evidencia:** DEMOSTRADO (`mfa-signed-in-bypass.review.test.ts`, con el guard real y Prisma simulado).
- **Incumple:** ADR-0021 y SPEC §8.
- **Corrección:** que las rutas `@SignedIn` sirvan solo al solicitante y los revisores lean por rutas `@PlatformAccess`; como mínimo, exigir `principal.mfa` en la rama de revisión.

**M-02 · El segundo factor de `data_steward` se rodea desde `entity_admin`, que no lo exige.**
- **Dónde:** `apps/api/src/auth/authz.policy.ts:27-30,182`; `apps/api/src/entities/members.service.ts:63,196`.
- **Escenario:** con la contraseña de un `entity_admin`, el atacante invita a un correo suyo como `data_steward`, enrola su propio TOTP y aprueba solicitudes de acceso. `node.write` (tokens de enrolamiento de nodos) sigue el mismo patrón.
- **Evidencia:** INFERENCIA.
- **Incumple:** la intención de ADR-0021; ASVS-L2 lo lista como decisión pendiente sin advertir esta consecuencia.
- **Corrección:** incluir `entity_admin` en `MFA_ENTITY_ROLES`, o exigir MFA en `entity.members.write` y `node.write`.

**M-03 · No hay forma auditada de conceder o revocar roles de plataforma ni de deshabilitar un usuario.**
- **Dónde:** `userPlatformRole` solo se escribe en `auth/bootstrap-admin.ts`, `seed/seed.ts`, `load/scale-seed.ts` y tests.
- **Escenario:** en producción solo existe el `platform_admin` del bootstrap. Crear un regulador o retirar a un administrador comprometido obliga a SQL directo, fuera de la bitácora. Sin regulador, las versiones sensibles quedan atascadas en `approved_operator`.
- **Evidencia:** INFERENCIA.
- **Incumple:** regla de oro 4; `docs/DEPLOYMENT.md:607` ("the other roles are granted from the console").
- **Corrección:** endpoints `@PlatformAccess` auditados para conceder, revocar y deshabilitar, con regla de último administrador.

### 3.2 Máquinas de estado y ciclo de vida

**M-04 · "Reactivar entidad" activa una solicitud de alta que sigue en revisión.**
- **Dónde:** `apps/api/src/entities/entity-status.service.ts:233-251`; `apps/api/src/domain/entity/state-machine.ts:18`.
- **Escenario:** un `platform_admin` llama `POST /admin/entities/:id/reactivate` sobre una solicitud `under_review`, incluso una propia. Queda `active` sin la comprobación de imparcialidad, sin membresía ni invitaciones (una entidad activa sin administrador) y con un evento `entity.reactivated` que no ocurrió.
- **Evidencia:** DEMOSTRADO (`entity-status.review.test.ts`).
- **Incumple:** SPEC §4.1 (separación de funciones).
- **Corrección:** exigir `status === 'suspended'` en `reactivate` y fijarlo en el WHERE. En general, no usar la máquina como único guard cuando dos acciones comparten estado destino.

**M-05 · En suscripciones, `/reactivate` pasa de `approved` a `active` sin confirmación del gateway.**
- **Dónde:** `apps/api/src/subscriptions/subscriptions.service.ts:1063-1096`.
- **Escenario:** el responsable de datos "reactiva" una suscripción recién aprobada. El estado y la bitácora afirman una activación que OPA no confirmó. No concede acceso adicional.
- **Evidencia:** INFERENCIA.
- **Incumple:** SPEC §4.4 paso 4.
- **Corrección:** exigir `status === 'suspended'`.

**M-06 · Una renovación pendiente queda sin salida cuando la original vence.**
- **Dónde:** `subscriptions.service.ts:748-757`, usada en `approve` (`:623`) y en `regulator.service.ts`.
- **Escenario:** el consumidor pide la renovación a tiempo y el responsable decide después de `validUntil`. La original ya está `expired` y toda aprobación devuelve 409 para siempre. Hay corte de servicio y hay que empezar de cero.
- **Evidencia:** INFERENCIA; el test existente cubre el caso de suspendida, no el de vencida.
- **Incumple:** SPEC §4.4 paso 6.
- **Corrección:** aceptar original `active` o `expired`, o cerrar la renovación al vencer con un evento auditado.

**M-07 · El retiro de una versión deja vivas las solicitudes en `info_requested`, que luego se aprueban.**
- **Dónde:** `apps/api/src/apis/version-lifecycle.service.ts:19` (frente a `entity-status.service.ts:15`, que sí lo incluye).
- **Escenario:** tras el retiro, el solicitante responde y el responsable aprueba, porque `approve` no mira el estado de la versión. Queda una suscripción `approved` sobre una versión retirada: no da acceso, pero nunca se activa y ocupa el hueco de "una viva por finalidad".
- **Evidencia:** DEMOSTRADO (`version-lifecycle.review.test.ts`); lo encontraron dos revisores por separado.
- **Incumple:** SPEC §4.2 paso 5 y ADR-0019 punto 4.
- **Corrección:** añadir `info_requested` a `PENDING` y comprobar versión servida en `approve` y `provideInfo`.

### 3.3 Reconciliador de APISIX

**M-08 · La comparación de deriva es de subconjunto: lo que sobra en APISIX ni se corrige ni se detecta.**
- **Dónde:** `apps/api/src/reconcilers/apisix/desired-state.ts:790-804`; `apisix.reconciler.ts:704-713`.
- **Escenario 1:** el operador apaga `features.gatewayAssertion`. Se borra la metadata, pero las rutas conservan `den-assertion`, que responde 503 en todas las llamadas hasta que alguien borre las rutas a mano.
- **Escenario 2:** un plugin añadido a mano a una ruta gestionada, o un nodo extra en un upstream, sobrevive a la reconciliación y no cuenta como deriva.
- **Escenario 3:** una IP que el DNS del proveedor ya no publica sigue recibiendo tráfico.
- **Evidencia:** DEMOSTRADO para `matches` (`orphans.review.test.ts` y `desired-state.review.test.ts`); lo encontraron dos revisores. El 503 es INFERENCIA de leer `den-assertion.lua:102-106`.
- **Incumple:** ARCHITECTURE §4, ADR-0007 y la regla de oro 5.
- **Corrección:** igualdad exacta en los campos que el portal posee (`plugins`, `nodes`, `tls`, `vars`, `methods`), tolerando solo los valores por defecto de APISIX.

**M-09 · La pasada completa borra como huérfanos objetos creados mientras corría.**
- **Dónde:** `apisix.reconciler.ts:142-145` (instantánea) y `:165-189` (limpieza).
- **Escenario:** el operador publica una versión durante una pasada. El trabajo del outbox crea la ruta y la pasada en curso la borra. La API responde 404 hasta cinco minutos con `sync_state = in_sync`. No hay candado entre pasadas ni entre réplicas.
- **Evidencia:** DEMOSTRADO con el entrelazado simulado (`orphans.review.test.ts`); la frecuencia real es INFERENCIA.
- **Incumple:** SPEC §4.4 ("< 60 s") y ADR-0007.
- **Corrección:** releer en la base cada candidato antes de borrarlo, o serializar con un advisory lock como hace WireGuard.

**M-10 · Se borra el certificado de cliente de un proveedor cuya única versión está `in_review`.**
- **Dónde:** `apisix.reconciler.ts:183-186`.
- **Escenario:** un proveedor nuevo envía a revisión su primera versión con mTLS directo. La validación de conectividad funciona o falla según el momento del ciclo.
- **Evidencia:** DEMOSTRADO (`orphans.review.test.ts`).
- **Corrección:** incluir en `providers` las entidades con versiones `in_review` que necesiten PKI.

### 3.4 Tráfico en el gateway

**M-11 · El token del consumidor llega al proveedor (alto con `mtls.required: false`).**
- **Dónde:** `apps/api/src/reconcilers/apisix/desired-state.ts:134-166,525-566`.
- **Escenario:** el proveedor, o el Security Server de X-Road, recibe `Authorization: Bearer <token>` del consumidor en cada llamada. Sin mTLS exigido, el token es un bearer puro: el proveedor lo reusa contra otras APIs a las que la aplicación esté suscrita, y la bitácora y la transparencia culpan a la aplicación. Con mTLS exigido (`co.yaml`), OPA devuelve `certificate_mismatch`, pero el token sigue llegando a los logs del proveedor.
- **Evidencia:** DEMOSTRADO a nivel de configuración (`desired-state.review.test.ts`). Que APISIX no borra la cabecera es INFERENCIA del fuente de 3.19.0 (`openid-connect`, `opa`, `proxy-rewrite` y la plantilla nginx), confirmada por un segundo agente. Ningún test del repo afirma qué ve el proveedor.
- **Incumple:** ARCHITECTURE §6 lista lo que recibe el proveedor y no menciona el token; ASVS L2.
- **Corrección:** añadir `Authorization` a `send_headers_upstream` de OPA, que es el patrón ya usado para borrar después de leer, y un caso en `header-spoofing.int.test.ts`.

**M-12 · El titular registrado puede no ser el titular consultado.**
- **Dónde:** `packages/policy/den/authz.rego:153-189`; `apps/api/src/transparency/subject-ref.ts:20-27`; `infra/apisix/plugins/apisix/plugins/den-data-subject.lua:61-147`.
- **Escenario a:** `/afiliados/0001000000001` y `/afiliados/1000000001` dan seudónimos distintos; un proveedor que guarda el número como entero devuelve a la misma persona, que nunca ve la consulta.
- **Escenario b:** un cuerpo con `numeroIdentificacion` y `NumeroIdentificacion` pasa el control de duplicados; el gateway registra el primero y un proveedor insensible a mayúsculas usa el segundo.
- **Evidencia:** DEMOSTRADO que los seudónimos difieren (`authz_review_test.rego`). El vector de mayúsculas y el comportamiento del proveedor son INFERENCIA.
- **Incumple:** ADR-0017 ("el gateway y el proveedor deben leer a la misma persona").
- **Corrección:** forma canónica por tipo de documento en `config/country/*.yaml`, denegando lo que no la cumpla; tratar como duplicados los nombres que coinciden sin distinguir mayúsculas; exigirlo en el contrato del proveedor.

**M-13 · Una ruta literal junto a una con parámetro es inalcanzable.**
- **Dónde:** `packages/policy/den/authz.rego:50-54`; `apps/api/src/apis/lint/openapi-lint.ts` no rechaza solapamientos.
- **Escenario:** un OpenAPI válido con `GET /afiliados/{id}` y `GET /afiliados/buscar`. Toda llamada a la literal falla con 5xx. Falla cerrado.
- **Evidencia:** DEMOSTRADO (`authz_review_test.rego`: `eval_conflict_error`).
- **Corrección:** que la literal gane a la parametrizada, o rechazar el solapamiento en el lint.

### 3.5 Transparencia y privacidad

**M-14 · La TSA acreditada no se puede conectar; solo funciona la de desarrollo.**
- **Dónde:** `apps/api/src/transparency/evidence/tsa.client.ts:28-46`; `infra/mock-citizen-app/src/config.ts:91`; `infra/tsa/init.sh`.
- **Escenario:** el cliente fija las rutas del API de sigstore y descarga la raíz de confianza de la propia TSA. Con una TSA RFC 3161 estándar, ningún lote ni ancla se sella. Queda la TSA de desarrollo, un contenedor del operador con la clave en un volumen: el operador tiene la clave de firma, la de la TSA y la base, y puede reescribir y volver a sellar todo.
- **Evidencia:** INFERENCIA.
- **Incumple:** ADR-0016 §2; ARCHITECTURE §13; `docs/DEPLOYMENT.md:193-196,554`.
- **Corrección:** URL completa configurable y raíces fijadas por configuración; avisar o fallar en producción si la TSA es la de desarrollo.

**M-15 · El sellador recorre toda la tabla de registros cada 10 s, sin índice.**
- **Dónde:** `apps/api/src/transparency/evidence/transparency-evidence.service.ts:148-152,456-459`.
- **Escenario:** con retención de 60 meses la tabla llega a decenas de millones de filas. Cuando la consulta supere su timeout de 60 s, el sellado falla en cada ronda y todo queda sin comprobante.
- **Evidencia:** INFERENCIA; no se ejecutó `EXPLAIN`.
- **Corrección:** una tabla-cola de pendientes, o un índice con marca de agua.

**M-16 · `X-Request-Id` es texto libre que acaba guardado junto al seudónimo y en analítica.**
- **Dónde:** `subject-access.service.ts:30,145`; `infra/fluent-bit/allowlist.lua:33,41`.
- **Escenario:** un consumidor que use el número de documento como id de traza lo deja en claro en `subject_access_record` (60 meses) al lado del seudónimo. En analítica, `CC-1032456789` cumple el patrón de `request_id` y `cc1032456789` el de `purpose` en llamadas denegadas, y ambos llegan a OpenSearch.
- **Evidencia:** DEMOSTRADO que el colector almacena hasta 200 caracteres libres (lectura confirmada por un segundo agente; ningún código lee después esa columna). El filtro de analítica es INFERENCIA de los patrones.
- **Incumple:** ADR-0015 ("no llega a logs, búferes ni bases"); ARCHITECTURE §8.
- **Corrección:** no guardar el campo o guardar su hash; descartar valores con seis o más dígitos seguidos, como ya hace `gateway-errors.lua`.

### 3.6 Endpoints de dominio

**M-17 · El catálogo "autenticado" está abierto a cualquiera que se autorregistre.**
- **Dónde:** `apps/api/src/catalog/catalog.controller.ts:23-29`; `catalog.service.ts:33-39`; el realm del portal tiene `registrationAllowed: true`.
- **Escenario:** una persona sin membresía ni rol ve todas las APIs `internal`, `personal` y `sensitive`: campos expuestos, correo de contacto, estado de los nodos y el OpenAPI completo.
- **Evidencia:** INFERENCIA; un test existente (`catalog.int.test.ts:193`) lo fija como intencional.
- **Incumple:** ADR-0014 ("se protegen con roles de plataforma").
- **Corrección:** exigir membresía activa o rol de plataforma para lo no público; si es deliberado, documentarlo en SPEC §2.3.

**M-18 · La comprobación de compatibilidad de revisiones deja pasar cambios incompatibles.**
- **Dónde:** `apps/api/src/domain/api-version/compatibility.ts:58-66,86-92`.
- **Escenario:** un `api_publisher` quita o cambia el tipo de una propiedad anidada, de los `items` de un arreglo, de un parámetro o del cuerpo. El portal lo acepta como revisión menor, sin revisión del operador y con las mismas suscripciones.
- **Evidencia:** DEMOSTRADO (`compatibility.review.test.ts`, cinco casos).
- **Incumple:** SPEC §4.2 y ADR-0019.
- **Corrección:** comparación recursiva; lo que no se sepa comparar cuenta como incompatible.

**M-19 · Una versión devuelta con correcciones solo permite cambiar el OpenAPI.**
- **Dónde:** `apps/api/src/apis/apis.controller.ts`; `apis.service.ts:366-377`.
- **Escenario:** el revisor pide corregir los campos expuestos, la base legal o el upstream. No hay endpoint para hacerlo, ni se puede crear otra versión de esa mayor. Solo queda saltar a `v2` o crear otra API.
- **Evidencia:** INFERENCIA.
- **Incumple:** SPEC §4.2 y §6.
- **Corrección:** un `PUT` de la versión en estados editables con la validación de `createVersion`.

**M-20 · Los controles de privacidad dependen de la clasificación de la API, no de los campos declarados.**
- **Dónde:** `apis.service.ts:260-269`; `subscriptions.service.ts:80-85`; `catalog.service.ts:37`.
- **Escenario:** un proveedor registra la API como `internal` con campos `personal: true`. No se exige declarar el titular (sin transparencia), ni `X-DEN-End-User`, y la vigencia máxima es de 24 meses. Todo queda a que el revisor lo note.
- **Evidencia:** INFERENCIA. `domain/approval.ts` ya aplica la regla correcta, pero solo para campos sensibles.
- **Incumple:** SPEC §5 y ADR-0015.
- **Corrección:** rechazar la combinación en `createVersion` y `submit`, o derivar una clasificación efectiva.

### 3.7 Web

**M-21 · Tras más de cinco minutos sin navegar, la primera petición llama al API con el token caducado.**
- **Dónde:** `apps/web/src/proxy.ts:11,32`; `apps/web/src/lib/api.ts:22-30`; `apps/web/src/auth.ts:42-51`.
- **Escenario:** el proxy refresca el token y lo entrega al navegador, pero el render y las server actions de esa misma petición leen la cookie vieja. Una responsable de datos lee una solicitud seis minutos y pulsa "Aprobar": el API responde 401 y ve un error genérico. El segundo intento funciona.
- **Evidencia:** DEMOSTRADO a nivel de proxy con Auth.js y next-intl reales (`stale-token.review.test.ts`). El 401 y lo que muestran las páginas son INFERENCIA.
- **Corrección:** propagar el token refrescado a la petición, o que `lib/api.ts` refresque y reintente una vez ante 401.

**M-22 · La web muestra las fechas en UTC, no en la zona del país.**
- **Dónde:** `apps/web/src/i18n/request.ts:8-14`.
- **Escenario:** con `America/Bogota`, el auditor ve un evento de las 20:30 del día 14 como 01:30 del día 15, sin indicación de zona. Los correos del API sí usan la zona del país, así que portal y correo pueden mostrar días distintos.
- **Evidencia:** INFERENCIA.
- **Incumple:** CLAUDE.md, Convenciones.
- **Corrección:** `timeZone: getCountryConfig().country.timezone` en `getRequestConfig`, con un test cercano a medianoche.

**M-23 · Ningún e2e corre en CI.**
- **Dónde:** `.github/workflows/ci.yml`.
- **Escenario:** un cambio que rompa la CSP, las cookies, el logout o introduzca violaciones axe pasa CI en verde. Tampoco corren `tests/infra/*.int.test`, `helm lint` ni un `compose config` del overlay de despliegue (que habría detectado A-1).
- **Evidencia:** DEMOSTRADO por lectura de los workflows.
- **Incumple:** la definición de terminado como garantía continua; `playwright.config.ts:23` y `docs/accessibility/WCAG-2.1-AA.md` dicen que corre en cada ejecución.
- **Corrección:** un job con el stack de compose que ejecute al menos `accessibility`, `security-headers` y `login`.

### 3.8 Despliegue y operación

**M-24 · `.dockerignore` no excluye `backups/` ni `infra/edge/certs/`.**
- **Dónde:** `.dockerignore`; `infra/mock-providers/Dockerfile:5`; `infra/mock-citizen-app/Dockerfile:6`; `install.sh:562-611`.
- **Escenario:** `install.sh update` respalda en `backups/` y luego construye. El `COPY . .` mete en las capas de dos imágenes el `env` con todos los secretos, los volcados, los datos de step-ca y la llave privada del portal. `backups/` nunca se poda.
- **Evidencia:** DEMOSTRADO por lectura; no se hizo build.
- **Corrección:** excluir `backups/`, `infra/edge/certs/`, `infra/edge/dynamic/` y `_site/`; rotar `backups/`.

**M-25 · El arranque no falla con secretos de ejemplo.**
- **Dónde:** `infra/compose/docker-compose.yml:67,69`; `apps/api/src/opa/deployment-secret.ts`; `apps/api/src/transparency/evidence/signing-key.ts`.
- **Escenario:** con un `.env` escrito a mano, Keycloak importa los usuarios de demo con contraseña y TOTP públicos. En producción solo se rechazan dos valores de ejemplo; la clave privada de firma de transparencia publicada en `.env.example`, `DEN_SECRETS_KEY`, `AUTH_SECRET` y el token de ingesta se aceptan.
- **Evidencia:** INFERENCIA. `install.sh` y `make-deploy-env` sí los reemplazan todos (verificado).
- **Incumple:** SECURITY.md ("a default that would carry over").
- **Corrección:** `:?` en el overlay de despliegue y una validación de arranque que rechace cualquier valor igual al de `.env.example`.

**M-26 · La comprobación del instalador sobre el bundle de OPA no puede fallar.**
- **Dónde:** `install.sh:460-462`.
- **Escenario:** acepta cualquier código distinto de 200. Un 401 del API (ruta expuesta) o un `000` de curl dan "no está expuesto". Importa sobre todo con un Traefik propio.
- **Evidencia:** DEMOSTRADO por lectura.
- **Incumple:** OPERATIONS §2.1 (pide 404).
- **Corrección:** exigir 404 exacto, también para `/api/v1/internal`.

**M-27 · El API no conoce la IP real del cliente.**
- **Dónde:** `scripts/make-deploy-env.mjs:124` (`DEN_TRUST_PROXY` vacío); `apps/web/src/lib/api.ts:38,104,133,153` (no reenvía `X-Forwarded-For`); `apps/api/src/common/rate-limit.ts:69-75`.
- **Escenario:** todos los visitantes anónimos comparten un cubo de 600 por minuto; uno solo lo agota para los demás. Los eventos `request_refused` registran la IP de Traefik o del contenedor web, y el campo `ip` de la bitácora queda siempre nulo.
- **Evidencia:** DEMOSTRADO que el `.env` generado lo deja vacío; el resto es INFERENCIA (tres revisores coinciden).
- **Incumple:** DEPLOYMENT §4.1; ASVS-L2 fila 4; SPEC §3 (campo `ip`).
- **Corrección:** IP fija para el borde en la red y `DEN_TRUST_PROXY` escrito por el instalador; que la web reenvíe la IP.

**M-28 · Ningún correo del piloto sale del servidor, y no es configurable.**
- **Dónde:** `infra/compose/docker-compose.deploy.yml:202`; `infra/keycloak/den-portal-realm.json:20-25`; `infra/alertmanager/alertmanager.yml`.
- **Escenario:** INSTALL §6 dice que las entidades reales se dan de alta por autorregistro. Sus verificaciones de correo, invitaciones y recuperaciones caen en Mailpit. Si el operador comparte esa credencial, cualquiera lee los enlaces de recuperación de cualquier cuenta. Las alertas no llegan a nadie.
- **Evidencia:** INFERENCIA. Está documentado como limitación, pero choca con el uso previsto.
- **Corrección:** dejar que `.env` gobierne `DEN_SMTP_URL` y documentar el SMTP del realm.

**M-29 · Una sola contraseña para los diez usuarios de demo, con `DEN_ALLOW_SEED=true` en el despliegue.**
- **Dónde:** INSTALL §3 paso 6; `infra/keycloak/den-portal-realm.json`; `infra/compose/docker-compose.deploy.yml:200-202`.
- **Escenario:** quien reciba la contraseña en el bootcamp tiene la de los administradores de plataforma, el regulador y el auditor. La única barrera es un TOTP común. No se verificó si, con solo la contraseña, Keycloak deja inscribir un segundo autenticador.
- **Evidencia:** INFERENCIA.
- **Corrección:** contraseña distinta para las cuentas con rol crítico, o no compartir la común.

**M-30 · El procedimiento "se perdió el servidor" no es ejecutable tal como está escrito.**
- **Dónde:** OPERATIONS §6.1; `install.sh` (`cmd_install`, `cmd_restore`).
- **Escenario:** pide restaurar los volúmenes antes del primer arranque, pero no hay paso para crearlos sin arrancar. Si se arranca, PostgreSQL inicializa un clúster nuevo contra un repositorio con otro system-id. Además, `backups/<fecha>/` guarda el repositorio cifrado junto al `env` que trae su clave.
- **Evidencia:** INFERENCIA.
- **Corrección:** un `install.sh restore-volumes <dir>` probado.

### 3.9 Medios-bajos

**MB-1 · La analítica nombra al consumidor por un slug que no es único.**
- **Dónde:** `apps/api/src/analytics/usage.service.ts:102-105`; `indicators.service.ts:152-155`.
- **Escenario:** cualquier usuario crea un borrador de alta con el slug de una entidad que aún no existe. Cuando la real consume, el panel del proveedor y el mapa del regulador pueden atribuir las llamadas al borrador.
- **Evidencia:** DEMOSTRADO que la consulta no filtra por estado (`usage-slug.review.test.ts`).
- **Corrección:** filtrar por estado, o registrar el id de la entidad en el log.

**MB-2 · El gateway hace de fuzzer contra cualquier host HTTPS público antes de la revisión humana.**
- **Dónde:** `apis.service.ts:696-768`; `version-validation.service.ts:129-154`.
- **Escenario:** un `api_publisher` declara como sandbox la URL de un tercero y repite `POST …/validations`. Schemathesis lanza hasta 20 ejemplos por operación desde la IP del operador. No alcanza la red interna.
- **Evidencia:** INFERENCIA.
- **Corrección:** límite estricto con enfriamiento por versión y prueba de control del host.

---

## 4. Hallazgos bajos

| # | Hallazgo | Dónde | Evidencia | Corrección |
| :-- | :-- | :-- | :-- | :-- |
| B-01 | El verificador de la cadena acepta filas sin hash con `seq ≤ 0` y eventos antedatados; el hash no lleva clave | `apps/api/src/audit/chain.ts:91-118` | DEMOSTRADO (`chain.review.test.ts`) | CHECK en la tabla, monotonía de `occurredAt`, documentar el límite en ARCHITECTURE §7 |
| B-02 | El sello RFC 3161 del anclaje de auditoría se guarda y nunca se verifica; una ancla con día futuro detiene el anclaje sin alerta | `audit-anchor.service.ts:150`; `audit-query.service.ts:63-84` | INFERENCIA | Verificar el token en `/audit/verify`, incluirlo en el correo, métrica de antigüedad |
| B-03 | El sanitizador borra `tokenId` de los eventos de enrolamiento de nodos | `apps/api/src/audit/sanitize.ts:2-3` | DEMOSTRADO (`chain.review.test.ts`) | Excepción para claves `*Id` |
| B-04 | El lock global de la cadena convierte transacciones largas (baja de entidad, revocación masiva) en errores 500 para el resto | `entity-status.service.ts:253`; `certificate-revocations.service.ts` | INFERENCIA | Tomar el lock y escribir los eventos al final de la transacción |
| B-05 | ABA en decisiones: `move` y `decide` condicionan solo por `status` | `subscriptions.service.ts` | INFERENCIA | Añadir `updatedAt` al WHERE |
| B-06 | El índice de "una viva por finalidad" excluye renovaciones; dos solicitudes simultáneas dejan dos vivas | migración `20261124000001_subscription_lifecycle` | INFERENCIA | Extender el índice |
| B-07 | "Una versión por mayor" sin restricción en la base | `apis.service.ts:369-377` | INFERENCIA | Índice único parcial |
| B-08 | Sandbox con aprobación automática sin topes de límite ni de renovaciones | `subscriptions.service.ts:233-276` | INFERENCIA | Topar al límite por defecto |
| B-09 | Los acuerdos reemplazados y los PDF de designación se acumulan sin límite | `subscriptions.service.ts:839-879` | INFERENCIA | Borrar o limitar reemplazos |
| B-10 | Texto de terceros en el asunto de correos oficiales | `notifications.service.ts:107-118` | INFERENCIA | Asunto fijo |
| B-11 | `/api/docs` carga Scalar desde un CDN sin versión ni SRI | `apps/api/src/openapi/docs.ts:21-28` | DEMOSTRADO por lectura del valor por defecto | Servir el bundle local |
| B-12 | Dos reconciliaciones concurrentes de Keycloak pueden cortar la ventana de rotación de un secreto | `keycloak.reconciler.ts:161-172` | INFERENCIA | Advisory lock por aplicación |
| B-13 | Revocar un secreto no es inmediato: los tokens emitidos valen hasta cinco minutos sin mTLS | `infra/keycloak/den-gateway-realm.json:8` | INFERENCIA | Documentarlo, o `notBefore` por cliente en el bundle |
| B-14 | `outbox` nunca se purga; el cliente de Keycloak no tiene timeout; se recorren aplicaciones `deleted` para siempre | `keycloak-admin.ts:82-121` | INFERENCIA | Purga, timeout y filtro |
| B-15 | OPA y etcd sin autenticación en la red `gateway`: cualquier contenedor de esa red lee la clave del seudónimo | `infra/compose/docker-compose.yml:91-95,157-161` | INFERENCIA | Token en OPA, credenciales en etcd |
| B-16 | Una sola contraseña para la CA y sus provisioners; el API conoce la que cifra las claves de la CA | `infra/step-ca/configure.sh:29-43` | INFERENCIA | Contraseña por provisioner |
| B-17 | Entradas de Fluent Bit (TCP 5170, HTTP 9880) sin autenticación: un contenedor de la red inyecta registros falsos | `docker-compose.yml:339` | INFERENCIA | Restringir la red o autenticar |
| B-18 | `GET /transparency/records/:id/receipt` con `audit.read` devuelve el seudónimo sin dejar rastro | módulo `transparency` | INFERENCIA | Auditar la lectura |
| B-19 | `/transparency/verify` da `valid: true` con lotes sin sello | `transparency-evidence.service.ts` | INFERENCIA | Señalarlo en `valid` o alertar |
| B-20 | La app ciudadana muestra "válido" sin ligar el comprobante a la consulta pedida, y pierde avisos si el SMTP falla | `infra/mock-citizen-app/src/server.ts:341-415` | INFERENCIA | Comparar `record.id`; marcar el aviso tras enviarlo |
| B-21 | Carrera en el primer inicio de sesión (500 por índice único) | `principal.service.ts:58-61,92-121` | INFERENCIA | Capturar P2002 y releer |
| B-22 | La identidad queda atada al `sub` y al correo del primer login, sin camino de reconciliación | `principal.service.ts:76-97` | INFERENCIA | Procedimiento auditado de re-vinculación |
| B-23 | El solicitante de un alta conserva lectura del expediente y del PDF de por vida | `entity-requests.service.ts:99-109` | INFERENCIA | Exigir membresía activa tras la decisión |
| B-24 | Sin `error.tsx` ni `not-found.tsx`: errores en inglés y fuera de la auditoría axe | `apps/web/src/app` | DEMOSTRADO por listado | Añadirlos traducidos |
| B-25 | El aviso de fin de sesión puede llegar tarde, y un refresh fallido deja una sesión zombi hasta diez horas | `session-timeout.tsx:18-41`; `auth.ts:42` | INFERENCIA | Ligar el aviso a un refresh real |
| B-26 | Parámetros de ruta interpolados sin validar en la URL del API; rutas con punto fuera del proxy | `catalog/[apiId]/page.tsx:30,55`; `proxy.ts:50` | INFERENCIA | Validar UUID; excluir solo extensiones estáticas |
| B-27 | Idiomas de la interfaz fijados en código (`['es','en']`) | `apps/web/src/i18n/routing.ts:4` | INFERENCIA | Tomarlos de la configuración del país |
| B-28 | Consola de administración de Keycloak pública en el piloto, con `start-dev` | `infra/edge/den.yml.template:39-44` | INFERENCIA | Bloquear `/auth/admin` como en el chart |
| B-29 | CI: acciones de terceros por etiqueta en `ci.yml` | `.github/workflows/ci.yml` | DEMOSTRADO por lectura | Fijar por commit |
| B-30 | `install.sh`: `curl \| sh` sin verificar, no comprueba `curl`, `git` ni la versión de Engine, contraseña de demo con `$` o `#` mal escrita en `.env` | `install.sh:133` | INFERENCIA | Comprobaciones y comillas |
| B-31 | Imágenes por etiqueta y no por digest, sin límites de memoria; la clave de fábrica de APISIX sigue en el keyring | `infra/apisix/config.yaml:27` | INFERENCIA | Fijar digest; quitar la clave |
| B-32 | `license:check` solo cubre npm; quedan fuera imágenes, apk y las dependencias Python del runner de contratos | `scripts/license-check.mjs` | INFERENCIA; las imágenes en uso cumplen, revisadas a mano | Ampliar o documentar el límite |
| B-33 | Restos del entorno del autor: `lab-router_default` como red por omisión, "Before Tuesday" en INSTALL §1.2 | `docker-compose.deploy.yml:285`; `make-deploy-env.mjs:26` | DEMOSTRADO por lectura | Valor neutro |
| B-34 | `packages/policy/rid` es un directorio vacío sin seguimiento | — | DEMOSTRADO | Borrarlo |

---

## 5. Discrepancias entre documentación y código

Además de las que ya figuran en cada hallazgo:

| Documento | Dice | Realidad |
| :-- | :-- | :-- |
| ARCHITECTURE §4.3 | El reconciliador de Keycloak configura `tls_client_auth` | El código, §3.2 y ADR-0022 dicen lo contrario: secreto más token ligado |
| ARCHITECTURE §3.2 | El TLS del gateway termina en APISIX | El borde publica `/gw` hacia APISIX 9080 en HTTP plano |
| ADR-0016 §1–2 | Hoja = hash del JSON canónico del registro; punto de control con rango | Formato 2 `{v, id, occurredAt, digest}` y punto de control sin rango; no hay ADR nuevo que lo precise |
| ADR-0025 | "`params` nunca lleva lo que escribió el usuario" | Lo lleva en cinco sitios de `apis.service.ts` y `subscriptions.service.ts` |
| ADR-0019 | Una revisión no cambia los datos expuestos | `compatibility.ts` permite operaciones y propiedades nuevas que nadie revisó |
| ADR-0005 | Revocación en menos de 60 s | Cierto para suscripciones y certificados; no para secretos, ni con el portal caído (OPA sigue con el último bundle) |
| SPEC §3 | El evento de auditoría lleva `ip` | Siempre es nulo y no está en la exportación |
| SPEC §3 | `Application` tiene estados `suspended` y `deleted` | Ningún código de producción los escribe |
| SPEC §4.2 | El proveedor declara SLA; lint de esquemas de respuesta y descripciones en español | La columna `sla` nunca se escribe; el ruleset no tiene esas reglas |
| SPEC §4.2 | Estados `approved_regulator` y `changes_requested → draft` | Existen en el enum y nunca se persisten; la auditoría registra un estado que no coincide con la fila |
| SPEC §11 | Retención de auditoría | `retention.auditYears` existe en la configuración y nadie lo lee |
| AUTHZ.md | `/entity-requests/:id` es "own resources only" | También lo sirve a revisores, operador y regulador (M-01) |
| OPERATIONS §92-94 | No hay forma de crear el primer `platform_admin` | Existe `DEN_BOOTSTRAP_ADMIN_EMAIL`, descrito en DEPLOYMENT |
| OPERATIONS §0 | Alias `dc` | No incluye el overlay de borde ni el perfil de antivirus |
| DEPLOYMENT §3.1 | Prometheus, Alertmanager y Grafana "are not in the Compose file yet" | Están |
| DEPLOYMENT §7 | Tabla de CI | Omite `pnpm audit`, promtool y el job de restauración |
| INSTALL §7 | Lista de comandos | Falta `install.sh images <tag>`; las imágenes `den-*` aún no existen en el registro |
| CLAUDE.md | "scopedRepo, nunca a mano" | `members.service.ts` y `bootcamp.service.ts` filtran `entityId` a mano; el valor viene del guard, así que no hay IDOR |
| `den-assertion.lua`, `infra/apisix/config.yaml` | "SPIKE S-6, prototype" | Es la implementación de M6-10 |

Coinciden con el código: RUNBOOK §2–4 (los endpoints y comandos que cita existen), las tablas de puertos, volúmenes y variables de DEPLOYMENT, y los nombres `den-*` en todo el código vivo tras ADR-0028.

---

## 6. Qué no se revisó o se revisó solo por encima

**Sin ejecutar:**

- Ninguna prueba `*.int.test.ts` ni e2e: el stack del portal no estaba levantado.
- `install.sh`, builds de imágenes y los charts de Helm (`helm` y `shellcheck` no están instalados).
- Tráfico real por APISIX, OPA o Keycloak. Todo lo que depende de su comportamiento en ejecución es lectura del fuente de la versión fijada.

**Puntos concretos que merecen una prueba y no la tuvieron:**

- La validación del JWT en `openid-connect`: tokens con `alg: none`, HS256 o firma de otro realm.
- `tls.verify` del upstream con un certificado de la CA de red emitido para otro nombre.
- Inscripción de un segundo autenticador en Keycloak con solo la contraseña (M-29).
- XSS dentro de Scalar con un OpenAPI malicioso; solo se comprobó que la CSP lo respalda.
- Bytes no UTF-8 en `X-Request-Id` (sospecha de que rompen el lote entero en Fluent Bit).
- Si el Security Server de X-Road reenvía `Authorization` al sistema del proveedor.

**Código no leído o leído solo por búsqueda:**

- **Web:** la mayoría de las páginas (`my-apis`, `my-entity`, casi todo `operator`, `regulator`, `requests`, `audit`, `entity-requests`), los formularios y gráficos, unas 35 specs e2e y el contenido de los archivos de mensajes.
- **API:** `invitations.service.ts`, `purposes.service.ts`, `notifications/notifying-actions.ts`, `gateway-signing-keys`, `secrets/reseal.ts`, `certificate-lifecycle.service.ts`, `nodes.service.ts` (salvo la emisión de token), el seed, y las 37 migraciones línea a línea.
- **Infra:** en Helm solo se leyeron `values.yaml`, `ingress.yaml`, `secrets.yaml` y partes de Keycloak, gateway y API; no las NetworkPolicies, etcd, step-ca, PostgreSQL ni la seguridad de OpenSearch. Tampoco `infra/contract-runner/runner.py`, `infra/mock-node`, Grafana, las reglas de Prometheus, el firewall de `hub-agent.mjs` ni las guías de `docs/guides`.
- **Realms:** `den-gateway` y `den-citizens` solo en parte; no los logs ni eventos de Keycloak.
- **Espejo en español (`docs/es`):** solo se comprobó que el número de líneas coincide.
- **Sin evaluar:** SELinux, arm64, la emisión de Let's Encrypt y la existencia de las etiquetas de imagen en los registros.

---

## 7. Qué se encontró sólido

- **Guard global del API:** falla cerrado; una ruta sin declaración responde 403 y un test sobre las rutas reales lo exige. La matriz de autorización se genera de las rutas descubiertas, no de una lista escrita a mano.
- **Verificación de JWT del portal:** RS256 fijo, issuer, audiencia, JWKS remoto; los roles nunca salen del token.
- **Aislamiento por entidad:** el `entityId` viene siempre del guard; los recursos anidados se cargan con filtros relacionales y responden 404. Cuerpos `z.strictObject`, sin asignación masiva.
- **Invitaciones y último administrador:** ligadas al correo verificado, de un solo uso, con bloqueo `FOR UPDATE` y auditoría en la misma transacción.
- **Bitácora:** todos los cambios de estado revisados emiten su evento en la transacción. La cadena se serializa con advisory lock, no admite bifurcación, y `den_app` no puede modificarla ni borrarla.
- **Control optimista:** casi todas las transiciones usan `updateMany` con el estado leído en el WHERE; dos aprobadores no producen doble decisión. La separación de funciones se repite dentro del WHERE.
- **Outbox y reconciliadores:** inserción en la misma transacción, relay con `SKIP LOCKED`, handlers que recalculan desde la base. Ninguna llamada a la Admin API fuera de los reconciliadores. La ruta se crea en un solo PUT con toda la cadena de plugins, sin ventana abierta.
- **SSRF del upstream:** solo HTTPS, direcciones resueltas y comprobadas como públicas, IP fijadas con `tls.verify`.
- **Política Rego:** `default allow := false`, input incompleto deniega, el certificado se compara de verdad contra el token y la lista de la aplicación, y los 68 tests cubren bien los casos negativos.
- **Plugins Lua:** eliminan toda cabecera `X-DEN-*` del cliente, fallan cerrado y no guardan ni registran el cuerpo.
- **Privacidad de logs:** formato sin URI, sin cuerpos, access log de nginx apagado, allowlist en Fluent Bit, plantilla de OpenSearch estricta, OPA sin decision logs, error log filtrado.
- **Seudónimo del titular:** HMAC-SHA-256 con clave de despliegue, falla cerrado y rechaza el valor de ejemplo; el portal lo deriva del token verificado, nunca de un parámetro.
- **Verificador de comprobantes:** árbol RFC 9162 con separación de dominio, JWS restringido a EdDSA, raíces de confianza de quien verifica, EKU comprobado. Resistió seis casos nuevos de manipulación.
- **PKI y WireGuard:** el CSR se valida y los nombres salen del portal; `AllowedIPs /32`, sin inyección en el mapa SNI.
- **Web:** tokens solo en cookie cifrada HttpOnly, PKCE con state y nonce, logout que cierra la sesión de Keycloak, CSP con nonce y `strict-dynamic`, sin `dangerouslySetInnerHTML`.
- **Neutralidad de país e i18n:** sin términos de país en código de producto, con un guard propio; paridad de claves entre `es` y `en` exigida por test.
- **Accesibilidad:** axe real sobre las 42 pantallas en los dos idiomas, con test de cobertura; su límite es que no corre en CI.
- **Superficie publicada en el piloto:** solo 80, 443 y 51820/udp. Redes segmentadas.
- **Generación de secretos:** `make-deploy-env` los genera todos con `crypto.randomBytes`, escribe con modo 600 y se niega a sobrescribir.
- **Licencias npm:** 999 paquetes conformes; el parser SPDX y las excepciones no tienen huecos.

---

## 8. Tests de la revisión (sin commitear)

Coinciden con los patrones de vitest y de `opa test`. **Mientras existan, `pnpm test` y `pnpm test:policy` fallan**, porque la mayoría afirma el comportamiento esperado y falla a propósito.

| Archivo | Hallazgo | Resultado |
| :-- | :-- | :-- |
| `apps/api/src/reconcilers/apisix/orphans.review.test.ts` | A-5, M-08, M-09, M-10 | 6 fallan |
| `apps/api/src/reconcilers/apisix/desired-state.review.test.ts` | M-11, M-08 | 3 fallan |
| `apps/api/src/transparency/subject-access.review.test.ts` | A-4 | 2 de 3 fallan |
| `apps/api/src/auth/mfa-signed-in-bypass.review.test.ts` | M-01 | 3 pasan (documentan el comportamiento actual) |
| `apps/api/src/entities/entity-status.review.test.ts` | M-04 | falla |
| `apps/api/src/apis/version-lifecycle.review.test.ts` | M-07 | falla |
| `apps/api/src/domain/api-version/compatibility.review.test.ts` | M-18 | 5 de 6 fallan |
| `apps/api/src/analytics/usage-slug.review.test.ts` | MB-1 | falla |
| `apps/api/src/audit/chain.review.test.ts` | B-01, B-03 | 3 fallan |
| `packages/policy/den/authz_review_test.rego` | M-12, M-13 | 1 error, 1 falla, 1 pasa |
| `packages/transparency-verifier/src/receipt.review.test.ts` | manipulación de comprobantes | 6 pasan |
| `apps/web/src/lib/stale-token.review.test.ts` | M-21 | pasa; se omite en `pnpm test` |
| `vitest.web-review.config.mjs` | configuración para el anterior | — |

Ejecutar uno: `pnpm --filter @den/api exec vitest run <ruta relativa a apps/api>`. El de la web: `pnpm exec vitest run -c vitest.web-review.config.mjs`.

Borrarlos todos:

```bash
git clean -n -- '*.review.test.ts' '*_review_test.rego' vitest.web-review.config.mjs   # ver qué se borraría
git clean -f -- '*.review.test.ts' '*_review_test.rego' vitest.web-review.config.mjs
```

El archivo `subject-access.review.test.ts` lo escribieron dos revisores sucesivamente; queda la versión del segundo.

---

## 9. Ejecución de integración y e2e (añadido después de la revisión)

Ejecutadas contra el stack local (`pnpm infra:up`), con todos los servicios sanos.

| Suite | Resultado |
| :-- | :-- |
| e2e de Playwright (`pnpm test:e2e`) | 79 pasan, 3 fallan de 82 |
| Integración del API (`pnpm --filter @den/api test:integration`) | 389 pasan de 389, en 56 archivos |
| Integración de infraestructura (`tests/infra`) | 61 pasan, 3 fallan de 64 |

Las specs `accessibility`, `security-headers` y `login` pasan.

De los seis fallos, uno es un defecto del repositorio:

- **`apps/web/e2e/citizen-app.spec.ts:17` (defecto, en el test):** genera el identificador `citizenApp-…`, con mayúscula, y el formulario de registro de API lo rechaza. Se rompió en el commit `9de1423`, que renombró la app ciudadana. Nadie lo vio porque los e2e no corren en CI (M-23). Corrección: prefijo en minúsculas.
- **`subject.spec.ts` y tres tests de `tests/infra/src/keycloak.int.test.ts` (entorno local):** el Keycloak local conservaba el realm `den-citizens` de antes del renombrado, con el cliente `carpeta-ciudadana` en lugar de `citizen-app`. `--import-realm` no reimporta un realm que ya existe. No se repitieron con el realm reiniciado.
- **`indicators.spec.ts` (entorno local):** el proceso de Playwright se cayó; repetido solo, sus tres tests pasan.

Dos consecuencias fuera de los tests:

- **Actualizar una instalación anterior al renombrado rompe el login de la app ciudadana.** El realm existente conserva el cliente viejo y nada lo migra. Una instalación nueva no lo sufre.
- **Un `.env` anterior al renombrado impide arrancar:** Compose exige `DEN_CITIZEN_APP_CLIENT_SECRET` y el archivo viejo tiene `DEN_CARPETA_CLIENT_SECRET`. El error es claro, pero ni `install.sh update` ni la documentación mencionan el cambio de nombre.

Lo que estas suites no cubren, y por tanto sigue como inferencia: A-3 (ninguna prueba cuenta registros bajo carga), A-4, A-5 (el test de X-Road usa `http://`) y M-11 (ningún test afirma qué cabeceras ve el proveedor).
