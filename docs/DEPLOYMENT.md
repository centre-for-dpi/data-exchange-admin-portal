# Despliegue — Portal RID

Versión 0.2 · noviembre 2026 · estado del código con M3-01 a M3-04 (M3 en curso)

Este documento describe **cómo se despliega cada componente** del portal y del gateway: imagen, configuración, puertos, volúmenes, secretos y dependencias. Cómo dejarlo operativo y cómo operarlo día a día está en [`OPERATIONS.md`](OPERATIONS.md). La arquitectura de referencia está en [`ARCHITECTURE.md`](ARCHITECTURE.md).

> **Alcance (ADR-0011).** Aquí solo se despliega el portal + el gateway. El kit de APIs instantáneas que se instala en las entidades es otro producto, con su propio repositorio. `mock-salud`, `mock-socioeconomico` y la carpeta ciudadana (`carpeta`) son utilería de pruebas y demostración.

## 1. Topologías

| Topología | Archivos | Estado | Uso |
| :-- | :-- | :-- | :-- |
| **Desarrollo local** | `infra/compose/docker-compose.yml`; web y API en el host con `pnpm dev` | Disponible | Programar y probar |
| **Piloto en una máquina** | `docker-compose.yml` + `docker-compose.deploy.yml`, detrás de un proxy inverso existente o del incluido (`docker-compose.edge.yml`) | Disponible; **instalador interactivo `install.sh`** ([`INSTALL.md`](INSTALL.md)) | Demos, pilotos y bootcamp |
| **Producción** | Helm charts (`infra/helm/`) con la topología de `ARCHITECTURE.md §11` | **No existe todavía** (M6-05) | Operador nacional |

El piloto no es un despliegue de producción. Sus límites conocidos están en la §8.

## 2. Requisitos

| Requisito | Versión | Para qué |
| :-- | :-- | :-- |
| Docker Engine con Compose v2 | Compose ≥ 2.26 | `!reset` en los puertos y montaje con `subpath` del volumen de step-ca (piloto) |
| Node.js | ≥ 24 (`engines` en `package.json`) | Desarrollo, `scripts/make-deploy-env.mjs` |
| pnpm | 11.15.0 (`packageManager`) | Desarrollo |
| `vm.max_map_count` del host | ≥ 262144 | OpenSearch (perfil `observability`) |
| Memoria | OpenSearch arranca con `-Xms512m -Xmx512m`; Keycloak, APISIX y los builds de Next.js suman varios GB | — |

En Linux, para OpenSearch:

```bash
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-rid-opensearch.conf
sudo sysctl --system
```

## 3. Componentes

Todos los servicios están en `infra/compose/docker-compose.yml` (proyecto Compose `rid`). En desarrollo, cada puerto publicado se enlaza solo a `127.0.0.1` y se puede mover con su variable `*_PORT` en `.env`. En el piloto no se publica ningún puerto (§5).

Los componentes se agrupan en dos planos (`ARCHITECTURE.md §1`):

- **Plano de gobierno:** PostgreSQL, Keycloak, step-ca, la TSA, el API y la web. Deciden quién puede qué y lo traducen a configuración.
- **Plano de datos:** etcd, APISIX, OPA y los Fluent Bit. Atienden y registran cada llamada entre entidades. Siguen funcionando aunque caiga el plano de gobierno.

Cada subsección empieza por la **función** del componente en el despliegue y sigue con su configuración.

### 3.1 Resumen

| Servicio | Imagen | Puerto interno | Puerto dev (host) | Volumen | Perfil | Health check |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `postgres` | `postgres:18.6-alpine` | 5432 | `POSTGRES_PORT` 5432 | `pg-data` | base | `pg_isready` |
| `keycloak` | `quay.io/keycloak/keycloak:26.8.0` | 8080 (HTTP), 9000 (gestión) | `KEYCLOAK_PORT` 8080 | — (usa `postgres`) | base | `GET /health/ready` en 9000 |
| `etcd` | `quay.io/coreos/etcd:v3.6.16` | 2379 | no se publica | `etcd-data` | base | `etcdctl endpoint health` |
| `apisix` | `apache/apisix:3.19.0-debian` | 9080 (HTTP), 9443 (HTTPS), 9180 (admin), 7085 (estado), 9091 (métricas) | 9080, 9443, 9180 | — (estado en etcd) | base | `GET /status/ready` en 7085 |
| `opa` | `openpolicyagent/opa:1.21.4-static` | 8181 | `OPA_PORT` 8181 | — | base | `GET /health` |
| `step-ca` | `smallstep/step-ca:0.30.2` | 9000 | `STEP_CA_PORT` 9000 | `step-ca-data` | base | `step ca health` |
| `fluent-bit-transparency` | `fluent/fluent-bit:5.1.5-debug` | 5170 (TCP), 2020 (salud) | no se publica | `transparency-buffer` | base | `GET /api/v1/health` en 2020 |
| `tsa-init` | `smallstep/step-ca:0.30.2` | — (tarea única) | — | `tsa-data` | base | termina con código 0 |
| `tsa` | `ghcr.io/sigstore/timestamp-server:v2.1.4` | 3004 | `RID_TSA_PORT` 3004 | `tsa-data` (lectura) | base | ninguno (imagen distroless) |
| `mailpit` | `axllent/mailpit:v1.32.0` | 8025 (UI), 1025 (SMTP) | 8025, 1025 | — | base | `mailpit readyz` |
| `mock-salud`, `mock-socioeconomico` | `rid/mock-providers:dev` (build local) | 8000 | 8101, 8102 | — | base | `GET /health` |
| `wg-hub` | `rid/wg-hub:dev` (build local, `infra/wg-hub`) | 51820/udp (túnel), 8443 (enrutador SNI), 8090 (agente) | 51820/udp y 8095 (agente) en `127.0.0.1` | `wg-hub-data` | base | `GET /health` en 8090 |
| `contract-runner` | `rid/contract-runner:dev` (build local, `infra/contract-runner`) | 8096 | `CONTRACT_RUNNER_PORT` 8096 en `127.0.0.1` | — | base | `GET /health` |
| `mock-node` | `rid/mock-node:dev` (build local, `infra/mock-node`) | 8443 en su dirección del túnel | no se publica | anónimo | `nodes` | — |
| `opensearch` | `opensearchproject/opensearch:3.9.0` | 9200 | `OPENSEARCH_PORT` 9200 | `opensearch-data` | `observability` | `_cluster/health` amarillo |
| `fluent-bit` | `fluent/fluent-bit:5.1.5-debug` | 9880 (HTTP), 2020 | no se publica | — | `observability` | `GET /api/v1/health` en 2020 |
| `api` | `rid/portal-api:deploy` (`apps/api/Dockerfile`) | 4000 | — (en dev corre en el host) | `api-documents`, `step-ca-data` (solo `certs/`, lectura) | solo piloto | `GET /api/v1/health` |
| `web` | `rid/portal-web:deploy` (`apps/web/Dockerfile`) | 3000 | — (en dev corre en el host) | — | solo piloto | `GET /api/auth/providers` |
| `carpeta` | `rid/mock-citizen-app:deploy` (`infra/mock-citizen-app/Dockerfile`) | 3100 | — (en dev corre en el host) | `carpeta-data` | solo piloto | — |

Prometheus, Alertmanager y Grafana **no** están en el Compose todavía (M5-06).

### 3.2 PostgreSQL

**Función en el despliegue.** Es la única fuente de verdad del plano de gobierno. Guarda:

- el estado de dominio: entidades, personas y roles, APIs y versiones, aplicaciones, suscripciones y documentos;
- la bitácora de auditoría encadenada por hash, con sus anclajes;
- el outbox y las colas de trabajos en segundo plano (pg-boss; no hay Redis);
- el registro de transparencia y sus lotes sellados;
- en una base aparte, los datos de Keycloak.

Lo que hay en APISIX, OPA y en los clientes de Keycloak se calcula desde aquí, así que se puede reconstruir. Si PostgreSQL cae, el portal se detiene, pero el gateway sigue atendiendo con la última configuración.

- Una sola instancia guarda la base del portal (`POSTGRES_DB`, por defecto `rid`), la de pruebas (`rid_test`) y la de Keycloak (`keycloak`).
- **Scripts de inicialización** (`infra/postgres/init`, solo con el volumen vacío):
  - `01-keycloak.sh`: rol `KEYCLOAK_DB_USER` y base `keycloak`.
  - `02-app-role.sh`: rol `rid_app` (sin DDL) con la contraseña `RID_APP_DB_PASSWORD`, base `rid_test` y privilegios por defecto para que `rid_app` use todo lo que cree el dueño.
- **Dos roles del portal:** el dueño del esquema (`POSTGRES_USER`, `rid`) solo corre migraciones (`DATABASE_MIGRATION_URL`); el API corre como `rid_app` (`DATABASE_URL`). Las tablas de auditoría y de transparencia son de solo inserción incluso para el dueño (triggers, `ARCHITECTURE.md §7` y §13).
- **Migraciones:** Prisma (`apps/api/prisma/migrations`), con `DATABASE_MIGRATION_URL` (`apps/api/prisma.config.ts`). El esquema de la cola pg-boss también es una migración: el API arranca pg-boss sin permisos de DDL (`migrate: false`).
- Las contraseñas de `.env` solo se usan **la primera vez**. Cambiarlas en `.env` con el volumen ya creado no cambia los roles: hay que hacer `ALTER ROLE ... PASSWORD` y actualizar `.env` a la vez.

### 3.3 Keycloak

**Función en el despliegue.** Es el proveedor de identidad: **autentica, no autoriza**. Los roles viven en PostgreSQL (ADR-0004). Tiene tres realms, uno por tipo de usuario:

- **`rid-portal`**, para las personas que usan el portal: inicio de sesión OIDC de la web, autorregistro, verificación de correo y recuperación de contraseña.
- **`rid-gateway`**, para las aplicaciones consumidoras. Emite los tokens `client_credentials` (5 min, `aud = rid-gateway`) que APISIX valida en cada llamada. Sus clientes `rid-app-<uuid>` los crea y mantiene el reconciliador del API, nunca una persona.
- **`rid-citizens`**, que simula la identidad digital del país para la carpeta ciudadana. En producción se reemplaza por el emisor del país (`RID_CITIZEN_ISSUER`).

Si Keycloak cae, nadie puede iniciar sesión y las aplicaciones no obtienen tokens nuevos.

- Corre con `start-dev --import-realm` (también en el piloto: el override no cambia el comando).
- Importa al arrancar `infra/keycloak/*-realm.json` (`rid-portal`, `rid-gateway`, `rid-citizens`). Los secretos son marcadores `${VARIABLE}` resueltos con el entorno del contenedor: `RID_PORTAL_WEB_CLIENT_SECRET`, `RID_GATEWAY_PROVISIONER_SECRET`, `RID_CARPETA_CLIENT_SECRET`, `RID_WEB_URL`, `RID_CARPETA_URL`, `RID_DEMO_USER_PASSWORD`, `RID_DEMO_TOTP_SECRET`.
- **La importación no actualiza un realm que ya existe** (`IGNORE_EXISTING`). Un cambio en los JSON, en esos secretos o en las URLs no llega a un Keycloak ya inicializado: se aplica con `kcadm.sh` (ver `OPERATIONS.md §5.3`) o borrando la base de Keycloak.
- Emisor de los tokens: en desarrollo `KC_HOSTNAME=http://localhost:${KEYCLOAK_PORT}`; en el piloto `${RID_PUBLIC_URL}/auth` con `KC_HTTP_RELATIVE_PATH=/auth` y `KC_PROXY_HEADERS=xforwarded`. `KC_HOSTNAME_BACKCHANNEL_DYNAMIC` deja que los contenedores (APISIX) lo alcancen por nombre de servicio.
- Administrador inicial: `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` (`KC_BOOTSTRAP_ADMIN_*`).
- **Política de cliente `rid-secret-rotation`** en `rid-gateway` (M3-04): en los clientes con el atributo `rid.managed = true`, los que crea el portal, regenerar el secreto deja el anterior como secreto rotado durante la ventana de rotación (a lo sumo 30 días). Llega con el realm en una instalación nueva; en un Keycloak que ya importó el realm se aplica con `node scripts/keycloak-client-policies.mjs` (`OPERATIONS.md §5.3`). Sin ella, rotar un secreto deja de aceptar el anterior en cuanto el reconciliador aplica el nuevo.
- **Segundo factor (M3-08, ADR-0021)** en `rid-portal`. El flujo `rid-browser` pide la contraseña y, cuando la web pide `acr_values=mfa`, un código TOTP. El API exige ese nivel a los roles de plataforma y a `data_steward`.
  - Llega con el realm en una instalación nueva. En un Keycloak que ya importó el realm se aplica con `node scripts/keycloak-portal-mfa.mjs` (`OPERATIONS.md §5.3`).
  - Sin el flujo, Keycloak no puede dar `acr=mfa`, y esos roles reciben 403 `mfa_required` en todo el portal.
  - Los usuarios semilla con rol crítico traen el código de `RID_DEMO_TOTP_SECRET`. En producción no hay usuarios semilla: cada persona enrola su app la primera vez.
- **Certificado de cliente de las aplicaciones (M3-10, ADR-0022).** Arranca con el proveedor x509 `nginx` y `trust-proxy-verification` (`--spi-x509cert-lookup--…`, en el compose): lee de `SSL_CLIENT_CERT` el certificado que APISIX ya verificó en la ruta de token del gateway. Por eso ninguna otra vía hacia Keycloak debe dejar pasar esa cabecera ni `ssl-client-verify` (§5.2).
- Detalle de los tres realms y los usuarios semilla: `infra/keycloak/README.md`.

### 3.4 etcd + APISIX

**Función de etcd en el despliegue.** Guarda la configuración del gateway: rutas, upstreams, plugins y objetos SSL. El reconciliador del API la escribe por el Admin API de APISIX, y cada nodo de APISIX la lee y aplica los cambios en cuanto ocurren, sin reiniciar. No es una fuente de verdad: si se pierde, el API la reconstruye desde PostgreSQL.

**Función de APISIX en el despliegue.** Es el **gateway**, el corazón del plano de datos: toda llamada entre entidades pasa por él. En cada petición:

1. valida el token de `rid-gateway`;
2. borra las cabeceras `X-RID-*` que solo el gateway puede poner;
3. si la operación lo declara, lee el titular del cuerpo (plugin `rid-data-subject`);
4. pregunta a OPA si la llamada se permite;
5. reenvía la petición al proveedor con las cabeceras de trazabilidad que devolvió OPA;
6. envía los metadatos de la llamada a los dos Fluent Bit: analítica y transparencia.

También termina el TLS del gateway en 9443 con su certificado de servidor y, cuando `features.mtls.required` está activo, exige ahí el certificado de cliente de la aplicación (M3-02). Hacia los proveedores con mTLS presenta el certificado de cliente del gateway de esa entidad (M3-03). No guarda cuerpos de petición ni de respuesta. En el piloto se publica en `/gw`.

- etcd guarda la configuración de APISIX (prefijo `/apisix`). Un solo nodo, HTTP sin TLS, no se publica.
- APISIX en modo `traditional` con `config_provider: etcd` (`infra/apisix/config.yaml`, montado de solo lectura). La clave del Admin API llega por `APISIX_ADMIN_KEY`.
- El Admin API (9180) acepta solo direcciones privadas (`127.0.0.0/24`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) y exige la clave. Nunca se expone al público.
- Plugins propios en `infra/apisix/plugins` (montados en `/usr/local/apisix/rid`): `rid-data-subject` (ADR-0017) `rid-client-cert` (M3-02: pasa a OPA la huella RFC 8705 del certificado de cliente verificado), `rid-rate-limited` (M3-05: el 429 del límite por suscripción en problem+json) y `rid-header-guard` (M3-07: borra toda cabecera `X-RID-*` del cliente salvo la finalidad y el funcionario). La lista de plugins de `config.yaml` es explícita: un plugin nuevo exige reiniciar APISIX.
- **Objetos SSL** (los crea el reconciliador, como las rutas):
  - `rid-ssl-gateway`: certificado de servidor del gateway en los nombres de `RID_GATEWAY_TLS_HOSTS`, emitido por step-ca y renovado por el portal. Con `features.mtls.required`, además `client.ca` con la CA de la red: sin certificado válido, el handshake falla.
  - `rid-ssl-gateway-client-<entityId>`: certificado de cliente que el gateway presenta a los upstreams con mTLS de esa entidad proveedora, `CN=rid-gateway.<slug>` (prefijo `RID_GATEWAY_CLIENT_NAME`). Uno por proveedor, para que una entidad no pueda llegar a la API mTLS de otra con la identidad del gateway. Cada proveedor debe aceptar solo su nombre.
- **Upstreams.** Los `direct` verifican el certificado del proveedor y apuntan a las direcciones que el reconciliador resolvió y encontró públicas, con el nombre como Host y SNI (sin DNS rebinding). Los nodos sobre TLS se verifican contra la CA de la red (M3-03).
- En desarrollo APISIX alcanza el host por `host.docker.internal` (solo para las pruebas de mTLS hacia upstreams); el override del piloto lo quita.
- **Privacidad:** el access log de nginx está desactivado y el error log en nivel `error` (`ARCHITECTURE.md §8`).
- **Nadie escribe rutas a mano.** Rutas, upstreams y plugins los crea el reconciliador del API (ADR-0007). Cada ruta lleva `prometheus`, `http-logger` (analítica → `fluent-bit:9880`) y, si alguna operación declara titular, `tcp-logger` (transparencia → `fluent-bit-transparency:5170`).
- **Estado reconstruible:** si se pierde etcd, el reconciliador completo (cada 5 minutos o al reiniciar el API) recrea todo desde PostgreSQL.

### 3.5 OPA

**Función en el despliegue.** Decide cada llamada: la permite o la niega con una razón estable (`no_subscription`, `purpose_not_allowed`…). Decide solo con los datos del **bundle** que publica el portal:

- rutas y operaciones;
- clientes y su estado, con las huellas de sus certificados vigentes (M3-02);
- suscripciones vigentes con sus operaciones, finalidades y fechas;
- la sal del funcionario, la clave del seudónimo y si la red exige mTLS (`mtlsRequired`).

Además calcula el hash del funcionario y el seudónimo del titular, y devuelve las cabeceras de trazabilidad que APISIX envía al proveedor. Nunca consulta en línea la base del portal, y por eso el tráfico sobrevive a una caída del portal. Su reporte de estado le indica al portal cuándo una suscripción aprobada ya rige en el gateway, y entonces la suscripción pasa a `active`.

- Config en `infra/opa/config.yaml`: descarga el bundle `rid` de `${OPA_PORTAL_URL}/bundle.tar.gz` con `Bearer ${OPA_BUNDLE_TOKEN}` cada 10–20 s, y reporta la revisión activa a `${OPA_PORTAL_URL}/status`.
- Sin estado propio. Sin bundle no tiene política y el gateway niega todo (falla cerrado).
- Los *decision logs* están desactivados a propósito (la entrada lleva cabeceras con datos en claro).
- `OPA_PORTAL_URL`: en desarrollo `http://host.docker.internal:4000/api/v1/opa` (el API corre en el host); en el piloto `http://api:4000/api/v1/opa`.

### 3.6 step-ca

**Función en el despliegue.** Es la autoridad certificadora de la red. Firma:

- los certificados de cliente de las aplicaciones consumidoras, a partir de los CSR que las entidades suben al portal (M3-01). Sirven para el mTLS con el gateway y para los tokens ligados al certificado (RFC 8705) cuando `features.mtls.required` está activo;
- el certificado de servidor TLS del gateway (M3-02);
- los certificados de cliente del gateway hacia los proveedores con mTLS, uno por entidad (M3-03).

También firma los de los nodos del kit al enrolarse y al renovarse (M4-02). Solo el API habla con ella: las entidades y los nodos nunca la llaman directamente.

- En el primer arranque la imagen inicializa la CA con `DOCKER_STEPCA_INIT_*`: nombre `RID Dev CA`, DNS `localhost,step-ca`, provisioner JWK `rid-portal`, contraseña `STEP_CA_PASSWORD`. **El piloto usa esta misma CA de desarrollo**; la raíz fuera de línea y la intermedia en HSM son de producción (M6).
- En cada arranque, `infra/step-ca/configure.sh` ajusta el provisioner `rid-portal` (plantilla `app.tpl`, solo autenticación de cliente, 90 días por defecto, 397 como máximo). También crea, si no existe, el provisioner `rid-gateway-tls` con la contraseña de la CA (plantilla `gateway.tpl`, solo autenticación de servidor, 90 días) y el provisioner `rid-nodes` de los nodos del kit (plantilla `node.tpl`, autenticación de servidor y de cliente, 90 días, M4-02). Luego inicia la CA. Es idempotente: una CA existente recibe un provisioner nuevo al reiniciar el contenedor.
- El portal genera las claves de los certificados del gateway y las guarda selladas con `RID_SECRETS_KEY` (tabla `gateway_certificate`). Los renueva en el último tercio de su vida, en la pasada completa del reconciliador de APISIX.
- El estado (raíz, intermedia, claves, `secrets/password`) vive en `step-ca-data`. **Perder ese volumen invalida todos los certificados emitidos.**
- El API firma los CSR con los provisioners (`RID_STEP_CA_URL`, `RID_STEP_CA_PROVISIONER`, `RID_STEP_CA_GATEWAY_PROVISIONER`, `RID_STEP_CA_PROVISIONER_PASSWORD` = `STEP_CA_PASSWORD` para los dos) y verifica el TLS de la CA con `RID_STEP_CA_ROOT_FILE` o `RID_STEP_CA_ROOT_FINGERPRINT`. Con `NODE_ENV=production` (imágenes del piloto) una de las dos es **obligatoria**; sin ninguna, solo en desarrollo, confía en la raíz que sirve la CA.

### 3.7 Registro de transparencia: Fluent Bit + TSA

**Función de `fluent-bit-transparency` en el despliegue.** Lleva del gateway al portal el registro de cada llamada **autorizada** que tocó datos de una persona: quién consultó, para qué, con qué suscripción y el seudónimo del titular, nunca la ruta ni el número de documento. Deja solo los campos permitidos y descarta las llamadas sin seudónimo o que no llegaron al proveedor. Con su búfer en disco no se pierden registros si el API está caído. Sin este servicio, el ciudadano no ve quién consultó sus datos (ADR-0015).

**Función de `tsa-init` en el despliegue.** Es una tarea que corre una sola vez: genera la cadena de certificados de la TSA de desarrollo y termina.

**Función de `tsa` en el despliegue.** Es la autoridad de sellado de tiempo (RFC 3161), independiente de la clave del operador. Sella dos cosas: los puntos de control del registro de transparencia y el anclaje diario de la bitácora de auditoría. Con el sello cualquiera puede probar que esos datos existían en ese momento y que no se reescribieron después (ADR-0016). Su cadena pública permite que terceros (la carpeta, `rid-verify-receipt`) verifiquen los sellos sin confiar en el portal.

- `fluent-bit-transparency` (`infra/fluent-bit/transparency.yaml`): entrada TCP 5170 en JSON, filtro Lua `transparency.lua`, salida HTTP a `${RID_TRANSPARENCY_COLLECTOR_HOST}:${RID_TRANSPARENCY_COLLECTOR_PORT}/api/v1/internal/subject-access` con `Bearer ${RID_TRANSPARENCY_INGEST_TOKEN}`. Búfer en disco (`transparency-buffer`, hasta 1 GB) y reintentos sin límite: si el API cae, los registros esperan.
- `tsa-init` crea una sola vez la cadena de la TSA de desarrollo en `tsa-data` (`infra/tsa/init.sh`). `tsa` es sigstore timestamp-server con esa clave. En producción se usa la TSA acreditada del país (`RID_TSA_URL`).
- La cadena de la TSA es pública: `GET /api/v1/timestamp/certchain`.

### 3.8 Analítica: Fluent Bit + OpenSearch (perfil `observability`)

**Función de `fluent-bit` en el despliegue.** Es la segunda barrera de privacidad del log de acceso. Recibe del `http-logger` de APISIX los metadatos de **todas** las llamadas, también las negadas con su razón. Descarta cualquier campo fuera de la lista permitida y escribe el resto en OpenSearch.

**Función de `opensearch` en el despliegue.** Guarda los logs de acceso para la analítica de uso: llamadas por consumidor, por finalidad y por operación, latencias y razones de negación. Hoy solo acumula datos, porque las pantallas que los consultan llegan con M5. Se puede prescindir de él: perderlo no afecta al tráfico, a la auditoría ni al registro de transparencia.

- `fluent-bit` (`infra/fluent-bit/fluent-bit.yaml`): entrada HTTP 9880, filtro de lista permitida `allowlist.lua`, salida a OpenSearch, índice `rid-access-YYYY.MM`.
- OpenSearch en modo un solo nodo **sin plugin de seguridad** (`DISABLE_SECURITY_PLUGIN=true`), solo dentro de la red de Compose.
- Hoy el portal no consulta OpenSearch (las pantallas de uso son M5-02 a M5-04) ni hay política de retención del índice configurada.
- `pnpm infra:up:core` levanta todo sin este perfil. Las rutas siguen enviando a `fluent-bit:9880`; sin ese servicio, esos logs se pierden y el tráfico no se afecta.

### 3.9 Mailpit

**Función en el despliegue.** Hace de servidor de correo de pruebas: captura todo el correo saliente sin entregarlo a nadie y lo muestra en una bandeja web. Eso incluye las invitaciones, las notificaciones del portal, los anclajes enviados a los reguladores, los correos de verificación y recuperación de Keycloak y los avisos de la carpeta ciudadana. Ocupa el lugar del SMTP real del operador.

- Recibe todo el correo de desarrollo y del piloto (SMTP 1025): el del API (`RID_SMTP_URL`), el de Keycloak (verificación y recuperación) y el de la carpeta.
- En el piloto se sirve en `/mail` (`MP_WEBROOT`) detrás de usuario y contraseña (`MP_UI_AUTH=${MAILPIT_UI_AUTH}`): Keycloak envía allí los enlaces de recuperación de contraseña, así que una bandeja abierta permitiría tomar cualquier cuenta.
- En producción se reemplaza por el SMTP real del operador (`RID_SMTP_URL`, `RID_MAIL_FROM`).

### 3.10 API del portal (`apps/api`)

**Función en el despliegue.** Es el centro del plano de gobierno, y el único componente que escribe en APISIX, Keycloak (`rid-gateway`) y step-ca. Tiene dos caras:

- **REST (`/api/v1`).** Atiende a la web y a los sistemas. Aplica los flujos de publicación, solicitud y aprobación. Verifica rol y pertenencia a la entidad en cada endpoint y registra cada cambio en la bitácora.
- **Trabajos en segundo plano.** Traducen el estado de PostgreSQL a configuración: rutas, upstreams y objetos SSL de APISIX, clientes de Keycloak (con la rotación de secretos) y bundle de OPA. También firman certificados con step-ca, reciben y sellan el registro de transparencia (firma del operador más sello de la TSA), envían correos y webhooks, y vencen suscripciones, versiones, certificados y ventanas de rotación de credenciales.

Además sirve la API del titular que consume la carpeta ciudadana.

- Imagen: `apps/api/Dockerfile`, construida desde la raíz del repo (`COPY . .`). **La configuración del país (`config/country/*.yaml`) queda dentro de la imagen**: un cambio en el YAML exige reconstruir.
- Al arrancar: `pnpm db:deploy` (migraciones como dueño) → `pnpm db:seed` si `RID_ALLOW_SEED=true` → `node dist/main.js` en `API_PORT` (4000). Si la configuración del país es inválida o falta `RID_COUNTRY`, termina con código 1.
- Corre como usuario `node`. Documentos en `/var/lib/rid/documents` (`RID_DOCUMENTS_DIR`, volumen `api-documents`).
- **Trabajos en segundo plano en el mismo proceso** (`OPERATIONS.md §3`). `RID_WORKER=off` arranca el API sin ellos (pruebas, réplicas de solo lectura).
- Expone `/api/v1/*`. Rutas que **nunca** van al ingreso público: `/api/v1/internal/*` (colector de transparencia) y `/api/v1/opa/*` (bundle y estado de OPA).

### 3.11 Web del portal (`apps/web`)

**Función en el despliegue.** Es la interfaz de las personas. Por un lado, el portal de desarrolladores: catálogo, documentación interactiva, aplicaciones y solicitudes de acceso. Por otro, las consolas de cada rol: publicador, responsable de datos, administrador de entidad, operador, regulador y auditoría. Inicia sesión con Keycloak (`rid-portal`) y llama al API con el token del usuario, guardado en la cookie cifrada de Auth.js. No tiene base de datos propia, y la autorización la decide siempre el API.

- Imagen: `apps/web/Dockerfile`. Se compila con secretos de relleno; los reales llegan en tiempo de ejecución.
- Variables: `AUTH_URL`, `AUTH_SECRET`, `KEYCLOAK_URL`, `RID_PORTAL_WEB_CLIENT_ID`, `RID_PORTAL_WEB_CLIENT_SECRET`, `RID_API_URL` (interno, `http://api:4000`), `RID_WEB_URL`, `RID_GATEWAY_PUBLIC_URL`, opcional `RID_AUTH_REFRESH_BEFORE_SECONDS`. En el piloto, `AUTH_TRUST_HOST=true` (está detrás del proxy).
- Corre con `next start` en 3000.
- **Cabeceras de seguridad (M3-09).** La web pone ella misma la CSP con nonce, HSTS y el resto de las cabeceras (`ARCHITECTURE.md §12`). El proxy de delante no debe quitarlas ni reemplazarlas; tampoco debe agregar otra `Content-Security-Policy`, porque el navegador aplicaría las dos.
  - HSTS va siempre, con `includeSubDomains`: publica la web en un nombre cuyos subdominios también se sirvan por HTTPS.
  - Si Keycloak está en otro origen, `KEYCLOAK_URL` lo autoriza en `form-action`.

### 3.12 Carpeta ciudadana de referencia (`infra/mock-citizen-app`)

**Función en el despliegue.** En las demos hace el papel de la aplicación ciudadana del país. El ciudadano:

- entra con la identidad digital simulada (`rid-citizens`);
- ve quién consultó sus datos, para qué y con qué resultado;
- recibe avisos por correo cuando lo consultan (webhooks firmados del portal);
- verifica cada comprobante por su cuenta, sin confiar en el portal.

Muestra lo que debe implementar una carpeta real; no es un producto.

- Utilería de demostración (MT-07). Su URL pública (`RID_CARPETA_URL`) fija la ruta base: en el piloto, `/carpeta`.
- Variables principales: `RID_CARPETA_URL`, `RID_CITIZEN_ISSUER`, `RID_CARPETA_CLIENT_SECRET`, `CITIZEN_APP_WEBHOOK_SECRET` (obligatoria), `CITIZEN_APP_PORTAL_API_URL`, `CITIZEN_APP_JWKS_URL`, `CITIZEN_APP_TSA_ROOT_URL`, `CITIZEN_APP_SMTP_HOST/PORT`, `CITIZEN_APP_DATA_FILE`.
- Guarda correos de ciudadanos y vínculos de avisos en `carpeta-data` (`alerts.json`).

### 3.13 Proveedores de prueba (`infra/mock-providers`)

**Función en el despliegue.** `mock-salud` y `mock-socioeconomico` simulan los servicios de dos entidades proveedoras con datos sintéticos (ADR-0009). Ocupan el lugar de los nodos del kit hasta M4: el reconciliador apunta los upstreams a ellos según `RID_DEV_NODES` (`slug=host:puerto`; con `https://host:puerto`, el gateway les habla con mTLS como a un nodo enrolado). Registran en su log las cabeceras `X-RID-*` que reciben, y así la demo muestra qué le llega al proveedor. En producción no existen: los upstreams son nodos del kit, APIs existentes de las entidades o un Security Server de X-Road.

- Una sola imagen (`rid/mock-providers:dev`); `PROVIDER` elige el servicio y sus datos (`salud` o `socioeconomico`), con su OpenAPI en `infra/mock-providers/<proveedor>/openapi.yaml`.
- Escuchan en 8000 dentro de la red de Compose; en desarrollo se publican en 8101 y 8102.

### 3.14 Hub WireGuard (`infra/wg-hub`, M4-03, ADR-0023)

**Función en el despliegue.** Es el extremo central de los túneles de los nodos del kit, que corren en las redes de las entidades, detrás de su firewall. El gateway llama a un nodo a través del hub: APISIX abre TLS hacia `wg-hub:8443` con el nombre del nodo (`rid-node-<id>`) como SNI, y el nginx `stream` del hub pasa la conexión, sin abrirla, a la dirección del nodo dentro del túnel. El TLS es de punta a punta entre el gateway y el nodo. Sin el hub, las versiones servidas por nodos no responden.

- Al arrancar, el agente (`hub-agent.mjs`) levanta `wg0` en la primera dirección de `RID_WG_SUBNET` con `RID_WG_HUB_PRIVATE_KEY`. Usa WireGuard del kernel si el host lo tiene; si no, `wireguard-go`.
- El contenedor necesita `NET_ADMIN` y `/dev/net/tun`. Corre con `net.ipv4.ip_forward=0`: el hub no reenvía paquetes, y su firewall descarta todo lo nuevo que llega por `wg0`. Un nodo no alcanza otros nodos, el hub ni la plataforma.
- El agente (puerto 8090, `RID_WG_HUB_AGENT_TOKEN`, solo red interna) recibe del reconciliador del portal el estado completo (peers y rutas SNI) y lo aplica con `wg syncconf` y una recarga de nginx. Guarda el último estado en `wg-hub-data`, así un reinicio vuelve a servir a los nodos antes de la siguiente pasada.
- Los nodos llegan al hub por UDP 51820 desde internet. En el piloto, `docker-compose.deploy.yml` publica ese puerto (`WG_HUB_UDP_PORT`), y `RID_WG_HUB_ENDPOINT` es el nombre público con ese puerto. El firewall del host debe dejarlo pasar.
- La clave privada del hub está en `.env` (`make-deploy-env.mjs` la genera). Cambiarla obliga a reenrolar todos los nodos, porque la clave pública va en su configuración.
- `mock-node` (perfil `nodes`) es un nodo simulado para pruebas: espera un token en `/var/lib/mock-node/token`, se enrola, se une al hub y sirve `mock-salud` por mTLS. No es el kit (ADR-0011).

## 4. Variables de entorno

La referencia completa, comentada, es `.env.example`. Todos los servicios leen el mismo `.env` de la raíz (Compose con `--env-file .env`; en el piloto también `env_file` para `api`, `web` y `carpeta`).

### 4.1 Secretos que no se pueden cambiar a la ligera

| Variable | Qué pasa si cambia |
| :-- | :-- |
| `RID_SUBJECT_REF_KEY` (≥ 32 caracteres) | Cambia el seudónimo de cada titular: se pierde el vínculo entre un ciudadano y sus registros anteriores |
| `RID_END_USER_HASH_SALT` (≥ 16 caracteres) | Cambian todos los hashes de funcionario |
| `RID_TRANSPARENCY_SIGNING_JWK` | Los comprobantes anteriores solo verifican si la clave pública vieja pasa a `RID_TRANSPARENCY_RETIRED_JWKS` |
| `RID_SECRETS_KEY` (32 bytes base64) | No se pueden abrir los secretos de cliente sellados que el reconciliador de Keycloak aún no aplicó, ni las claves de los certificados del gateway (`gateway_certificate`): el reconciliador de APISIX falla hasta que se emitan certificados nuevos |
| `POSTGRES_PASSWORD`, `RID_APP_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD` | Solo se aplican al crear el volumen (§3.2) |
| `RID_PORTAL_WEB_CLIENT_SECRET`, `RID_GATEWAY_PROVISIONER_SECRET`, `RID_CARPETA_CLIENT_SECRET` | Solo se aplican al importar el realm (§3.3) |
| `STEP_CA_PASSWORD` | Cifra las claves de la CA y de los provisioners `rid-portal` y `rid-gateway-tls` ya creadas |
| `AUTH_SECRET` | Cierra todas las sesiones de la web |

Si falta `RID_SUBJECT_REF_KEY` o `RID_END_USER_HASH_SALT`, o son cortas, o (con `NODE_ENV=production`) son los valores de ejemplo de `.env.example`, el API no puede construir el bundle de OPA y el gateway niega todo. Cada despliegue tiene las suyas (`make-deploy-env.mjs` las genera al azar): así el mismo funcionario o titular no tiene el mismo hash en dos redes (M3-06).

Validaciones al enviar a revisión (M4-06): `RID_VALIDATION_TOKEN` (las rutas de verificación de APISIX solo existen con él), `RID_GATEWAY_INTERNAL_URL` (APISIX como lo alcanza el API), `RID_CONTRACT_RUNNER_URL` y `RID_CONTRACT_RUNNER_TOKEN` (el runner de Schemathesis), `RID_CONTRACT_RUNNER_GATEWAY_URL` (APISIX como lo alcanza el runner) y opcionales `RID_CONTRACT_MAX_EXAMPLES` (20) y `RID_CONTRACT_TIMEOUT_SECONDS` (120). Sin el token, la healthcheck falla y el operador no puede aprobar; sin el runner, la prueba de contrato se omite.

X-Road (M4-05, `ARCHITECTURE.md §4.1`): `RID_XROAD_SECURITY_SERVER_URL` (el Security Server del operador, como lo alcanza APISIX), `RID_XROAD_CLIENT` (el subsistema del operador, `INSTANCIA/CLASE/MIEMBRO/SUBSISTEMA`) y `RID_XROAD_SECURITY_SERVER_CA` (ruta del PEM que verifica el certificado TLS interno del Security Server). Sin las dos primeras, las versiones `xroad` no tienen ruta. Sobre HTTPS, el operador registra en su Security Server el certificado `CN=<RID_GATEWAY_CLIENT_NAME>.xroad` del gateway (objeto SSL `rid-ssl-gateway-xroad`).

Nodos del kit (M4-02, `ARCHITECTURE.md §10`): `RID_NODE_CONTROL_TOKEN` (lo agrega la ruta de control del gateway; sin él y sin `RID_GATEWAY_PORTAL_API_URL` no hay ruta de control), `RID_NODE_CONTROL_URL` (URL del canal de control que se le da al nodo, por defecto `RID_GATEWAY_PUBLIC_URL`), `RID_WG_SUBNET`, `RID_WG_HUB_PUBLIC_KEY` y `RID_WG_HUB_ENDPOINT` (sin estos dos, el enrolamiento da 503), `RID_WG_HUB_AGENT_URL` y `RID_WG_HUB_AGENT_TOKEN` (el agente del hub; sin ellos, el reconciliador no da de alta peers), `RID_GATEWAY_WG_HUB` (el enrutador SNI del hub como lo alcanza APISIX, `wg-hub:8443`; M4-04), y opcionales `RID_NODE_ENROLLMENT_TTL_HOURS` (72), `RID_NODE_HEARTBEAT_SECONDS` (60), `RID_NODE_OFFLINE_AFTER_SECONDS` (300), `RID_NODE_CERT_VALIDITY_HOURS` (2160), `RID_NODE_RENEWAL_GRACE_HOURS` (24) y `RID_NODE_MIN_KIT_VERSION`.

Otras variables del gateway (M3): `RID_GATEWAY_NODES` (cuántos nodos de APISIX atienden el tráfico, 1 por defecto: cada nodo cuenta las peticiones por su lado y el bundle le da a cada uno su parte del límite de la suscripción, ADR-0020; un valor inválido deja a OPA sin bundle), `RID_GATEWAY_TLS_HOSTS` (nombres del certificado de servidor del gateway, por defecto `localhost`; en el piloto, el nombre propio del gateway de M3-10) y `RID_GATEWAY_CLIENT_NAME` (prefijo del certificado de cliente hacia los proveedores, por defecto `rid-gateway`). La ventana de rotación de credenciales es `lifecycle.credentialRotationDays` en la configuración del país (7 días por defecto).

### 4.2 Lo que cambia entre desarrollo y piloto

`scripts/make-deploy-env.mjs` las escribe; en desarrollo valen los valores de `.env.example`.

| Variable | Desarrollo | Piloto |
| :-- | :-- | :-- |
| `DATABASE_URL`, `DATABASE_MIGRATION_URL` | `@localhost:5432` | `@postgres:5432` |
| `KEYCLOAK_URL` | `http://localhost:8080` | `${RID_PUBLIC_URL}/auth` |
| `RID_GATEWAY_KEYCLOAK_URL` | `http://keycloak:8080` | `http://keycloak:8080/auth` |
| `RID_API_URL` | `http://localhost:4000` | `http://api:4000` |
| `APISIX_ADMIN_URL` | `http://localhost:9180` | `http://apisix:9180` |
| `OPA_PORTAL_URL` | `http://host.docker.internal:4000/api/v1/opa` | `http://api:4000/api/v1/opa` |
| `RID_TRANSPARENCY_COLLECTOR_HOST` | `host.docker.internal` | `api` |
| `RID_TSA_URL` | `http://localhost:3004` | `http://tsa:3004` |
| `RID_STEP_CA_URL` | `https://localhost:9000` | `https://step-ca:9000` |
| `RID_STEP_CA_ROOT_FILE` | vacío | `/var/lib/rid/step-ca/root_ca.crt` |
| `RID_WEB_URL`, `AUTH_URL` | `http://localhost:3000` | `${RID_PUBLIC_URL}` |
| `RID_GATEWAY_PUBLIC_URL` | `https://localhost:9443` | `https://<nombre del gateway>` con mTLS (`--gateway-host`); `${RID_PUBLIC_URL}/gw` sin mTLS |
| `RID_CITIZEN_ISSUER` | `http://localhost:8080/realms/rid-citizens` | `${RID_PUBLIC_URL}/auth/realms/rid-citizens` |
| `RID_CARPETA_URL` | `http://localhost:3100` | `${RID_PUBLIC_URL}/carpeta` |
| `RID_CITIZEN_APPS` (webhook) | `http://localhost:3100/api/rid/alerts` | `http://carpeta:3100/carpeta/api/rid/alerts` |
| `RID_DEMO_USER_PASSWORD` | `demo` | aleatoria, salvo `--demo-password` |
| `RID_DEMO_TOTP_SECRET` | `rid-demo-totp-secret` | aleatoria (`pnpm demo:otp` da el código) |
| `RID_GATEWAY_PORTAL_API_URL` (ruta de control de los nodos) | `http://host.docker.internal:4000` | `http://api:4000` |
| `RID_NODE_CONTROL_TOKEN` | valor de desarrollo | aleatorio |
| `RID_WG_HUB_PRIVATE_KEY`, `RID_WG_HUB_PUBLIC_KEY` | par de desarrollo | par aleatorio |
| `RID_WG_HUB_ENDPOINT` | `wg-hub:51820` | `<nombre del gateway>:51820` |
| `MAILPIT_UI_AUTH`, `TRAEFIK_NETWORK`, `RID_PUBLIC_URL` | — | solo piloto |

El API usa `KEYCLOAK_URL` para validar los tokens y para el Admin API de `rid-gateway`: en el piloto llega a Keycloak por la URL pública, a través del proxy.

## 5. Piloto en una máquina

La forma recomendada de instalar el piloto es `sudo ./install.sh` ([`INSTALL.md`](INSTALL.md)): hace las preguntas, escribe `.env` con `make-deploy-env.mjs`, pone el proxy y arranca todo. Esta sección describe lo que hay debajo, para quien lo hace a mano o tiene su propio proxy.

**Proxy incluido (`docker-compose.edge.yml`).** Para un servidor sin proxy propio: Traefik en 80 y 443 con las rutas de §5.2, generadas por `install.sh` desde `infra/edge/rid.yml.template` en `infra/edge/dynamic/rid.yml`. Termina HTTPS en el nombre del portal (Let's Encrypt, o un certificado propio en `infra/edge/certs/`) y pasa el TLS del nombre del gateway intacto a APISIX. En la red `rid-edge` toma los dos nombres públicos como alias (`RID_PORTAL_HOST`, `RID_GATEWAY_HOST`), así el API y la web llegan a Keycloak por la URL pública sin salir del servidor. No lleva log de accesos.

### 5.1 Qué hace el override `docker-compose.deploy.yml`

- Quita todos los puertos publicados (`ports: !reset []`) y pone `restart: unless-stopped`.
- Agrega `api`, `web` y `carpeta` como contenedores. El API aplica migraciones y el seed al arrancar (`RID_ALLOW_SEED=true`) y envía correo a `smtp://mailpit:1025`.
- Une al proxy, por la red externa `${TRAEFIK_NETWORK}` (por defecto `lab-router_default`), solo los servicios que se publican, con alias fijos: `rid-portal-web`, `rid-portal-api`, `rid-keycloak`, `rid-apisix`, `rid-mailpit`, `rid-carpeta`, `rid-tsa`.
- Keycloak con `start_period` de 300 s: en una máquina compartida tarda minutos en arrancar.

### 5.2 Rutas del proxy inverso (un solo nombre público)

| Ruta pública | Destino | Prefijo |
| :-- | :-- | :-- |
| `/` | `rid-portal-web:3000` | se conserva |
| `/api/v1` | `rid-portal-api:4000` | se conserva; **excepto** `/api/v1/internal` y `/api/v1/opa`, que no se publican |
| `/auth` | `rid-keycloak:8080` | se conserva (`KC_HTTP_RELATIVE_PATH=/auth`) |
| `/gw` | `rid-apisix:9080` | **se quita** `/gw` |
| `/mail` | `rid-mailpit:8025` | se conserva (`MP_WEBROOT=/mail`) |
| `/carpeta` | `rid-carpeta:3100` | se conserva (ruta base de `RID_CARPETA_URL`) |
| `/tsa/api/v1/timestamp/certchain` | `rid-tsa:3004` | **se quita** `/tsa`; nada más de la TSA se publica |

`/api/auth/*` (Auth.js) es de la web: por eso la regla del API es `/api/v1`, no `/api`.

Ejemplo para Traefik (proveedor de archivo). No está en el repo; ajústalo a tu proxy y a tu resolutor de certificados:

```yaml
http:
  middlewares:
    rid-strip-gw: { stripPrefix: { prefixes: ['/gw'] } }
    rid-strip-tsa: { stripPrefix: { prefixes: ['/tsa'] } }
  routers:
    rid-web:     { rule: 'Host(`portal.example.org`)', service: rid-web, tls: { certResolver: le } }
    rid-api:     { rule: 'Host(`portal.example.org`) && PathPrefix(`/api/v1`) && !PathPrefix(`/api/v1/internal`) && !PathPrefix(`/api/v1/opa`)', service: rid-api, tls: { certResolver: le } }
    rid-auth:    { rule: 'Host(`portal.example.org`) && PathPrefix(`/auth`)', service: rid-keycloak, tls: { certResolver: le } }
    rid-gw:      { rule: 'Host(`portal.example.org`) && PathPrefix(`/gw`)', service: rid-apisix, middlewares: [rid-strip-gw], tls: { certResolver: le } }
    rid-mail:    { rule: 'Host(`portal.example.org`) && PathPrefix(`/mail`)', service: rid-mailpit, tls: { certResolver: le } }
    rid-carpeta: { rule: 'Host(`portal.example.org`) && PathPrefix(`/carpeta`)', service: rid-carpeta, tls: { certResolver: le } }
    rid-tsa:     { rule: 'Host(`portal.example.org`) && Path(`/tsa/api/v1/timestamp/certchain`)', service: rid-tsa, middlewares: [rid-strip-tsa], tls: { certResolver: le } }
  services:
    rid-web:      { loadBalancer: { servers: [{ url: 'http://rid-portal-web:3000' }] } }
    rid-api:      { loadBalancer: { servers: [{ url: 'http://rid-portal-api:4000' }] } }
    rid-keycloak: { loadBalancer: { servers: [{ url: 'http://rid-keycloak:8080' }] } }
    rid-apisix:   { loadBalancer: { servers: [{ url: 'http://rid-apisix:9080' }] } }
    rid-mailpit:  { loadBalancer: { servers: [{ url: 'http://rid-mailpit:8025' }] } }
    rid-carpeta:  { loadBalancer: { servers: [{ url: 'http://rid-carpeta:3100' }] } }
    rid-tsa:      { loadBalancer: { servers: [{ url: 'http://rid-tsa:3004' }] } }
```

Traefik da más prioridad a la regla más larga, así que `/api/v1`, `/auth`, etc. ganan sobre `/`.

**mTLS (M3-10, `features.mtls.required`).** El TLS del gateway debe terminar en APISIX (SPIKE S-3): detrás de un proxy que termina TLS, `/gw` no puede pasar el certificado del cliente. Hacen falta tres cosas:

1. **Un nombre propio para el gateway**, por ejemplo `gw.example.org`, con paso directo TLS hacia el 9443 de APISIX. APISIX presenta allí su certificado de servidor, emitido por step-ca para `RID_GATEWAY_TLS_HOSTS`. En `.env`: `RID_GATEWAY_PUBLIC_URL=https://gw.example.org` y `RID_GATEWAY_TLS_HOSTS=gw.example.org` (`make-deploy-env.mjs --gateway-host gw.example.org`). Las aplicaciones piden ahí también su token: `https://gw.example.org/oauth/token`.
2. **Que `/auth` borre `SSL_CLIENT_CERT` y `ssl-client-verify`** antes de llegar a Keycloak. Keycloak cree en esas cabeceras (S-4), y solo la ruta de token del gateway puede ponerlas (ADR-0022).
3. Que el puerto 9443 de APISIX esté en la red del proxy. Ya lo está, por el alias `rid-apisix`.

```yaml
tcp:
  routers:
    rid-gateway-mtls:
      rule: 'HostSNI(`gw.example.org`)'
      service: rid-apisix-tls
      tls: { passthrough: true }
  services:
    rid-apisix-tls: { loadBalancer: { servers: [{ address: 'rid-apisix:9443' }] } }
http:
  middlewares:
    rid-no-client-cert-headers:
      headers: { customRequestHeaders: { SSL_CLIENT_CERT: '', ssl-client-verify: '' } }
  routers:
    rid-auth: { rule: 'Host(`portal.example.org`) && PathPrefix(`/auth`)', service: rid-keycloak, middlewares: [rid-no-client-cert-headers], tls: { certResolver: le } }
```

El router TCP necesita que el punto de entrada `websecure` (443) de Traefik sea el mismo de los routers HTTP: Traefik resuelve primero los TCP por SNI. El certificado de `gw.example.org` no lo pide Traefik: lo presenta APISIX. Las aplicaciones confían en él con la raíz de la red (`/api/v1/pki/ca`).


### 5.3 Primer despliegue

```bash
git clone <repo> && cd <repo>
node scripts/make-deploy-env.mjs https://portal.example.org --gateway-host gw.example.org [--traefik-network <red>] [--demo-password <pw>]
# → escribe .env (modo 600) con secretos aleatorios, una clave de firma nueva y los nombres internos.
#   Se niega a sobrescribir un .env existente.
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml \
  --env-file .env --profile observability up -d --build
```

- El build de `api` y `web` tarda varios minutos; Keycloak, uno o dos más.
- Configura el proxy (§5.2) y luego sigue `OPERATIONS.md §2`.
- Guarda una copia del `.env` fuera de la máquina: sin él no se pueden recuperar ni verificar los datos (§4.1).

### 5.4 Actualización

```bash
# 1. Respaldo si la versión trae migraciones (OPERATIONS.md §6)
# 2. Código nuevo
git pull --ff-only
# 3. Reconstruir y reiniciar (todo, o solo los servicios que cambiaron)
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml \
  --env-file .env --profile observability up -d --build [api web carpeta]
```

- Las migraciones se aplican solas al arrancar el API.
- Revisa en las notas de la historia (`BACKLOG.md`) si la versión pide pasos manuales: cambios de realm de Keycloak (no se reimportan, §3.3), variables nuevas en `.env` (`make-deploy-env.mjs` no edita un `.env` existente) o volúmenes nuevos.
- **Al pasar a M3 (M3-01 a M3-04)**, sobre un piloto anterior:
  1. Agregar a `.env`: `RID_STEP_CA_URL=https://step-ca:9000`, `RID_STEP_CA_PROVISIONER_PASSWORD` (= `STEP_CA_PASSWORD`), `RID_STEP_CA_ROOT_FILE=/var/lib/rid/step-ca/root_ca.crt` y, si cambian sus valores por defecto, `RID_GATEWAY_TLS_HOSTS` y `RID_GATEWAY_CLIENT_NAME`.
  2. Recrear `step-ca` (crea el provisioner `rid-gateway-tls`) y `apisix` (carga `rid-client-cert`) antes que el API.
  3. Aplicar la política de rotación al realm existente: `node scripts/keycloak-client-policies.mjs` con `KEYCLOAK_URL` y el administrador de `master` (`OPERATIONS.md §5.3`).
  4. **M3-08 (segundo factor).** Agregar a `.env` un `RID_DEMO_TOTP_SECRET` aleatorio, por ejemplo con `openssl rand -hex 20`. Luego aplicar el flujo y los códigos de demo al realm existente: `node scripts/keycloak-portal-mfa.mjs --demo-otp`. Hazlo antes de arrancar el API nuevo: desde ese momento, los usuarios con rol crítico necesitan el código.
  5. **M3-10 (mTLS).**
     - DNS del nombre del gateway hacia la máquina.
     - Router TCP con paso directo y middleware en `/auth`, como en el ejemplo de §5.2.
     - En `.env`: `RID_GATEWAY_PUBLIC_URL=https://<nombre>` y `RID_GATEWAY_TLS_HOSTS=<nombre>`.
     - Recrear `keycloak` (arranca con el proveedor x509 `nginx`), luego `apisix` y el API. El API reemite el certificado de servidor del gateway para el nombre nuevo, agrega `client.ca` al objeto SSL, crea la ruta `rid-oauth-token` y liga los tokens de cada aplicación al certificado.
     - Desde ese momento, una aplicación sin certificado vigente no puede llamar: cada desarrollador emite el suyo desde la ficha de su aplicación (M3-01).
  6. Con M3-05, durante los primeros 10–20 s tras arrancar el API nuevo, las llamadas permitidas pueden dar 500: las rutas ya llevan `limit-count` y OPA todavía tiene el bundle anterior, sin `X-RID-Rate-Limit`. Se corrige solo con la siguiente descarga del bundle. Si no se tolera, hacer la actualización en una ventana de mantenimiento.
- Un cambio en `infra/apisix/config.yaml`, `infra/opa/config.yaml`, `infra/fluent-bit/*` o `infra/step-ca/*` se monta desde el repo: basta reiniciar ese servicio (`up -d <servicio>` o `restart <servicio>`).

## 6. Desarrollo local

```bash
cp .env.example .env
pnpm install
pnpm infra:up            # o infra:up:core (sin OpenSearch ni el Fluent Bit de analítica)
pnpm db:migrate && pnpm db:seed
pnpm dev                 # web 3000 + api 4000 + carpeta ciudadana 3100
```

| Comando | Qué hace |
| :-- | :-- |
| `pnpm infra:up` / `infra:up:core` | Levanta los servicios y espera su health check (hasta 180 s) |
| `pnpm infra:ps` / `infra:logs` | Estado y logs |
| `pnpm infra:down` | Detiene, conserva datos |
| `pnpm infra:reset` | Detiene y **borra** volúmenes (base de datos, CA, TSA, índices, búfer) |

En desarrollo OPA y `fluent-bit-transparency` llegan al API del host por `host.docker.internal`.

## 7. CI

`.github/workflows/ci.yml`:

| Trabajo | Qué corre |
| :-- | :-- |
| Lint, typecheck, test, licencias | `pnpm format:check`, `typecheck`, `lint`, `test`, `license:check` |
| Integración del API | `docker compose up -d --wait postgres etcd apisix tsa step-ca` y `pnpm --filter @rid/api test:integration`; luego `test:dist` sobre el build |
| Políticas OPA | `opa check --strict`, `opa test`, cobertura ≥ 90 % |

## 8. Límites del piloto frente a producción

| Tema | Piloto (hoy) | Producción (objetivo, `ARCHITECTURE.md §11`) |
| :-- | :-- | :-- |
| Datos iniciales | Siempre carga el seed: entidades ficticias y usuarios de demo, incluidos administradores de plataforma | Sin datos de demo. **Falta** un mecanismo para dar el primer `platform_admin` sin el seed (los roles de plataforma hoy solo los da el seed) |
| Keycloak | `start-dev`, misma instancia de PostgreSQL | Clúster en modo producción, base propia |
| CA | CA de desarrollo en un volumen | Raíz fuera de línea, intermedia en HSM |
| TSA | sigstore con clave en archivo | TSA acreditada del país |
| etcd | Un nodo, sin TLS | Clúster de 3 con mTLS |
| OpenSearch | Sin seguridad, sin retención | Plugin de seguridad, política de retención |
| Correo | Mailpit | SMTP del operador |
| Secretos | `.env` en disco | Gestor de secretos (OpenBao) |
| Alta disponibilidad | Ninguna | ≥ 2 nodos de APISIX con OPA local, ≥ 2 réplicas de web y API, PostgreSQL con réplica |
| Métricas y alertas | No hay Prometheus; APISIX expone métricas en 9091 sin que nadie las lea | Prometheus + Alertmanager (M5-06) |
| Respaldos | `pg_dump` manual | pgBackRest con restauración probada (M6-06) |
| mTLS de aplicaciones | Desactivado (`features.mtls.required: false`, ADR-0010) | Obligatorio desde M3-10 |
