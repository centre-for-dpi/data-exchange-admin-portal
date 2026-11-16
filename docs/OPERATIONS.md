# Guía de operación — Portal RID

Versión 0.2 · noviembre 2026 · estado del código con M3-01 a M3-04 (M3 en curso)

Qué hace cada componente al arrancar, qué tiene que hacer o correr el operador para dejarlo operativo, cómo comprobar que funciona y qué revisar en el día a día. Cómo se despliega cada pieza está en [`DEPLOYMENT.md`](DEPLOYMENT.md). El runbook completo de incidentes, rotación de la CA intermedia y revocación masiva es M6-07.

## 0. Convenciones

En el piloto todos los comandos se corren en la raíz del clon, con este atajo:

```bash
alias dc='docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml --env-file .env --profile observability'
```

En desarrollo, el equivalente es `docker compose -f infra/compose/docker-compose.yml --env-file .env --profile observability` (o `pnpm infra:ps` / `pnpm infra:logs`), y el API corre en el host (`pnpm dev`), así que los comandos `dc exec api ...` se reemplazan por llamadas a `localhost`.

Los servicios internos no tienen puertos publicados en el piloto. Para hablar con ellos se usa el contenedor `api`, que tiene `wget` y está en la misma red:

```bash
dc exec api wget -qO- http://opa:8181/health
```

## 1. Mapa de dependencias y orden de arranque

```
postgres ──▶ keycloak ─────────────┐
etcd ──────▶ apisix ───────────────┤
step-ca ───────────────────────────┼──▶ api ──▶ web
tsa-init ──▶ tsa ──────────────────┘      └───▶ carpeta
opa ················ descarga el bundle de api (reintenta solo)
fluent-bit-transparency ··· envía registros a api (búfer en disco mientras api no responde)
opensearch ──▶ fluent-bit ··· recibe logs de analítica de apisix
mailpit ··· recibe el correo de api, keycloak y carpeta
```

Compose respeta este orden con `depends_on` y health checks: `api` espera a `postgres`, `step-ca`, `keycloak` y `apisix` sanos y a que `tsa` haya arrancado; `web` y `carpeta` esperan a `api` sano. OPA y los Fluent Bit no dependen del API: reintentan hasta que responde.

**Plano de datos vs. plano de gobierno.** Si `api`, `web` o `keycloak` caen, el gateway sigue atendiendo con la última configuración de etcd y el último bundle de OPA. Sin Keycloak no se emiten tokens nuevos, y la validación de los vigentes depende de que APISIX tenga en caché las claves (JWKS) del realm; no está probado todavía (M6-04). Si cae `apisix`, `etcd` u `opa`, se corta el tráfico.

## 2. Puesta en marcha (día 0)

### 2.1 Qué hace cada componente solo y qué hay que hacer

| Componente | Lo hace solo al arrancar | Lo tiene que hacer el operador | Cómo comprobarlo |
| :-- | :-- | :-- | :-- |
| `postgres` | Con el volumen vacío: roles `rid_app` y `keycloak`, bases `keycloak` y `rid_test` (`infra/postgres/init`) | Nada. Las contraseñas de `.env` se fijan aquí y solo aquí | `dc exec postgres pg_isready` |
| `keycloak` | Importa los realms `rid-portal`, `rid-gateway` y `rid-citizens` si no existen, con los secretos de `.env` | Nada en un despliegue nuevo. En uno existente, aplicar los cambios de realm que pida la versión (§5.3), entre ellos la política de rotación de secretos de M3-04 y el segundo factor de M3-08 | `curl -fsS $RID_PUBLIC_URL/auth/realms/rid-portal/.well-known/openid-configuration` |
| `etcd` | — | Nada | `dc ps etcd` (healthy) |
| `apisix` | Lee `infra/apisix/config.yaml`; sin rutas ni objetos SSL hasta que el API reconcilie | **Nada a mano**: rutas, upstreams y objetos SSL los crea el API | `dc ps apisix` (healthy); §2.2 |
| `step-ca` | Primera vez: crea la CA y el provisioner `rid-portal`. Siempre: `configure.sh` fija plantillas y duraciones, y crea `rid-gateway-tls` si falta | Guardar la huella de la raíz si otro sistema la necesita (§5.4) | `dc exec step-ca step ca health --ca-url=https://localhost:9000 --root=/home/step/certs/root_ca.crt` |
| `tsa-init` / `tsa` | `tsa-init` crea una vez la cadena de la TSA; `tsa` firma sellos | Nada | `curl -fsS $RID_PUBLIC_URL/tsa/api/v1/timestamp/certchain` devuelve PEM |
| `opa` | Pide el bundle al API cada 10–20 s; niega todo hasta tenerlo | Nada | `dc exec api wget -qO- 'http://opa:8181/health?bundles'` responde `{}` (200) solo con el bundle activo |
| `fluent-bit-transparency` | Escucha en 5170; envía al colector del API con reintentos | Nada | `dc exec api wget -qO- http://fluent-bit-transparency:2020/api/v1/health` |
| `opensearch` / `fluent-bit` | Índices `rid-access-YYYY.MM` al llegar el primer log | En el host, `vm.max_map_count` (DEPLOYMENT §2) | `dc ps opensearch fluent-bit` (healthy) |
| `mailpit` | — | Guardar el usuario de `MAILPIT_UI_AUTH` | Abrir `$RID_PUBLIC_URL/mail` |
| `api` | Migraciones (`prisma migrate deploy`), seed idempotente (`RID_ALLOW_SEED=true`), arranque de los trabajos en segundo plano y **reconciliación completa inmediata** de APISIX y Keycloak | Revisar el log del primer arranque | `dc logs api` muestra `Portal API listening on 4000 (country <código>)`; `curl -fsS $RID_PUBLIC_URL/api/v1/health` → `{"status":"ok"}` |
| `web` | — | Nada | Abrir `$RID_PUBLIC_URL` e iniciar sesión |
| `carpeta` | — | Nada | Abrir `$RID_PUBLIC_URL/carpeta` |
| Proxy inverso | — | Configurar las rutas de DEPLOYMENT §5.2 **sin** `/api/v1/internal` ni `/api/v1/opa` | `curl -i $RID_PUBLIC_URL/api/v1/opa/bundle.tar.gz` **no** debe llegar al API (404 del proxy o de la web) |

Estado general de un vistazo: `dc ps` (todos `running`, y `healthy` los que tienen health check; `tsa-init` en `exited (0)`).

### 2.2 Comprobación de punta a punta

1. **Gateway sin token.** Con una API publicada, `curl -i $RID_GATEWAY_PUBLIC_URL/<ruta>` responde `401`. Sin ninguna API publicada, APISIX responde `404`.
2. **Rutas reconciliadas.**
   ```bash
   dc exec api sh -c 'wget -qO- --header "X-API-KEY: $APISIX_ADMIN_KEY" http://apisix:9180/apisix/admin/routes'
   ```
   Cada versión publicada tiene una ruta `rid-route-<apiVersionId>`. Con `.../apisix/admin/ssls` se ven `rid-ssl-gateway` (TLS del gateway) y un `rid-ssl-gateway-client-<entityId>` por cada proveedor con upstreams mTLS.
3. **Ensayo de la demo completo** (`scripts/demo.mjs`, los 11 pasos de `DEMO.md`). En el piloto se corre en la misma máquina, porque lee los logs del mock con `docker logs`:
   ```bash
   # una vez: compilar el verificador abierto (paso 11)
   pnpm --filter @rid/transparency-verifier build      # o dentro de un contenedor node:24
   set -a; . ./.env; set +a
   RID_API_URL=$RID_PUBLIC_URL \
   CITIZEN_APP_TSA_ROOT_URL=$RID_PUBLIC_URL/tsa/api/v1/timestamp/certchain \
   node scripts/demo.mjs
   ```
   Termina con código 0 si todo se comporta como dice el guion. Crea una API propia por corrida, así que se puede repetir.

### 2.3 Configuración funcional

| Qué | Dónde | Cuándo se aplica |
| :-- | :-- | :-- |
| País: autoridades, tipos de documento, sectores, finalidades, textos, `features`, vigencias, retención | `config/country/<código>.yaml` (`RID_COUNTRY`); se valida al arrancar | Va dentro de las imágenes: **reconstruir** `api` y `web`. Las finalidades se cargan o refrescan con el seed |
| Finalidades adicionales | Consola del operador → Finalidades (`purpose.manage`) | Inmediato |
| Entidades | El solicitante se registra y pide el alta de su entidad; un `platform_reviewer` o `platform_admin` la aprueba (`entity_review.decide`) y el solicitante queda como `entity_admin`. El `platform_admin` también puede crearlas desde la consola (`entity_admin.create`) y suspenderlas, reactivarlas o darlas de baja (`entity_admin.decide`) | Inmediato |
| Personas de una entidad | El `entity_admin` invita por correo y asigna roles (ADR-0018) | Inmediato; los roles se leen en cada petición |
| Roles de plataforma | **Hoy solo los asigna el seed** a los usuarios semilla del realm (`infra/keycloak/README.md`) | Ver la advertencia siguiente |
| Autorregistro | Realm `rid-portal`: `registrationAllowed` y `verifyEmail` | Ya activo en realms nuevos; en uno existente, §5.3 |

> **Advertencia.** No existe todavía una forma de dar el primer `platform_admin` de un despliegue real sin el seed de demo, que además crea entidades ficticias. Mientras no exista, un piloto es un entorno de demostración, no de producción (`DEPLOYMENT.md §8`).

## 3. Procesos en segundo plano del API

Todos corren dentro del proceso `api`. Con `RID_WORKER=off` no corre ninguno.

| Proceso | Frecuencia | Qué hace | Si falla |
| :-- | :-- | :-- | :-- |
| Relevo del outbox | 1 s | Pasa las filas de `outbox` a colas de pg-boss | Las filas quedan sin `published_at` y se reintentan |
| `gateway.sync` | Al cambiar una versión de API | Reconciliador de APISIX: rutas, upstreams y plugins de esa versión | pg-boss reintenta; el error queda en `sync_state` |
| Reconciliación completa APISIX | Al arrancar y cada 5 min | Asegura el TLS del gateway (y renueva su certificado), recalcula todas las versiones servidas, con los certificados de cliente del gateway que necesiten, y borra huérfanos | Se registra por versión y por objeto SSL; la siguiente pasada corrige |
| `keycloak.sync` | Al cambiar una aplicación o sus secretos | Reconciliador de Keycloak: clientes `rid-app-<uuid>` en `rid-gateway`, secretos y su rotación (secreto rotado durante la ventana) | Igual que APISIX |
| Reconciliación completa Keycloak | Al arrancar y cada 5 min | Corrige la deriva de todos los clientes | — |
| `policy.sync` | Al cambiar suscripciones, versiones o certificados de aplicación | Actualiza el estado de sincronización de OPA; el bundle se genera cuando OPA lo pide | Las suscripciones quedan "Aprobada (activándose)" hasta que OPA reporta la revisión |
| `notification.dispatch` | Por evento de auditoría que notifica | Avisos en el portal y por correo | Reintentos de pg-boss |
| `invitation.email` | Por invitación | Correo de invitación | Reintentos durante horas |
| `audit.anchor_email` | Por anclaje | Correo del anclaje diario a los reguladores | Reintentos |
| `citizen.alert` | Por registro nuevo con aviso pedido | Webhook firmado a la aplicación ciudadana (`RID_CITIZEN_APPS`) | Hasta 20 reintentos con espera exponencial (máx. 1 h) |
| Ciclo de vida de suscripciones | `RID_LIFECYCLE_INTERVAL_SECONDS` (300 s) | Marca `expired` las vencidas y avisa de la renovación | — |
| Ciclo de vida de versiones | Igual | Retira las versiones deprecadas cuya fecha de retiro pasó (ADR-0019) | — |
| Ciclo de vida de credenciales | Igual | Avisa antes del vencimiento de los certificados y los marca `expired`; cierra las ventanas de rotación vencidas (la credencial anterior pasa a `expired`) | — |
| Anclaje de la bitácora | `RID_AUDIT_ANCHOR_INTERVAL_SECONDS` (3600 s) | Sella con la TSA el último evento de cada día cerrado (zona del país) | Si la TSA no responde, reintenta en la siguiente ronda. Bloqueo consultivo: un solo nodo ancla |
| Sellado de transparencia | `RID_TRANSPARENCY_SEAL_INTERVAL_SECONDS` (10 s) | Agrupa registros en lotes Merkle (hasta `RID_TRANSPARENCY_BATCH_MAX`), firma y sella con la TSA | El lote queda pendiente y se reintenta. Un solo nodo sella |
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
| Registro de transparencia | `GET /api/v1/transparency/verify` (`audit.read`); `?fromSeq=N` para revisar solo lo nuevo | Sin registros alterados, borrados antes de tiempo ni insertados |
| Búfer de Fluent Bit | `dc exec api wget -qO- http://fluent-bit-transparency:2020/api/v1/metrics` | Sin reintentos acumulados |
| Disco | `docker system df -v` | Volúmenes `rid_*` con margen |

Desde M5-06 las alertas de `ARCHITECTURE.md §9` llegan por correo al operador (Alertmanager), y el tablero `RID · Operador` de Grafana resume el estado. Esta lista queda para la revisión manual y para cuando falte el perfil `observability`. La sincronización también se ve en `/operator/sync` (M5-07).

| Alerta | Primera acción |
| :-- | :-- |
| `RidGateway5xxRate` | `dc logs fluent-bit-errors` (errores del gateway, enmascarados); el uso del proveedor afectado (`/my-apis/usage`) |
| `RidGatewayLatencyHigh` | El panel de latencia: si sube la petición completa pero no la del gateway, es el proveedor |
| `RidTargetDown` | `dc ps` y los logs del servicio |
| `RidOpaBundleBehind`, `RidOpaBundleFetchFailing` | `dc logs opa`; que OPA alcance `OPA_PORTAL_URL` con su token |
| `RidReconcileFailing` | `/operator/sync`, filtro "con problemas": el último error y reintentar |
| `RidNodeOffline` | `/operator/nodes`; la entidad dueña del nodo recibe su propio aviso |
| `RidCertificateExpiring` | La renovación automática falló: logs del API y `dc ps step-ca` |
| `RidQueueBacklog` | Logs del API; SQL 2 (§4.2) |

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
| Errores del gateway | `dc logs fluent-bit-errors` | El error log de nginx, con la línea de la petición, la URI del upstream y los números enmascarados (M5-01) |
| Keycloak | `dc logs keycloak` | Arranque e importación de realms |

Los logs no contienen cuerpos, rutas reales ni query strings, y no deben contenerlos. Si se ve un número de documento en un log, es un incidente de privacidad (regla 2 de `CLAUDE.md`).

## 5. Tareas puntuales

### 5.1 Reiniciar un componente

| Componente | Impacto mientras está caído | Al volver |
| :-- | :-- | :-- |
| `api` | No hay portal; el gateway sigue con la última configuración; los registros de transparencia esperan en el búfer de Fluent Bit | Migraciones, reconciliación completa, vacía el outbox |
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

### 5.2.1 Tráfico sintético para demos

`pnpm traffic:simulate [--from AAAA-MM-DD] [--days 30] [--scale 1] [--seed 42]` genera un mes de llamadas simuladas de las suscripciones activas de producción, para mostrar los indicadores, el uso y el mapa de intercambios sin tráfico real. Las llamadas tienen patrón de días hábiles y horario de oficina, negaciones con su razón y errores del proveedor.

- **Dónde quedan.** Escribe documentos con la forma del log de acceso en `rid-access-synthetic-AAAA.MM`, con `gateway_node: synthetic`. Nunca hacen llamadas reales ni llevan datos personales.
- **Borrarlo.** `--clear` borra todo; `--tag` lo separa (las pruebas usan uno propio).
- **Restricción.** Solo desarrollo y demos: en producción exige `RID_ALLOW_SYNTHETIC_TRAFFIC=true`. En el piloto se corre dentro del contenedor del API.

### 5.3 Cambios en un realm de Keycloak existente

La importación no toca realms que ya existen. Los cambios se aplican con `kcadm.sh`:

```bash
dc exec keycloak sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080/auth --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"'
# ejemplo (M2-01): autorregistro con verificación de correo
dc exec keycloak /opt/keycloak/bin/kcadm.sh update realms/rid-portal \
  -s registrationAllowed=true -s verifyEmail=true
```

En desarrollo el servidor es `http://localhost:8080` (sin `/auth`).

**Política de rotación de secretos (M3-04).** Se aplica desde el JSON del realm, sin borrar datos, con un script idempotente:

```bash
set -a; . ./.env; set +a
node scripts/keycloak-client-policies.mjs     # KEYCLOAK_URL y el administrador de master
```

En el piloto, `KEYCLOAK_URL` es la URL pública (`$RID_PUBLIC_URL/auth`). Comprobación: en la consola de Keycloak, realm `rid-gateway` → Client policies, aparece `rid-secret-rotation` activa.

**Segundo factor (M3-08, ADR-0021).** El flujo de login `rid-browser` y el mapa de niveles se aplican también desde el JSON, con un script idempotente:

```bash
set -a; . ./.env; set +a
node scripts/keycloak-portal-mfa.mjs              # flujo, mapa acr y política OTP
node scripts/keycloak-portal-mfa.mjs --demo-otp   # además, los códigos de los usuarios de demo
```

- `--demo-otp` es solo para desarrollo y el piloto. Reimporta desde el JSON, con el mismo id, cada usuario semilla con rol crítico que aún no tenga código: vuelve a poner la contraseña de `RID_DEMO_USER_PASSWORD` y el código de `RID_DEMO_TOTP_SECRET`.
- Comprobación: en la consola de Keycloak, realm `rid-portal` → Authentication, `rid-browser` está ligado al navegador. `pnpm demo:otp` imprime el código vigente de los usuarios de demo y la clave para una app autenticadora.
- **Aviso de credencial.** Keycloak le escribe al dueño de la cuenta cuando se pone o se quita una contraseña o un segundo factor, y guarda esos eventos 90 días (realm `rid-portal` → Events). Si alguien dice que no enroló el segundo factor que recibió en el aviso, trátalo como un incidente: deshabilita la cuenta en Keycloak, borra la credencial OTP y restablece la contraseña antes de volver a habilitarla.
- **Segundo factor perdido.** El administrador de Keycloak borra la credencial OTP de la persona (Users → la persona → Credentials). La próxima vez que el portal pida el código, Keycloak le pide enrolar una app nueva. Comprueba antes la identidad de quien lo pide, por un canal distinto del correo de la cuenta.

### 5.4 Huella de la raíz de la CA

```bash
dc exec step-ca step certificate fingerprint certs/root_ca.crt
```

Es el valor de `RID_STEP_CA_ROOT_FINGERPRINT` para un API que no monta el volumen de la CA.

### 5.5 Credenciales de las aplicaciones

La rotación y la revocación de los secretos y certificados de las aplicaciones las hacen sus desarrolladores desde la ficha de la aplicación (M3-04); el operador no interviene.

- Durante una rotación, el secreto o certificado anterior sigue funcionando `lifecycle.credentialRotationDays`.
- Revocar un certificado lo saca del gateway con la siguiente descarga del bundle (10–20 s).
- Revocar un secreto lo saca de Keycloak cuando corre el reconciliador (`keycloak.sync`, segundos).
- Si una revocación no surte efecto, revisar SQL 1 (§4.2) con `system = 'keycloak'` u `'opa'`.

### 5.6 Rotación de secretos de la plataforma

| Secreto | Cómo rotarlo hoy |
| :-- | :-- |
| `APISIX_ADMIN_KEY`, `OPA_BUNDLE_TOKEN`, `RID_TRANSPARENCY_INGEST_TOKEN` | Cambiar en `.env` y recrear a la vez los servicios que lo usan (`apisix` + `api`; `opa` + `api`; `fluent-bit-transparency` + `api`) |
| `AUTH_SECRET` | Cambiar y recrear `web`: todas las sesiones se cierran |
| Secretos de clientes de Keycloak (`RID_PORTAL_WEB_CLIENT_SECRET`, `RID_GATEWAY_PROVISIONER_SECRET`, `RID_CARPETA_CLIENT_SECRET`) | Cambiar el secreto del cliente en Keycloak (consola o `kcadm`) **y** en `.env`, y recrear `web`, `api` o `carpeta` |
| Contraseñas de PostgreSQL | `ALTER ROLE ... PASSWORD` **y** `.env` (con sus URLs), y recrear los servicios |
| `RID_TRANSPARENCY_SIGNING_JWK` | Clave nueva con otro `kid`; la pública anterior va a `RID_TRANSPARENCY_RETIRED_JWKS`. Procedimiento completo pendiente para producción |
| Certificados del gateway (servidor y clientes hacia proveedores) | Los renueva solo el reconciliador de APISIX; para forzarlo, reiniciar el API tras borrar la fila de `gateway_certificate` correspondiente |
| `RID_SUBJECT_REF_KEY`, `RID_END_USER_HASH_SALT` | **No se rotan**: rompen el vínculo con los registros anteriores (`DEPLOYMENT.md §4.1`) |
| CA intermedia | Runbook de M6-07 |

## 6. Respaldos

Hasta M6-06 (pgBackRest con restauración probada) el respaldo es manual. Qué guardar:

| Qué | Por qué | Cómo |
| :-- | :-- | :-- |
| Base `rid` | Única fuente de verdad del portal, bitácora y registro de transparencia | `dc exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB" > rid-$(date +%F).dump` |
| Base `keycloak` | Usuarios, realms, clientes de aplicaciones | `dc exec -T postgres pg_dump -U "$POSTGRES_USER" -Fc keycloak > keycloak-$(date +%F).dump` |
| Volumen `step-ca-data` | Claves de la CA: sin él, todos los certificados quedan huérfanos | `docker run --rm -v rid_step-ca-data:/v:ro -v "$PWD":/b alpine tar czf /b/step-ca-data.tgz -C /v .` |
| Volumen `tsa-data` | Cadena y clave de la TSA de desarrollo (los sellos ya emitidos se verifican con la cadena) | Igual, con `rid_tsa-data` |
| Volumen `api-documents` | Documentos subidos (designaciones, acuerdos) | Igual, con `rid_api-documents` |
| `.env` | Claves sin las que los datos no se pueden verificar ni seudonimizar igual | Copia cifrada fuera de la máquina |

No hace falta respaldar `etcd-data` (se reconstruye desde PostgreSQL), OPA (sin estado) ni `opensearch-data` (analítica, se puede perder). `transparency-buffer` solo tiene lo que aún no llegó al API.

Haz el respaldo **antes de cada actualización con migraciones**, y guarda los archivos con permisos `600`.

## 7. Problemas frecuentes

| Síntoma | Causa probable | Qué hacer |
| :-- | :-- | :-- |
| El gateway responde `403` a todo, incluso con suscripción | OPA sin bundle: el API no puede construirlo (falta, es corta o es el valor de ejemplo `RID_SUBJECT_REF_KEY` o `RID_END_USER_HASH_SALT`) o OPA no alcanza `OPA_PORTAL_URL` | `dc logs opa`, `dc logs api`; revisar esas variables y `OPA_BUNDLE_TOKEN` |
| Suscripción "Aprobada (activándose)" que no pasa a "Activa" | OPA no descargó ni reportó la revisión nueva | `health?bundles` de OPA; SQL 1 con `system = 'opa'` |
| API publicada que no aparece en el gateway (`404`) | Error del reconciliador de APISIX | SQL 1 con `system = 'apisix'`; `dc logs api`; revisar `APISIX_ADMIN_URL` y `APISIX_ADMIN_KEY` |
| La aplicación no pasa a "Lista" | Error del reconciliador de Keycloak | SQL 1 con `system = 'keycloak'`; revisar `KEYCLOAK_URL` y `RID_GATEWAY_PROVISIONER_SECRET` (debe coincidir con el del realm) |
| `api` termina al arrancar con un mensaje de configuración | `RID_COUNTRY` sin valor o YAML del país inválido | Corregir el YAML y reconstruir la imagen |
| `api` no arranca: error de migración | Migración fallida o base inaccesible como dueño | `dc logs api`; `dc exec api pnpm exec prisma migrate status` |
| No se emiten certificados (503) | step-ca caído, contraseña del provisioner distinta, o raíz no configurada con `NODE_ENV=production` | `dc logs api` (mensajes `step-ca: ...`); `RID_STEP_CA_PROVISIONER_PASSWORD` = `STEP_CA_PASSWORD`; `RID_STEP_CA_ROOT_FILE` |
| `sync_state` en error para `apisix:ssl:...` | step-ca no responde, falta el provisioner `rid-gateway-tls` (step-ca sin recrear) o cambió `RID_SECRETS_KEY` | `dc logs api`; `dc up -d step-ca`; §5.6 |
| Upstream `direct` que responde 502 | El gateway ahora verifica el certificado del proveedor (vencido, autofirmado o de otro nombre), o el proveedor con mTLS no acepta `CN=rid-gateway.<slug>` | Pedir al proveedor un certificado público válido para su nombre, o que confíe en la CA de la red y en ese nombre |
| Una aplicación recibe 429 `rate_limited` antes de su límite | Con varios nodos del gateway, el límite se reparte entre ellos (`RID_GATEWAY_NODES`) y el balanceo no es parejo (ADR-0020) | Revisar que `RID_GATEWAY_NODES` sea el número real de nodos; balancear por hash del origen |
| El gateway responde 500 a llamadas permitidas | `limit-count` sin un límite entero positivo (bundle viejo de OPA, sin `X-RID-Rate-Limit`) | `health?bundles` de OPA; que el API sirva el bundle actual |
| Al rotar un secreto, el anterior deja de funcionar enseguida | Falta la política de rotación en el realm `rid-gateway` existente | §5.3 |
| El ciudadano no ve sus consultas | Registros detenidos en Fluent Bit (token o host del colector) o la operación no declara titular | `dc logs fluent-bit-transparency`; `RID_TRANSPARENCY_INGEST_TOKEN` y `RID_TRANSPARENCY_COLLECTOR_HOST` |
| Consultas que siguen "En sellado" | TSA no responde o falta `RID_TRANSPARENCY_SIGNING_JWK` | `dc logs api`; `dc ps tsa` |
| Inicio de sesión en bucle o error de emisor | `KC_HOSTNAME`, `KEYCLOAK_URL` o `AUTH_URL` no coinciden con la URL pública | Revisar `RID_PUBLIC_URL` y las URLs derivadas (`DEPLOYMENT.md §4.2`) |
| Un cambio en un realm JSON no se ve | La importación ignora realms existentes | §5.3 |
| OpenSearch no arranca | `vm.max_map_count` bajo o poca memoria | `DEPLOYMENT.md §2` |
