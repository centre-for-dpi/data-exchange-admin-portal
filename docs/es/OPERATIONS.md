# Guía de operación — Portal DEN

> English version (official): [docs/OPERATIONS.md](../OPERATIONS.md)

Versión 0.3 · noviembre 2026 · estado del código con M6: todo salvo la prueba de carga (M6-03) y la instalación en un clúster (M6-05), que necesitan el entorno tipo producción del operador

Qué hace cada componente al arrancar, qué tiene que hacer o correr el operador para dejarlo operativo, cómo comprobar que funciona y qué revisar en el día a día. Cómo se despliega cada pieza está en [`DEPLOYMENT.md`](DEPLOYMENT.md). El alta de entidades, la respuesta a incidentes, la rotación de la CA intermedia y la revocación masiva de certificados están en el runbook del operador ([`RUNBOOK.md`](RUNBOOK.md)).

## 0. Convenciones

En el piloto todos los comandos se corren en la raíz del clon, con este atajo:

```bash
alias dc='docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml --env-file .env --profile observability'
```

Con el proxy incluido (lo que el instalador usa por defecto) agrega `-f infra/compose/docker-compose.edge.yml` después del archivo de despliegue, y `--profile antivirus` cuando ClamAV está activo; sin ellos `dc ps` y `dc up` no ven `edge` ni `clamav`. `docker-compose.images.yml` también se agrega cuando el servidor usa imágenes publicadas (`install.sh images <etiqueta>`). El alias completo para el caso por defecto del instalador está en `INSTALL.md §7`; `sudo ./install.sh status` y `logs` usan la combinación correcta por sí solos.

En desarrollo, el equivalente es `docker compose -f infra/compose/docker-compose.yml --env-file .env --profile observability` (o `pnpm infra:ps` / `pnpm infra:logs`), y el API corre en el host (`pnpm dev`), así que los comandos `dc exec api ...` se reemplazan por llamadas a `localhost`.

Los servicios internos no tienen puertos publicados en el piloto. Para hablar con ellos se usa el contenedor `api`, que tiene `wget` y está en la misma red:

```bash
dc exec api wget -qO- http://opa:8181/health
```

## 1. Mapa de dependencias y orden de arranque

```
postgres ──▶ keycloak ─────────────┐
etcd ──▶ etcd-init ──▶ apisix ─────┤
step-ca ───────────────────────────┼──▶ api ──▶ web
tsa-init ──▶ tsa ──────────────────┘      └───▶ citizen-app
opa ················ descarga el bundle de api (reintenta solo)
fluent-bit-transparency ··· envía registros a api (búfer en disco mientras api no responde)
opensearch ──▶ fluent-bit ··· recibe logs de analítica de apisix
mailpit ··· recibe el correo de api, keycloak y citizen-app
```

Compose respeta este orden con `depends_on` y health checks: `api` espera a `postgres`, `step-ca`, `keycloak` y `apisix` sanos y a que `tsa` haya arrancado; `web` y `citizen-app` esperan a `api` sano. OPA y los Fluent Bit no dependen del API: reintentan hasta que responde.

**Plano de datos vs. plano de gobierno.** Si `api`, `web` o `keycloak` caen, el gateway sigue atendiendo con la última configuración de etcd y el último bundle de OPA. Sin Keycloak no se emiten tokens nuevos, y la validación de los vigentes depende de que APISIX tenga en caché las claves (JWKS) del realm; no está probado todavía (M6-04). Si cae `apisix`, `etcd` u `opa`, se corta el tráfico.

## 2. Puesta en marcha (día 0)

### 2.1 Qué hace cada componente solo y qué hay que hacer

| Componente | Lo hace solo al arrancar | Lo tiene que hacer el operador | Cómo comprobarlo |
| :-- | :-- | :-- | :-- |
| `postgres` | Con el volumen vacío: roles `den_app` y `keycloak`, bases `keycloak` y `den_test` (`infra/postgres/init`) | Nada. Las contraseñas de `.env` se fijan aquí y solo aquí | `dc exec postgres pg_isready` |
| `keycloak` | Importa los realms `den-portal`, `den-gateway` y `den-citizens` si no existen, con los secretos de `.env` | Nada en un despliegue nuevo. En uno existente, aplicar los cambios de realm que pida la versión (§5.3), entre ellos la política de rotación de secretos de M3-04 y el segundo factor de M3-08 | `curl -fsS $DEN_PUBLIC_URL/auth/realms/den-portal/.well-known/openid-configuration` |
| `etcd` / `etcd-init` | `etcd-init`, antes de APISIX en cada arranque: el usuario de APISIX (solo `/apisix`), root y la autenticación activa (B-15) | Nada | `dc ps etcd` (healthy); `dc logs etcd-init` termina en `ready` |
| `apisix` | Lee `infra/apisix/config.yaml`; sin rutas ni objetos SSL hasta que el API reconcilie | **Nada a mano**: rutas, upstreams y objetos SSL los crea el API | `dc ps apisix` (healthy); §2.2 |
| `step-ca` | Primera vez: crea la CA y el provisioner `den-portal`. Siempre: `configure.sh` fija plantillas y duraciones, y crea `den-gateway-tls` si falta | Guardar la huella de la raíz si otro sistema la necesita (§5.4) | `dc exec step-ca step ca health --ca-url=https://localhost:9000 --root=/home/step/certs/root_ca.crt` |
| `tsa-init` / `tsa` | `tsa-init` crea una vez la cadena de la TSA; `tsa` firma sellos | Nada | `curl -fsS $DEN_PUBLIC_URL/tsa/api/v1/timestamp/certchain` devuelve PEM |
| `opa` | Pide el bundle al API cada 10–20 s; niega todo hasta tenerlo | Nada | `dc exec api wget -qO- 'http://opa:8181/health?bundles'` responde `{}` (200) solo con el bundle activo |
| `fluent-bit-transparency` | Escucha en 5170; envía al colector del API con reintentos | Nada | `dc exec api wget -qO- http://fluent-bit-transparency:2020/api/v1/health` |
| `opensearch` / `fluent-bit` | Índices `den-access-YYYY.MM` al llegar el primer log | En el host, `vm.max_map_count` (DEPLOYMENT §2) | `dc ps opensearch fluent-bit` (healthy) |
| `mailpit` | — | Guardar el usuario de `MAILPIT_UI_AUTH` | Abrir `$DEN_PUBLIC_URL/mail` |
| `migrate` | Aplica las migraciones pendientes (`prisma migrate deploy`) como dueño del esquema y termina: el único contenedor con `DATABASE_MIGRATION_URL` (A-2) | Nada | `dc ps -a migrate` muestra `exited (0)`; `dc logs migrate` |
| `api` | Seed idempotente (`DEN_ALLOW_SEED=true`), arranque de los trabajos en segundo plano y **reconciliación completa inmediata** de APISIX y Keycloak | Revisar el log del primer arranque | `dc logs api` muestra `Portal API listening on 4000 (country <código>)`; `curl -fsS $DEN_PUBLIC_URL/api/v1/health` → `{"status":"ok"}` |
| `web` | — | Nada | Abrir `$DEN_PUBLIC_URL` e iniciar sesión |
| `citizen-app` | — | Nada | Abrir `$DEN_PUBLIC_URL/citizen-app` |
| Proxy inverso | — | Configurar las rutas de DEPLOYMENT §5.2 **sin** `/api/v1/internal` ni `/api/v1/opa`, y con la administración de Keycloak cerrada (`DEN_KEYCLOAK_ADMIN_ALLOW`, B-28) | `curl -i $DEN_PUBLIC_URL/api/v1/opa/bundle.tar.gz` y `curl -i -X POST $DEN_PUBLIC_URL/api/v1/internal/subject-access` responden exactamente **404** (el de la web: un 401 quiere decir que llegó al API); `curl -i $DEN_PUBLIC_URL/auth/admin/` responde 403. `install.sh status` comprueba las tres cosas (M-26) |

Estado general de un vistazo: `dc ps` (todos `running`, y `healthy` los que tienen health check; `tsa-init` en `exited (0)`).

### 2.2 Comprobación de punta a punta

1. **Gateway sin token.** Con una API publicada, `curl -i $DEN_GATEWAY_PUBLIC_URL/<ruta>` responde `401`. Sin ninguna API publicada, APISIX responde `404`.
2. **Rutas reconciliadas.**
   ```bash
   dc exec api sh -c 'wget -qO- --header "X-API-KEY: $APISIX_ADMIN_KEY" http://apisix:9180/apisix/admin/routes'
   ```
   Cada versión publicada tiene una ruta `den-route-<apiVersionId>`. Con `.../apisix/admin/ssls` se ven `den-ssl-gateway` (TLS del gateway) y un `den-ssl-gateway-client-<entityId>` por cada proveedor con upstreams mTLS.
3. **Ensayo de la demo completo** (`scripts/demo.mjs`, los 11 pasos de `DEMO.md`). En el piloto se corre en la misma máquina, porque lee los logs del mock con `docker logs`:
   ```bash
   # una vez: compilar el verificador abierto (paso 11)
   pnpm --filter @den/transparency-verifier build      # o dentro de un contenedor node:24
   set -a; . ./.env; set +a
   DEN_API_URL=$DEN_PUBLIC_URL \
   CITIZEN_APP_TSA_ROOT_URL=$DEN_PUBLIC_URL/tsa/api/v1/timestamp/certchain \
   node scripts/demo.mjs
   ```
   Termina con código 0 si todo se comporta como dice el guion. Crea una API propia por corrida, así que se puede repetir.

### 2.3 Configuración funcional

| Qué | Dónde | Cuándo se aplica |
| :-- | :-- | :-- |
| País: autoridades, tipos de documento, sectores, finalidades, textos, `features`, vigencias, retención | `config/country/<código>.yaml` (`DEN_COUNTRY`); se valida al arrancar | Va dentro de las imágenes: **reconstruir** `api` y `web`. Las finalidades se cargan o refrescan con el seed |
| Finalidades adicionales | Consola del operador → Finalidades (`purpose.manage`) | Inmediato |
| Entidades | El solicitante se registra y pide el alta de su entidad; un `platform_reviewer` o `platform_admin` la aprueba (`entity_review.decide`) y el solicitante queda como `entity_admin`, que inscribe una app autenticadora en su siguiente ingreso (segundo factor, ADR-0035). El `platform_admin` también puede crearlas desde la consola (`entity_admin.create`) y suspenderlas, reactivarlas o darlas de baja (`entity_admin.decide`) | Inmediato |
| Personas de una entidad | El `entity_admin` invita por correo y asigna roles (ADR-0018) | Inmediato; los roles se leen en cada petición |
| Roles de plataforma | El seed se los da a los usuarios de demo (`infra/keycloak/README.md`). Una vez que hay un `platform_admin`, la consola (`/operator/platform-users`, M-03) muestra quién tiene cada rol, los otorga y los quita, y desactiva o activa una cuenta (`POST /api/v1/admin/platform-roles/grant\|revoke`, `/admin/users/disable\|enable`; `platform_admin` con segundo factor; el motivo es obligatorio). La persona se registra y entra una vez antes. La línea de comandos del servidor queda para el primer administrador y para la recuperación: `sudo ./install.sh platform-role grant <correo> <rol>` en el piloto, `node dist/admin/platform-roles-cli.js grant <correo> <rol>` en el contenedor del API en los demás despliegues (`revoke`, `list`). Todo queda auditado (`platform_role.granted`, `platform_role.revoked`, `user.disabled`, `user.enabled`) con el administrador o la línea de comandos como actor; el último `platform_admin` activo no puede perder el rol ni ser desactivado. Desactivar en la consola niega de inmediato toda petición de la cuenta al API; no toca al usuario de Keycloak (`RUNBOOK.md §2.2`) | De inmediato; el segundo factor se pide en el siguiente ingreso de la persona |
| Identidad de una cuenta | Quien perdió su usuario de Keycloak o cambió de correo se registraría como un desconocido y no tendría sus membresías ni sus roles (B-22). El operador vuelve a vincular la cuenta del portal al nuevo usuario de Keycloak (su ID, de la consola de Keycloak) y/o al nuevo correo: `sudo ./install.sh relink-identity <correo> [--sub <id del usuario en Keycloak>] [--new-email <correo>] --reason "..."`, `node dist/admin/identity-relink-cli.js ...` en el contenedor del API en los demás despliegues. Las membresías y los roles siguen con la cuenta. Queda auditado (`user.identity_relinked`, antes y después). Se niega si la nueva identidad ya entró al portal (resuelve primero esa cuenta). La persona inscribe de nuevo el segundo factor en el nuevo usuario de Keycloak | De inmediato |
| Usuarios de demo (piloto) | `sudo ./install.sh demo-users disable [--reason "..."]`, `node dist/admin/demo-users-cli.js disable` en el contenedor del API en los demás despliegues (`list` muestra su estado). Cada usuario de demo del archivo del realm queda desactivado en Keycloak (con sus sesiones cerradas) y en el portal, y pierde sus roles de plataforma; queda auditado (`user.disabled`, `platform_role.revoked`). Se niega mientras no haya un `platform_admin` activo que no sea usuario de demo, y no cambia nada si Keycloak no responde. Necesita `KEYCLOAK_ADMIN_USER` y `KEYCLOAK_ADMIN_PASSWORD`, que el contenedor del API no tiene (A-2): `install.sh` se los pasa solo a este comando, desde `.env`; en otros despliegues, `docker compose exec -e KEYCLOAK_ADMIN_USER -e KEYCLOAK_ADMIN_PASSWORD api …` con las dos en tu shell. Ningún comando lo deshace | De inmediato; la semilla los deja desactivados en cada arranque |
| Autorregistro | Realm `den-portal`: `registrationAllowed` y `verifyEmail`; el enlace de verificación dura 60 minutos (`actionTokenGeneratedByUserLifespan`, P-08) | Ya activo en realms nuevos; en uno existente, §5.3 |

> **Advertencia.** El piloto siempre carga el seed de demo, con entidades ficticias y usuarios de demo que conservan sus roles de plataforma. Dar cuentas y roles propios a las personas del operador con el comando anterior no los quita: `demo-users disable` sí, cuando ya los tienen. Aun así, un piloto es un entorno de demostración, no de producción (`DEPLOYMENT.md §8`). Después, el ensayo de la demo (§2.2) ya no corre en esa instalación.

## 3. Procesos en segundo plano del API

Todos corren dentro del proceso `api`. Con `DEN_WORKER=off` no corre ninguno.

| Proceso | Frecuencia | Qué hace | Si falla |
| :-- | :-- | :-- | :-- |
| Relevo del outbox | 1 s | Pasa las filas de `outbox` a colas de pg-boss | Las filas quedan sin `published_at` y se reintentan |
| Purga del outbox | Al arrancar y cada hora | Borra las filas de `outbox` relevadas hace más de `DEN_OUTBOX_RETENTION_DAYS` (7) días; las que aún no se han relevado se conservan | Se registra; la siguiente ronda las purga |
| `gateway.sync` | Al cambiar una versión de API | Reconciliador de APISIX: rutas, upstreams y plugins de esa versión | pg-boss reintenta; el error queda en `sync_state` |
| Reconciliación completa APISIX | Al arrancar y cada 5 min | Asegura el TLS del gateway (y renueva su certificado), recalcula todas las versiones servidas, con los certificados de cliente del gateway que necesiten, y borra huérfanos (objetos, y objetos SSL, que ninguna versión servida o en revisión necesita). Cada unidad de trabajo toma un advisory lock compartido con `gateway.sync` y las demás réplicas | Se registra por versión y por objeto SSL; la siguiente pasada corrige |
| `keycloak.sync` | Al cambiar una aplicación o sus secretos | Reconciliador de Keycloak: clientes `den-app-<uuid>` en `den-gateway`, secretos y su rotación (secreto rotado durante la ventana) | Igual que APISIX |
| Reconciliación completa Keycloak | Al arrancar y cada 5 min | Corrige la deriva de todos los clientes; una aplicación borrada, solo hasta que su cliente deshabilitado se haya aplicado después del borrado. Cada llamada a Keycloak se corta a los 10 s | — |
| `policy.sync` | Al cambiar suscripciones, versiones o certificados de aplicación | Actualiza el estado de sincronización de OPA; el bundle se genera cuando OPA lo pide | Las suscripciones quedan "Aprobada (activándose)" hasta que OPA reporta la revisión |
| `notification.dispatch` | Por evento de auditoría que notifica | Avisos en el portal y por correo | Reintentos de pg-boss |
| `invitation.email` | Por invitación | Correo de invitación | Reintentos durante horas |
| `audit.anchor_email` | Por anclaje | Correo del anclaje diario a los reguladores | Reintentos |
| `citizen.alert` | Por registro nuevo con aviso pedido | Webhook firmado a la aplicación ciudadana (`DEN_CITIZEN_APPS`) | Hasta 20 reintentos con espera exponencial (máx. 1 h) |
| Ciclo de vida de suscripciones | `DEN_LIFECYCLE_INTERVAL_SECONDS` (300 s) | Marca `expired` las vencidas y avisa de la renovación | — |
| Ciclo de vida de versiones | Igual | Retira las versiones deprecadas cuya fecha de retiro pasó (ADR-0019) | — |
| Ciclo de vida de credenciales | Igual | Avisa antes del vencimiento de los certificados y los marca `expired`; cierra las ventanas de rotación vencidas (la credencial anterior pasa a `expired`) | — |
| Anclaje de la bitácora | `DEN_AUDIT_ANCHOR_INTERVAL_SECONDS` (3600 s) | Sella con la TSA el último evento de cada día cerrado (zona del país) | Si la TSA no responde, reintenta en la siguiente ronda. Bloqueo consultivo: un solo nodo ancla |
| Sellado de transparencia | `DEN_TRANSPARENCY_SEAL_INTERVAL_SECONDS` (10 s) | Agrupa registros en lotes Merkle (hasta `DEN_TRANSPARENCY_BATCH_MAX`), firma y sella con la TSA | El lote queda pendiente y se reintenta. Un solo nodo sella |
| Purga de transparencia | Cada 6 h | Borra los registros que pasaron `retention.subjectAccessMonths` (nunca menos que el piso de la base) | — |

## 4. Rutina de operación

### 4.1 Comprobaciones diarias

| Qué | Cómo | Esperado |
| :-- | :-- | :-- |
| Servicios | `dc ps` | Todo `running`/`healthy` |
| Sincronización con el gateway | SQL 1 (§4.2) | Sin filas en `error` ni `drift`; `pending` solo unos segundos |
| Outbox | SQL 2 | Sin filas pendientes de más de un minuto |
| Bundle de OPA | `dc exec api wget -qO- 'http://opa:8181/health?bundles'` | 200 |
| Cadena de auditoría | Consola → Auditoría → "Verificar integridad", o `GET /api/v1/audit/verify` (`audit.read`) | Cadena íntegra; cada día cerrado con su anclaje |
| Registro de transparencia | `GET /api/v1/transparency/verify` (`audit.read`); `?fromSeq=N` para revisar solo lo nuevo | `status: valid`: sin registros alterados, borrados antes de tiempo ni insertados (si no, `invalid`), y ninguno atrasado en lote o sello (si no, `incomplete`) |
| Búfer de Fluent Bit | `dc exec api wget -qO- http://fluent-bit-transparency:2020/api/v1/metrics` | Sin reintentos acumulados |
| Disco | `docker system df -v` | Volúmenes `den_*` con margen |

Desde M5-06 las alertas de `ARCHITECTURE.md §9` llegan por correo al operador (Alertmanager), y el tablero `DEN · Operador` de Grafana resume el estado. Esta lista queda para la revisión manual y para cuando falte el perfil `observability`. La sincronización también se ve en `/operator/sync` (M5-07).

| Alerta | Primera acción |
| :-- | :-- |
| `DenGateway5xxRate` | `dc logs fluent-bit-errors` (errores del gateway, enmascarados); el uso del proveedor afectado (`/my-apis/usage`) |
| `DenGatewayLatencyHigh` | El panel de latencia: si sube la petición completa pero no la del gateway, es el proveedor |
| `DenTargetDown` | `dc ps` y los logs del servicio |
| `DenOpaBundleBehind`, `DenOpaBundleFetchFailing` | `dc logs opa`; que OPA alcance `OPA_PORTAL_URL` con su token |
| `DenReconcileFailing` | `/operator/sync`, filtro "con problemas": el último error y reintentar |
| `DenNodeOffline` | `/operator/nodes`; la entidad dueña del nodo recibe su propio aviso |
| `DenCertificateExpiring` | La renovación automática falló: logs del API y `dc ps step-ca` |
| `DenQueueBacklog` | Logs del API; SQL 2 (§4.2) |
| `DenTransparencyRecordsDropped` | `dc logs api` ("Transparency records dropped", conteos por motivo). `invalid`: un gateway o un Fluent Bit que envía un formato que el colector no conoce (versiones desfasadas); `unknown_subscription` o `route_mismatch`: registros que no corresponden a lo que OPA autorizó, posiblemente falsificados en la red `logs` |
| `DenTransparencyUnsealed` | `dc logs api` (el sellador: "Transparency sealing round failed", o `DEN_TRANSPARENCY_SIGNING_JWK is not set`); que el worker del API esté encendido (`DEN_WORKER`) |
| `DenAuditAnchorOverdue` | Un día terminado de la bitácora no tiene su anclaje diario (`den_audit_anchor_overdue_seconds`). `dc logs api` (el anclaje: "The TSA stamped the anchor ... in the future", errores de la TSA); que el API alcance `DEN_TSA_URL`; `GET /audit/verify` por un anclaje con fecha futura (`future_dated`), que bloquea el anclaje hasta que llegue su día y hay que investigar, no esperar |
| `DenTransparencyUnstamped` | `dc logs api` ("Checkpoint N not stamped yet"); que el API alcance `DEN_TSA_URL` y que sus sellos encadenen con `DEN_TSA_ROOTS_FILE` |

### 4.2 Consultas de diagnóstico

Con el dueño del esquema (solo lectura de hecho; no modificar datos a mano):

```bash
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

```sql
-- 1. Objetos fuera de sincronía (apisix | keycloak | opa)
SELECT target, system, status, attempts, last_error, updated_at
FROM sync_state WHERE status <> 'in_sync' ORDER BY updated_at;

-- 2. Mensajes del outbox sin relevar
SELECT topic, aggregate, attempts, last_error, created_at
FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 50;

-- 3. Últimas revisiones del bundle de OPA
SELECT revision, cardinality(subscription_ids) AS subscriptions, created_at
FROM policy_bundle ORDER BY created_at DESC LIMIT 5;

-- 4. Últimos anclajes y puntos de control
SELECT * FROM audit_anchor ORDER BY 1 DESC LIMIT 3;
SELECT seq, tree_size, sealed_at FROM transparency_checkpoint ORDER BY seq DESC LIMIT 3;
```

### 4.3 Logs

| Servicio | Comando | Notas |
| :-- | :-- | :-- |
| API | `dc logs -f api` | Errores de reconciliación, de la CA, de la TSA |
| OPA | `dc logs opa` | Descarga del bundle (`--log-format=json`); sin decision logs a propósito |
| APISIX | `dc logs apisix` | Solo el arranque. Sin access log (privacidad), y sus errores van a `fluent-bit-errors` |
| Rechazos del API | `dc logs api \| grep request_refused` | Una línea JSON por cada 400/401/403/404/409/429: `sub`, IP, ruta y código (M6-01). Una racha de 403/404 de un mismo `sub` o IP es un sondeo |
| Ingresos y administración de Keycloak | `dc logs keycloak \| grep -E "type=(LOGIN\|LOGOUT\|REGISTER)"` | Eventos del realm `den-portal` (M6-01); 90 días en la base de Keycloak |
| Errores del gateway | `dc logs fluent-bit-errors` | El error log de nginx, con la línea de la petición, la URI del upstream y los números enmascarados (M5-01) |
| Keycloak | `dc logs keycloak` | Arranque e importación de realms |

Los logs no contienen cuerpos, rutas reales ni query strings, y no deben contenerlos. Si se ve un número de documento en un log, es un incidente de privacidad (regla 2 de `CLAUDE.md`).

## 5. Tareas puntuales

### 5.1 Reiniciar un componente

| Componente | Impacto mientras está caído | Al volver |
| :-- | :-- | :-- |
| `api` | No hay portal; el gateway sigue con la última configuración; los registros de transparencia esperan en el búfer de Fluent Bit | Migraciones (`migrate`, antes), reconciliación completa (vuelve a escribir cada objeto con llave privada, B-31), vacía el outbox |
| `web` | No hay portal; el API sigue | — |
| `keycloak` | No se puede iniciar sesión ni emitir tokens de aplicación. La validación de los tokens vigentes (5 min) depende de la caché de JWKS de APISIX (sin probar, M6-04) | — |
| `apisix` | Sin tráfico | Lee la configuración de etcd |
| `etcd` | APISIX sigue con lo que tiene en memoria, sin cambios nuevos | — |
| `opa` | Sin tráfico (el gateway no puede decidir) | Descarga el bundle en 10–20 s |
| `step-ca` | No se emiten certificados (503 en el portal) | — |
| `tsa` | No se sellan lotes ni anclajes (quedan pendientes) | Se sellan en la siguiente ronda |
| `fluent-bit-transparency` | APISIX reintenta el envío | Reenvía lo del búfer en disco |
| `postgres` | Todo el plano de gobierno cae; el tráfico sigue | — |

```bash
dc restart <servicio>        # o: dc up -d <servicio> si cambió su configuración
```

### 5.2 Forzar la reconciliación

En la consola de sincronización (`/operator/sync`, M5-07), un `platform_admin` reintenta un objeto: se encola el trabajo de su reconciliador. La consola también muestra la deriva que se encontró, es decir, cambios hechos fuera del portal que el reconciliador deshizo. Reiniciar el API lanza una reconciliación completa de APISIX y Keycloak; si no, la pasada periódica corre cada 5 minutos. **Nunca** se corrige APISIX ni Keycloak a mano: el reconciliador lo revierte (regla 5).

La consola también lista, en "Versiones con un canal que ya no se acepta", las versiones cuyo tipo de upstream ya no aceptan la configuración del país (`features.upstreams`) o el despliegue (configuración de X-Road) (P-04, ADR-0029). Siguen funcionando. El operador decide: mantenerlas, pedir a la entidad una versión nueva por el nodo (la anterior no se puede revisar), o volver a aceptar el tipo en la configuración del país, lo que requiere una imagen nueva del API.

En "Nodos que no sirven el contrato publicado", la consola lista las versiones publicadas cuyo nodo informa, para la ruta del servicio de la versión, un OpenAPI distinto del publicado (con ambos SHA-256 y desde cuándo), o ninguno (P-02, `ARCHITECTURE.md §10`). El tráfico no se ve afectado: el gateway sigue enrutando con el contrato publicado. Los publicadores y administradores de la entidad reciben un aviso cuando una versión pasa de coincidir a ser distinta, y ven lo mismo en la ficha de la versión y en la página de nodos. Qué hacer lo decide la entidad: publicar una revisión o una versión nueva con lo que sirve el nodo, o volver a dejar en el nodo el OpenAPI publicado. "Sin informar" significa que el nodo no declara ningún servicio en esa ruta, o que el servicio no tiene OpenAPI en el nodo (su registro muestra rutas `(unknown)`): la entidad indica `openapi` en el archivo del servicio en el nodo.

### 5.2.1 Tráfico sintético para demos

`pnpm traffic:simulate [--from AAAA-MM-DD] [--days 30] [--scale 1] [--seed 42]` genera un mes de llamadas simuladas de las suscripciones activas de producción, para mostrar los indicadores, el uso y el mapa de intercambios sin tráfico real. Las llamadas tienen patrón de días hábiles y horario de oficina, negaciones con su razón y errores del proveedor.

- **Dónde quedan.** Escribe documentos con la forma del log de acceso en `den-access-synthetic-AAAA.MM`, con `gateway_node: synthetic`. Nunca hacen llamadas reales ni llevan datos personales.
- **Borrarlo.** `--clear` borra todo; `--tag` lo separa (las pruebas usan uno propio).
- **Restricción.** Solo desarrollo y demos: en producción exige `DEN_ALLOW_SYNTHETIC_TRAFFIC=true`. En el piloto se corre dentro del contenedor del API.

### 5.2.2 Prueba de carga del gateway (M6-03)

Mide si el gateway sostiene la carga de SPEC §9: 500 peticiones/s, con un p95 de la latencia que agrega el gateway (sin el proveedor) menor de 50 ms. Resultados, hallazgos y dimensionamiento en `docs/performance/M6-03.md`.

1. **La red a escala.** `pnpm load:seed` crea, si no existen, 200 entidades, 1.000 APIs publicadas, 200 aplicaciones y 5.000 suscripciones. Son sintéticas (prefijo `carga-`) y auditadas como cualquier cambio. Tarda unos 2 minutos, y los reconciliadores tardan unos minutos más en crear las rutas, los clientes y los datos de OPA.
   - Sus APIs usan el servicio de prueba: `DEN_DEV_NODES` lleva `carga-*=mock-salud:8000`.
   - En un entorno con `NODE_ENV=production` hace falta `DEN_ALLOW_LOAD_SEED=true`. Nunca sobre los datos de una red real: las entidades sintéticas aparecerían en el catálogo, los indicadores y la bitácora.
2. **La prueba.** `pnpm load:test [--rate 500] [--duration 5m] [--warmup 30s] [--seed]`:
   - prepara, como la demo, una API publicada y una aplicación con certificado y suscripción aprobada;
   - lanza k6 (`grafana/k6:2.3.0`, en su propio contenedor) contra `DEN_GATEWAY_PUBLIC_URL` con mTLS;
   - lee en Prometheus (`DEN_PROMETHEUS_PUBLIC_URL`, por omisión `http://localhost:9090`) la latencia que APISIX mide para su ruta.
   Sale con 1 si no se cumple. `DEN_LOAD_DEBUG=1` muestra las primeras fallas de cada usuario virtual de k6.
3. **Dónde correrla.** k6 necesita CPU propia: en la misma máquina que el gateway compite con él y el resultado mide la máquina, no el gateway. El criterio se valida en el entorno tipo producción del cierre de M6.

### 5.2.3 Prueba de resiliencia (M6-04)

`pnpm resilience:test [--outage 45s] [--portal-container den-api-1]` comprueba contra el stack que el gateway funciona sin el portal:

1. Prepara una aplicación con una suscripción activa, como la demo.
2. Detiene el portal y, durante la caída, alterna llamadas permitidas y negadas.
3. Reinicia OPA y APISIX sin el portal.
4. Lo devuelve y comprueba que el registro de transparencia tiene todas las llamadas de la caída y que una revocación vuelve a llegar al gateway.

Resultado en `docs/performance/M6-04.md`.

- **Piloto.** Detiene y arranca el contenedor del API. Durante la prueba el portal no responde a nadie: es una caída real.
- **Desarrollo.** El API corre en el host. El script levanta el suyo desde `apps/api/dist` (construirlo antes) y pide que `pnpm dev` esté detenido.

**Qué esperar en una caída real del portal.** El tráfico sigue con lo último que OPA tenía. Las alertas `DenTargetDown` (el API no responde a Prometheus) y `DenOpaBundleFetchFailing` (más de 2 min sin bundle) avisan al operador. Lo que se apruebe o revoque en el portal no llega al gateway hasta que vuelva. Para cortar ya una aplicación comprometida sin el portal, se detiene su cliente en Keycloak: sin token nuevo, sus llamadas se niegan cuando vence el que tiene (5 minutos).

### 5.3 Cambios en un realm de Keycloak existente

La importación no toca realms que ya existen. Los cambios se aplican con `kcadm.sh`:

```bash
dc exec keycloak sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080/auth --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"'
# ejemplo (M2-01): autorregistro con verificación de correo
dc exec keycloak /opt/keycloak/bin/kcadm.sh update realms/den-portal \
  -s registrationAllowed=true -s verifyEmail=true
```

En desarrollo el servidor es `http://localhost:8080` (sin `/auth`).

**Política de rotación de secretos (M3-04).** Se aplica desde el JSON del realm, sin borrar datos, con un script idempotente:

```bash
set -a; . ./.env; set +a
node scripts/keycloak-client-policies.mjs     # KEYCLOAK_URL y el administrador de master
```

En el piloto, `KEYCLOAK_URL` es la URL pública (`$DEN_PUBLIC_URL/auth`). Comprobación: en la consola de Keycloak, realm `den-gateway` → Client policies, aparece `den-secret-rotation` activa.

**Con `install.sh` (piloto).** `sudo ./install.sh realms` corre `keycloak-citizen-app.mjs` (el cliente de la app ciudadana en `den-citizens`, antes `carpeta-ciudadana`; DEPLOYMENT.md §5.4), `keycloak-portal-mfa.mjs` (sin `--demo-otp`) y este script en un contenedor de Node en la red de Compose, con la URL interna de Keycloak (`DEN_GATEWAY_KEYCLOAK_URL`) y el administrador de `master` del `.env`. `sudo ./install.sh update` lo corre después de reiniciar; si falla, lo dice y la actualización sigue.

**Segundo factor (M3-08, ADR-0021).** El flujo de login `den-browser` y el mapa de niveles se aplican también desde el JSON, con un script idempotente:

```bash
set -a; . ./.env; set +a
node scripts/keycloak-portal-mfa.mjs              # flujo, mapa acr y política OTP
node scripts/keycloak-portal-mfa.mjs --demo-otp   # además, los códigos de los usuarios de demo
```

- `--demo-otp` es solo para desarrollo y el piloto. Reimporta desde el JSON, con el mismo id, cada usuario semilla con rol crítico que aún no tenga código: vuelve a poner la contraseña de `DEN_DEMO_CRITICAL_PASSWORD` (`DEN_DEMO_USER_PASSWORD` si está vacía) y el código de `DEN_DEMO_TOTP_SECRET`. `--demo-critical-password` pone `DEN_DEMO_CRITICAL_PASSWORD` a esos mismos usuarios si existen y están activos (M-29; `install.sh realms` lo corre una vez, cuando agrega la variable). Con `DEN_KEYCLOAK_SMTP_HOST` definida, el script también aplica el servidor SMTP del realm (M-28). Se salta un usuario de demo desactivado en Keycloak (`demo-users disable`), para no volver a activarlo.
- **Enlace de verificación (P-08).** El mismo script fija cuánto duran los enlaces de verificación del correo y de restablecimiento de contraseña (`actionTokenGeneratedByUserLifespan`, 60 minutos; Keycloak trae 5).
- Comprobación: en la consola de Keycloak, realm `den-portal` → Authentication, `den-browser` está ligado al navegador. `pnpm demo:otp` imprime el código vigente de los usuarios de demo y la clave para una app autenticadora.
- **Aviso de credencial.** Keycloak le escribe al dueño de la cuenta cuando se pone o se quita una contraseña o un segundo factor, y guarda esos eventos 90 días (realm `den-portal` → Events). Si alguien dice que no enroló el segundo factor que recibió en el aviso, trátalo como un incidente: deshabilita la cuenta en Keycloak, borra la credencial OTP y restablece la contraseña antes de volver a habilitarla.
- **Segundo factor perdido.** El administrador de Keycloak borra la credencial OTP de la persona (Users → la persona → Credentials). La próxima vez que el portal pida el código, Keycloak le pide enrolar una app nueva. Comprueba antes la identidad de quien lo pide, por un canal distinto del correo de la cuenta.

### 5.4 Huella de la raíz de la CA

```bash
dc exec step-ca step certificate fingerprint certs/root_ca.crt
```

Es el valor de `DEN_STEP_CA_ROOT_FINGERPRINT` para un API que no monta el volumen de la CA.

### 5.5 Credenciales de las aplicaciones

La rotación y la revocación de los secretos y certificados de las aplicaciones las hacen sus desarrolladores desde la ficha de la aplicación (M3-04); el operador no interviene.

- Durante una rotación, el secreto o certificado anterior sigue funcionando `lifecycle.credentialRotationDays`.
- Revocar un certificado lo saca del gateway con la siguiente descarga del bundle (10–20 s).
- Revocar un secreto lo saca de Keycloak cuando corre el reconciliador (`keycloak.sync`, segundos).
- Si una revocación no surte efecto, revisar SQL 1 (§4.2) con `system = 'keycloak'` u `'opa'`.

### 5.6 Rotación de secretos de la plataforma

| Secreto | Cómo rotarlo hoy |
| :-- | :-- |
| `APISIX_ADMIN_KEY`, `OPA_BUNDLE_TOKEN`, `DEN_TRANSPARENCY_INGEST_TOKEN` | Cambiar en `.env` y recrear a la vez los servicios que lo usan (`apisix` + `api`; `opa` + `api`; `fluent-bit-transparency` + `api`) |
| `AUTH_SECRET` | Cambiar y recrear `web`: todas las sesiones se cierran |
| Secretos de clientes de Keycloak (`DEN_PORTAL_WEB_CLIENT_SECRET`, `DEN_GATEWAY_PROVISIONER_SECRET`, `DEN_CITIZEN_APP_CLIENT_SECRET`) | Cambiar el secreto del cliente en Keycloak (consola o `kcadm`) **y** en `.env`, y recrear `web`, `api` o `citizen-app` |
| Contraseñas de PostgreSQL | `ALTER ROLE ... PASSWORD` **y** `.env` (con sus URLs), y recrear los servicios |
| `DEN_TRANSPARENCY_SIGNING_JWK` | Clave nueva con otro `kid`; la pública anterior va a `DEN_TRANSPARENCY_RETIRED_JWKS`. Procedimiento completo pendiente para producción |
| Certificados del gateway (servidor y clientes hacia proveedores) | Los renueva solo el reconciliador de APISIX; para forzarlo, reiniciar el API tras borrar la fila de `gateway_certificate` correspondiente |
| `DEN_SECRETS_KEY` (sella los secretos de cliente pendientes y las claves privadas del gateway) | 1. Generar la nueva (32 bytes base64), ponerla en `DEN_SECRETS_KEY` y pasar la anterior a `DEN_SECRETS_KEYS_PREVIOUS`. 2. Recrear el API (`dc up -d api`): lo nuevo se sella con la nueva y lo anterior se sigue abriendo. 3. Resellar: `dc exec api node dist/secrets/main.js` (en desarrollo, `pnpm --filter @den/api secrets:reseal`). Es idempotente y deja `secrets.resealed` en la bitácora. 4. Vaciar `DEN_SECRETS_KEYS_PREVIOUS` y recrear el API. Si el resellado encuentra un valor que ninguna clave abre, se detiene sin cambiar nada más: falta una clave anterior |
| Clave de firma de la aserción del gateway (M6-10) | La rota sola el portal cada `lifecycle.assertionKeyRotationDays` (90 días); la anterior sigue en el JWKS. Para rotarla ya: `POST /api/v1/admin/gateway-signing-keys/rotate` como `platform_admin`; con `"compromised": true` la anterior sale del JWKS (`RUNBOOK.md §2.2`) |
| `DEN_OPA_DECISION_TOKEN` | Cambiar en `.env` y recrear a la vez `opa` y `api`: la pasada completa del API reescribe las rutas con el nuevo; mientras tanto el gateway responde 503 |
| `DEN_OPA_ADMIN_TOKEN` | Cambiar en `.env` y recrear `opa` |
| `APISIX_ETCD_PASSWORD` | Cambiar en `.env` y correr `dc up -d`: `etcd-init` la pone en etcd y APISIX se recrea con ella |
| `ETCD_ROOT_PASSWORD` (credenciales de etcd) | No se cambia por `.env` una vez activa la autenticación: `etcd-init` se detiene con un mensaje y APISIX no arranca. Cámbiala primero en etcd, como root: `dc exec etcd etcdctl --user="root:<anterior>" user passwd root` (pide la nueva), y luego en `.env`. Si se perdió la anterior: `dc stop apisix etcd`, `docker volume rm den_etcd-data`, `dc up -d`; etcd arranca vacío, `etcd-init` vuelve a poner los usuarios y el reconciliador del API reescribe todo el gateway desde PostgreSQL (`§5.2`) |
| `DEN_SUBJECT_REF_KEY`, `DEN_END_USER_HASH_SALT` | **No se rotan**: rompen el vínculo con los registros anteriores (`DEPLOYMENT.md §4.1`) |
| CA intermedia | `RUNBOOK.md §3` |

### 5.7 Una versión nueva del kit del nodo (P-03)

El kit se publica en su propio repositorio. Cuando sale un release, como `platform_admin` (con segundo factor):

1. **Consola del operador → Kit del nodo → Definir la versión vigente:** la versión (`0.2.0`), el enlace al paquete del release (`https://…/den-node-kit-0.2.0.tar.gz`), su tamaño en bytes y su SHA-256 (el archivo `.sha256` del release, o `sha256sum` del archivo descargado). Al guardar pasa a ser la vigente de inmediato en la página _Nodos del kit_ de cada entidad y en `/kit`; la bitácora registra `kit_release.created` y `kit_release.made_current`.
2. **Espejo (opcional)**, para entidades cuyos servidores alcanzan el portal pero no GitHub: en la fila de la versión, elige el paquete descargado y **Subir al espejo**. El portal solo lo acepta con ese tamaño y ese SHA-256 y lo sirve en `<portal>/kit/<versión>/<archivo>` (y `<archivo>.sha256`), sin sesión; después no se puede reemplazar. La página ofrece entonces los dos enlaces. Un paquete más grande que `DEN_KIT_BUNDLE_MAX_BYTES` (128 MiB) se rechaza: aumenta ese valor en el API y recréalo, y revisa el límite de cuerpo del proxy (`DEPLOYMENT.md §5.2`).
3. **Volver atrás:** **Hacer vigente** en una versión anterior. **Corregir** una versión (enlace, tamaño o suma equivocados) con su formulario; una vez en el espejo solo cambian los campos de la firma.
4. Entrega a cada entidad la suma (y, cuando los releases se firmen, la clave del operador) **también por otro canal**, por ejemplo el acuerdo: quien controla el portal controla tanto el archivo como la suma que muestra.

El seed de desarrollo deja v0.2.0 como vigente solo mientras el portal no tiene ningún release.

## 6. Respaldos

Las bases `den` y `keycloak` se respaldan con pgBackRest en el piloto y con Barman Cloud en Kubernetes (ADR-0026). Las dos permiten volver a cualquier instante de la retención, no solo al último respaldo.

### 6.1 Piloto (Compose): pgBackRest

- **Continuo.** PostgreSQL archiva cada segmento de WAL en el repositorio `pgbackrest-repo`, al menos cada 5 minutos: se pierden como mucho 5 minutos de cambios. El repositorio va cifrado (AES-256) con `PGBACKREST_REPO1_CIPHER_PASS`.
- **Programado.** El servicio `pgbackrest` toma un respaldo completo los domingos y uno diferencial los demás días, a las 02:00 UTC (`DEN_BACKUP_FULL_DAY`, `DEN_BACKUP_HOUR`). Conserva cuatro completos: se puede volver a cualquier instante del último mes.
- **Estado:** `dc exec pgbackrest pgbackrest --stanza=den info` muestra los respaldos y el rango de WAL archivado. `dc logs pgbackrest` muestra cada respaldo. Si `info` dice algo distinto de `status: ok`, o el último respaldo tiene más de dos días, hay que revisarlo.

**La clave `PGBACKREST_REPO1_CIPHER_PASS` se guarda fuera del servidor**, con la copia del `.env`. Sin ella no se puede restaurar ningún respaldo.

**El repositorio vive en el mismo servidor.** No protege de la pérdida del disco ni de la máquina. `sudo ./install.sh backup` copia todo salvo `.env` a `backups/<fecha>/`, para llevarlo fuera del servidor, y conserva los `DEN_BACKUP_KEEP` más recientes (5 por omisión):
- un respaldo completo de pgBackRest y el repositorio entero (`pgbackrest-repo.tgz`, ya cifrado);
- los volcados lógicos `den.dump` y `keycloak.dump`, que sirven para restaurar en otra versión de PostgreSQL o en otra plataforma (del piloto a Kubernetes);
- los volúmenes (tabla de abajo).

**`.env` no va ahí (M-30).** Tiene la clave del repositorio (`PGBACKREST_REPO1_CIPHER_PASS`), la contraseña de la CA y todos los demás secretos: un repositorio cifrado junto a su clave no protege nada. Guarda `.env` fuera del servidor, en otro lugar que los respaldos (un gestor de contraseñas o la bóveda del operador).

Hazlo antes de cada actualización y con regularidad.

**Restaurar la base** (`sudo ./install.sh restore`):

| Caso | Comando |
| :-- | :-- |
| Volver al último estado archivado (el volumen de datos se dañó o se perdió) | `sudo ./install.sh restore` |
| Volver a un instante (un borrado o una migración que salió mal) | `sudo ./install.sh restore "2026-11-20 14:30:00-05"` |

El comando:
1. muestra los respaldos;
2. pide confirmación;
3. detiene todo y restaura la base con `pgbackrest --delta restore`, que solo reescribe lo que cambió;
4. arranca de nuevo y toma un respaldo completo en la nueva línea de tiempo.

Lo escrito después del instante elegido se pierde. Después de restaurar:
- revisa la cadena de auditoría (Consola → Auditoría → "Verificar integridad");
- revisa que nada quede fuera de sincronía con el gateway (§4.2). Los reconciliadores llevan APISIX, OPA y Keycloak al estado de la base restaurada.

**Si se perdió el servidor** (`sudo ./install.sh restore-volumes <carpeta>`, M-30):
1. En el servidor nuevo, con el DNS apuntando a él: clona el repositorio en la misma versión y pon el `.env` guardado en su raíz (permisos 600). No corras antes `sudo ./install.sh`: su arranque inicializaría una base vacía.
2. Copia la carpeta del respaldo (`backups/<fecha>/`, con `pgbackrest-repo.tgz`) al servidor.
3. `sudo ./install.sh restore-volumes <carpeta>`. Revisa el servidor y que no corra nada de esta instalación, crea imágenes, redes y volúmenes sin arrancar nada (`docker compose create`), llena `pgbackrest-repo`, `step-ca-data`, `tsa-data`, `api-documents` y `citizen-app-data` desde sus `.tgz`, restaura la base en el volumen de datos vacío desde el repositorio (el último estado archivado) y solo entonces arranca todo y toma un respaldo completo en la nueva línea de tiempo.
4. Revisa la cadena de auditoría y el gateway (§4.2), como después de cualquier restauración.

**La prueba del procedimiento:** `pnpm restore:test`, también en CI. Usa la misma imagen y los mismos comandos, en contenedores aparte. Prueba la pérdida del volumen de datos, la pérdida del servidor (el repositorio desde su archivo, desempacado en volúmenes nuevos y restaurado antes de que arranque PostgreSQL: los pasos de `restore-volumes`), la recuperación a un instante, un respaldo después de restaurar y que el repositorio no se lee sin su clave.

**Otros datos** que `install.sh backup` guarda aparte:

| Qué | Por qué | Cómo se restaura |
| :-- | :-- | :-- |
| Volumen `step-ca-data` | Claves de la CA: sin él, todos los certificados quedan huérfanos | `docker run --rm -v den_step-ca-data:/v -v "$PWD":/b alpine tar xzf /b/step-ca-data.tgz -C /v`, con el servicio detenido |
| Volumen `tsa-data` | Cadena y clave de la TSA de desarrollo (los sellos ya emitidos se verifican con la cadena) | Igual, con `den_tsa-data` |
| Volumen `api-documents` | Documentos subidos (designaciones, acuerdos) | Igual, con `den_api-documents` |
| `.env` (no va en `backups/`) | Claves sin las que los datos no se pueden verificar, seudonimizar igual ni restaurar | Copia cifrada fuera de la máquina, aparte de los respaldos |

No hace falta respaldar `etcd-data` (se reconstruye desde PostgreSQL), OPA (guarda solo una copia del bundle) ni `opensearch-data` (analítica, se puede perder). `transparency-buffer` solo tiene lo que aún no llegó al API.

### 6.2 Kubernetes: Barman Cloud

El chart `den` archiva el WAL y toma un respaldo base diario de las dos bases (`den-db` y `den-keycloak-db`) en el almacenamiento S3-compatible del operador (`postgres.backup`, `DEPLOYMENT.md §9.5`). La retención es de 30 días por omisión.
- **Estado:** `kubectl get backups,scheduledbackups -n den`, y en cada `Cluster` las condiciones `ContinuousArchiving` y `LastBackupSucceeded` (`kubectl cnpg status den-db`).
- **Restaurar:** se crea un `Cluster` nuevo con `bootstrap.recovery`, con el `ObjectStore` `den-db-backup` como origen (plugin `barman-cloud.cloudnative-pg.io`, `serverName` = nombre del cluster original). Para volver a un instante, se agrega `recoveryTarget.targetTime`. Luego se apunta el API (o Keycloak) al cluster nuevo.
- **Prueba:** el procedimiento no está probado en un clúster: el chart no se ha instalado (M6-05). Se prueba en la primera instalación, contra el almacenamiento real del operador.

## 7. Problemas frecuentes

| Síntoma | Causa probable | Qué hacer |
| :-- | :-- | :-- |
| El gateway responde `503` a toda llamada | OPA rechaza al gateway (401): las rutas aún no llevan `DEN_OPA_DECISION_TOKEN`, u OPA y el API tienen valores distintos | El mismo valor para `opa` y `api` en `.env`; recrear los dos; la pasada completa del API reescribe las rutas (`§5.2`). `dc logs opa` muestra `resp_status: 401` en `/v1/data/den/authz/decision` |
| `apisix` no arranca; `etcd-init` salió con error | etcd no responde, o `ETCD_ROOT_PASSWORD` no es la contraseña de root de etcd | `dc logs etcd-init`; §5.6, `ETCD_ROOT_PASSWORD` |
| El gateway responde `403` a todo, incluso con suscripción | OPA sin bundle: el API no puede construirlo (falta, es corta o es el valor de ejemplo `DEN_SUBJECT_REF_KEY` o `DEN_END_USER_HASH_SALT`) o OPA no alcanza `OPA_PORTAL_URL` | `dc logs opa`, `dc logs api`; revisar esas variables y `OPA_BUNDLE_TOKEN` |
| Suscripción "Aprobada (activándose)" que no pasa a "Activa" | OPA no descargó ni reportó la revisión nueva | `health?bundles` de OPA; SQL 1 con `system = 'opa'` |
| API publicada que no aparece en el gateway (`404`) | Error del reconciliador de APISIX | SQL 1 con `system = 'apisix'`; `dc logs api`; revisar `APISIX_ADMIN_URL` y `APISIX_ADMIN_KEY` |
| La aplicación no pasa a "Lista" | Error del reconciliador de Keycloak | SQL 1 con `system = 'keycloak'`; revisar `KEYCLOAK_URL` y `DEN_GATEWAY_PROVISIONER_SECRET` (debe coincidir con el del realm) |
| `api` termina al arrancar con un mensaje de configuración | `DEN_COUNTRY` sin valor o YAML del país inválido | Corregir el YAML y reconstruir la imagen |
| `api` no arranca: error de migración | Migración fallida o base inaccesible como dueño | `dc logs api`; `dc exec api node_modules/.bin/prisma migrate status` |
| Subir un documento falla con 503 ("el antivirus no respondió") | `DEN_CLAMAV_URL` está puesto y ClamAV no responde: arrancando (descarga firmas unos minutos), caído o sin memoria | `dc ps clamav`, `dc logs clamav`; esperar a que esté sano. Sin antivirus, quitar `DEN_CLAMAV_URL` y recrear el API (los documentos solo se comprobarán como PDF) |
| Subir un documento falla ("No pudimos completar la operación"); el log del API dice `EACCES: mkdir '/repo/apps/api/data'` | `.env` tiene el valor de desarrollo `DEN_DOCUMENTS_DIR=data/documents` (despliegues generados antes de P-06) y el API corre un overlay de despliegue sin el valor fijo | `sudo ./install.sh update` lo corrige; a mano, poner `DEN_DOCUMENTS_DIR=/var/lib/den/documents` en `.env` y recrear el API (`dc up -d api`). Las subidas que fallaron hay que repetirlas |
| No se emiten certificados (503) | step-ca caído, contraseña del provisioner distinta, o raíz no configurada con `NODE_ENV=production` | `dc logs api` (mensajes `step-ca: ...`); `DEN_STEP_CA_PROVISIONER_PASSWORD` = `STEP_CA_PASSWORD`; `DEN_STEP_CA_ROOT_FILE` |
| `sync_state` en error para `apisix:ssl:...` | step-ca no responde, falta el provisioner `den-gateway-tls` (step-ca sin recrear) o cambió `DEN_SECRETS_KEY` | `dc logs api`; `dc up -d step-ca`; §5.6 |
| Upstream `direct` que responde 502 | El gateway ahora verifica el certificado del proveedor (vencido, autofirmado o de otro nombre), o el proveedor con mTLS no acepta `CN=den-gateway.<slug>` | Pedir al proveedor un certificado público válido para su nombre, o que confíe en la CA de la red y en ese nombre |
| Una aplicación recibe 429 `rate_limited` antes de su límite | Con varios nodos del gateway, el límite se reparte entre ellos (`DEN_GATEWAY_NODES`) y el balanceo no es parejo (ADR-0020) | Revisar que `DEN_GATEWAY_NODES` sea el número real de nodos; balancear por hash del origen |
| El gateway responde 500 a llamadas permitidas | `limit-count` sin un límite entero positivo (bundle viejo de OPA, sin `X-DEN-Rate-Limit`) | `health?bundles` de OPA; que el API sirva el bundle actual |
| Al rotar un secreto, el anterior deja de funcionar enseguida | Falta la política de rotación en el realm `den-gateway` existente | §5.3 |
| El ciudadano no ve sus consultas | Registros detenidos en Fluent Bit (token o host del colector) o la operación no declara titular | `dc logs fluent-bit-transparency`; `DEN_TRANSPARENCY_INGEST_TOKEN` y `DEN_TRANSPARENCY_COLLECTOR_HOST` |
| Consultas que siguen "En sellado" | TSA no responde o falta `DEN_TRANSPARENCY_SIGNING_JWK` | `dc logs api`; `dc ps tsa` |
| Inicio de sesión en bucle o error de emisor | `KC_HOSTNAME`, `KEYCLOAK_URL` o `AUTH_URL` no coinciden con la URL pública | Revisar `DEN_PUBLIC_URL` y las URLs derivadas (`DEPLOYMENT.md §4.2`) |
| Un cambio en un realm JSON no se ve | La importación ignora realms existentes | §5.3 |
| OpenSearch no arranca | `vm.max_map_count` bajo o poca memoria | `DEPLOYMENT.md §2` |
