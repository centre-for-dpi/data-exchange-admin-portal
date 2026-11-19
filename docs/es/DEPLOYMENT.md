# Despliegue — Portal DEN

> English version (official): [docs/DEPLOYMENT.md](../DEPLOYMENT.md)

Versión 0.3 · noviembre 2026 · estado del código con M6: todo salvo la prueba de carga (M6-03) y la instalación en un clúster (M6-05), que necesitan el entorno tipo producción del operador

Este documento describe **cómo se despliega cada componente** del portal y del gateway: imagen, configuración, puertos, volúmenes, secretos y dependencias. Cómo dejarlo operativo y cómo operarlo día a día está en [`OPERATIONS.md`](OPERATIONS.md). La arquitectura de referencia está en [`ARCHITECTURE.md`](ARCHITECTURE.md).

> **Alcance (ADR-0011).** Aquí solo se despliega el portal + el gateway. El kit de APIs instantáneas que se instala en las entidades es otro producto, con su propio repositorio. `mock-salud`, `mock-socioeconomico` y la app ciudadana (`citizen-app`) son utilería de pruebas y demostración.

## 1. Topologías

| Topología | Archivos | Estado | Uso |
| :-- | :-- | :-- | :-- |
| **Desarrollo local** | `infra/compose/docker-compose.yml`; web y API en el host con `pnpm dev` | Disponible | Programar y probar |
| **Piloto en una máquina** | `docker-compose.yml` + `docker-compose.deploy.yml`, detrás de un proxy inverso existente o del incluido (`docker-compose.edge.yml`) | Disponible; **instalador interactivo `install.sh`** ([`INSTALL.md`](INSTALL.md)) | Demos, pilotos y bootcamp |
| **Producción** | Helm charts (`infra/helm/`) con la topología de `ARCHITECTURE.md §11` | Escritos y validados de forma estática; **todavía sin instalar en un clúster** (M6-05, §9) | Operador nacional |

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
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-den-opensearch.conf
sudo sysctl --system
```

## 3. Componentes

Todos los servicios están en `infra/compose/docker-compose.yml` (proyecto Compose `den`). En desarrollo, cada puerto publicado se enlaza solo a `127.0.0.1` y se puede mover con su variable `*_PORT` en `.env`. En el piloto no se publica ningún puerto (§5).

Los componentes se agrupan en dos planos (`ARCHITECTURE.md §1`):

- **Plano de gobierno:** PostgreSQL, Keycloak, step-ca, la TSA, el API y la web. Deciden quién puede qué y lo traducen a configuración.
- **Plano de datos:** etcd, APISIX, OPA y los Fluent Bit. Atienden y registran cada llamada entre entidades. Siguen funcionando aunque caiga el plano de gobierno.

Cada subsección empieza por la **función** del componente en el despliegue y sigue con su configuración.

### 3.1 Resumen

| Servicio | Imagen | Puerto interno | Puerto dev (host) | Volumen | Perfil | Health check |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `postgres` | `den/postgres` (`postgres:18.6-alpine` con pgBackRest, `infra/postgres`) | 5432 | `POSTGRES_PORT` 5432 | `pg-data`; en el piloto también `pgbackrest-repo` y `pg-socket` | base | `pg_isready` |
| `pgbackrest` | `den/postgres` | — (sin red) | — | `pg-data`, `pgbackrest-repo`, `pg-socket` | solo piloto (M6-06) | ninguno |
| `keycloak` | `quay.io/keycloak/keycloak:26.8.0` | 8080 (HTTP), 9000 (gestión) | `KEYCLOAK_PORT` 8080 | — (usa `postgres`) | base | `GET /health/ready` en 9000 |
| `etcd` | `quay.io/coreos/etcd:v3.6.16` | 2379 | no se publica | `etcd-data` | base | `etcdctl endpoint health` como `healthcheck` |
| `etcd-init` | `den/etcd-init:local` (`infra/etcd`: etcdctl sobre la imagen de step-ca) | — | — | — | base, una vez antes de APISIX | sale con 0 |
| `apisix` | `apache/apisix:3.19.0-debian` | 9080 (HTTP), 9443 (HTTPS), 9180 (admin), 7085 (estado), 9091 (métricas) | 9080, 9443, 9180 | — (estado en etcd) | base | `GET /status/ready` en 7085 |
| `opa` | `openpolicyagent/opa:1.21.4-static` | 8181 | `OPA_PORT` 8181 | `opa-data` (último bundle, M6-04) | base | `GET /health` |
| `step-ca` | `smallstep/step-ca:0.30.2` | 9000 | `STEP_CA_PORT` 9000 | `step-ca-data` | base | `step ca health` |
| `fluent-bit-transparency` | `fluent/fluent-bit:5.1.5-debug` | 5170 (TCP), 2020 (salud) | no se publica | `transparency-buffer` | base | `GET /api/v1/health` en 2020 |
| `fluent-bit-errors` | `fluent/fluent-bit:5.1.5-debug` | 5140/udp (syslog), 2020 (salud) | no se publica | — | base | `GET /api/v1/health` en 2020 |
| `tsa-init` | `smallstep/step-ca:0.30.2` | — (tarea única) | — | `tsa-data` | base | termina con código 0 |
| `tsa` | `ghcr.io/sigstore/timestamp-server:v2.1.4` | 3004 | `DEN_TSA_PORT` 3004 | `tsa-data` (lectura) | base | ninguno (imagen distroless) |
| `mailpit` | `axllent/mailpit:v1.32.0` | 8025 (UI), 1025 (SMTP) | 8025, 1025 | — | base | `mailpit readyz` |
| `clamav` | `clamav/clamav:1.5.4` | 3310 (clamd) | `CLAMAV_PORT` 3310 | `clamav-data` (firmas) | `antivirus` (M6-08) | `clamdcheck.sh` |
| `mock-salud`, `mock-socioeconomico` | `den/mock-providers:dev` (build local) | 8000 | 8101, 8102 | — | base | `GET /health` |
| `wg-hub` | `den/wg-hub:dev` (build local, `infra/wg-hub`) | 51820/udp (túnel), 8443 (enrutador SNI), 8090 (agente) | 51820/udp y 8095 (agente) en `127.0.0.1` | `wg-hub-data` | base | `GET /health` en 8090 |
| `contract-runner` | `den/contract-runner:dev` (build local, `infra/contract-runner`) | 8096 | `CONTRACT_RUNNER_PORT` 8096 en `127.0.0.1` | — | base | `GET /health` |
| `mock-node` | `den/mock-node:dev` (build local, `infra/mock-node`) | 8443 en su dirección del túnel | no se publica | anónimo | `nodes` | — |
| `opensearch` | `opensearchproject/opensearch:3.9.0` | 9200 | `OPENSEARCH_PORT` 9200 | `opensearch-data` | `observability` | `_cluster/health` amarillo |
| `fluent-bit` | `fluent/fluent-bit:5.1.5-debug` | 9880 (HTTP), 2020 | no se publica | — | `observability` | `GET /api/v1/health` en 2020 |
| `prometheus` | `prom/prometheus:v3.15.1` | 9090 | `PROMETHEUS_PORT` 9090 en `127.0.0.1` | `prometheus-data` | `observability` | `GET /-/ready` |
| `alertmanager` | `prom/alertmanager:v0.34.2` | 9093 | `ALERTMANAGER_PORT` 9093 en `127.0.0.1` | `alertmanager-data` | `observability` | `GET /-/ready` |
| `grafana` | `grafana/grafana:13.3.0` (AGPL, contenedor propio) | 3000 | `GRAFANA_PORT` 3001 en `127.0.0.1` | `grafana-data` | `observability` | `GET /api/health` |
| `api` | `den/portal-api:deploy` (`apps/api/Dockerfile`) | 4000 | — (en dev corre en el host) | `api-documents`, `step-ca-data` (solo `certs/`, lectura) | solo piloto | `GET /api/v1/health` |
| `web` | `den/portal-web:deploy` (`apps/web/Dockerfile`) | 3000 | — (en dev corre en el host) | — | solo piloto | `GET /api/auth/providers` |
| `citizen-app` | `den/mock-citizen-app:deploy` (`infra/mock-citizen-app/Dockerfile`) | 3100 | — (en dev corre en el host) | `citizen-app-data` | solo piloto | — |

Prometheus, Alertmanager y Grafana **no** están en el Compose todavía (M5-06).

### 3.2 PostgreSQL

**Función en el despliegue.** Es la única fuente de verdad del plano de gobierno. Guarda:

- el estado de dominio: entidades, personas y roles, APIs y versiones, aplicaciones, suscripciones y documentos;
- la bitácora de auditoría encadenada por hash, con sus anclajes;
- el outbox y las colas de trabajos en segundo plano (pg-boss; no hay Redis);
- el registro de transparencia y sus lotes sellados;
- en una base aparte, los datos de Keycloak.

Lo que hay en APISIX, OPA y en los clientes de Keycloak se calcula desde aquí, así que se puede reconstruir. Si PostgreSQL cae, el portal se detiene, pero el gateway sigue atendiendo con la última configuración.

- Una sola instancia guarda la base del portal (`POSTGRES_DB`, por defecto `den`), la de pruebas (`den_test`) y la de Keycloak (`keycloak`).
- **Respaldos (M6-06, ADR-0026).** La imagen trae pgBackRest. En el piloto, PostgreSQL archiva su WAL en el repositorio cifrado `pgbackrest-repo` (`PGBACKREST_REPO1_CIPHER_PASS`). El servicio `pgbackrest` toma los respaldos programados: llega a la base por el socket y el volumen de datos, sin red. En desarrollo no se archiva. Procedimiento y restauración en `OPERATIONS.md §6`.
- **Scripts de inicialización** (`infra/postgres/init`, solo con el volumen vacío):
  - `01-keycloak.sh`: rol `KEYCLOAK_DB_USER` y base `keycloak`.
  - `02-app-role.sh`: rol `den_app` (sin DDL) con la contraseña `DEN_APP_DB_PASSWORD`, base `den_test` y privilegios por defecto para que `den_app` use todo lo que cree el dueño.
- **Dos roles del portal:** el dueño del esquema (`POSTGRES_USER`, `den`) solo corre migraciones (`DATABASE_MIGRATION_URL`); el API corre como `den_app` (`DATABASE_URL`). Las tablas de auditoría y de transparencia son de solo inserción incluso para el dueño (triggers, `ARCHITECTURE.md §7` y §13).
- **Migraciones:** Prisma (`apps/api/prisma/migrations`), con `DATABASE_MIGRATION_URL` (`apps/api/prisma.config.ts`). El esquema de la cola pg-boss también es una migración: el API arranca pg-boss sin permisos de DDL (`migrate: false`).
- Las contraseñas de `.env` solo se usan **la primera vez**. Cambiarlas en `.env` con el volumen ya creado no cambia los roles: hay que hacer `ALTER ROLE ... PASSWORD` y actualizar `.env` a la vez.

### 3.3 Keycloak

**Función en el despliegue.** Es el proveedor de identidad: **autentica, no autoriza**. Los roles viven en PostgreSQL (ADR-0004). Tiene tres realms, uno por tipo de usuario:

- **`den-portal`**, para las personas que usan el portal: inicio de sesión OIDC de la web, autorregistro, verificación de correo y recuperación de contraseña.
- **`den-gateway`**, para las aplicaciones consumidoras. Emite los tokens `client_credentials` (5 min, `aud = den-gateway`) que APISIX valida en cada llamada. Sus clientes `den-app-<uuid>` los crea y mantiene el reconciliador del API, nunca una persona.
- **`den-citizens`**, que simula la identidad digital del país para la app ciudadana. En producción se reemplaza por el emisor del país (`DEN_CITIZEN_ISSUER`).

Si Keycloak cae, nadie puede iniciar sesión y las aplicaciones no obtienen tokens nuevos.

- Corre con `start-dev --import-realm` (también en el piloto: el override no cambia el comando).
- Importa al arrancar `infra/keycloak/*-realm.json` (`den-portal`, `den-gateway`, `den-citizens`). Los secretos son marcadores `${VARIABLE}` resueltos con el entorno del contenedor: `DEN_PORTAL_WEB_CLIENT_SECRET`, `DEN_GATEWAY_PROVISIONER_SECRET`, `DEN_CITIZEN_APP_CLIENT_SECRET`, `DEN_WEB_URL`, `DEN_CITIZEN_APP_URL`, `DEN_DEMO_USER_PASSWORD`, `DEN_DEMO_TOTP_SECRET`.
- **La importación no actualiza un realm que ya existe** (`IGNORE_EXISTING`). Un cambio en los JSON, en esos secretos o en las URLs no llega a un Keycloak ya inicializado: se aplica con `kcadm.sh` (ver `OPERATIONS.md §5.3`) o borrando la base de Keycloak.
- Emisor de los tokens: en desarrollo `KC_HOSTNAME=http://localhost:${KEYCLOAK_PORT}`; en el piloto `${DEN_PUBLIC_URL}/auth` con `KC_HTTP_RELATIVE_PATH=/auth` y `KC_PROXY_HEADERS=xforwarded`. `KC_HOSTNAME_BACKCHANNEL_DYNAMIC` deja que los contenedores (APISIX) lo alcancen por nombre de servicio.
- Administrador inicial: `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` (`KC_BOOTSTRAP_ADMIN_*`).
- **Política de cliente `den-secret-rotation`** en `den-gateway` (M3-04): en los clientes con el atributo `den.managed = true`, los que crea el portal, regenerar el secreto deja el anterior como secreto rotado durante la ventana de rotación (a lo sumo 30 días). Llega con el realm en una instalación nueva; en un Keycloak que ya importó el realm se aplica con `node scripts/keycloak-client-policies.mjs` (`OPERATIONS.md §5.3`). Sin ella, rotar un secreto deja de aceptar el anterior en cuanto el reconciliador aplica el nuevo.
- **Segundo factor (M3-08, ADR-0021)** en `den-portal`. El flujo `den-browser` pide la contraseña y, cuando la web pide `acr_values=mfa`, un código TOTP. El API exige ese nivel a los roles de plataforma y a `data_steward`.
  - Llega con el realm en una instalación nueva. En un Keycloak que ya importó el realm se aplica con `node scripts/keycloak-portal-mfa.mjs` (`OPERATIONS.md §5.3`).
  - Sin el flujo, Keycloak no puede dar `acr=mfa`, y esos roles reciben 403 `mfa_required` en todo el portal.
  - Los usuarios semilla con rol crítico traen el código de `DEN_DEMO_TOTP_SECRET`. En producción no hay usuarios semilla: cada persona enrola su app la primera vez.
- **Enlace de verificación (P-08).** Los enlaces de verificación del correo y de restablecimiento de contraseña de `den-portal` duran 60 minutos (`actionTokenGeneratedByUserLifespan: 3600`; Keycloak trae 5). En un Keycloak que ya importó el realm lo aplica `node scripts/keycloak-portal-mfa.mjs`; en el piloto, `sudo ./install.sh realms`, que corre `update`.
- **Usuarios de demo en un piloto (P-08).** La semilla los carga en cada arranque del API (`DEN_ALLOW_SEED=true`). Cuando la gente del operador tiene sus roles, `node dist/admin/demo-users-cli.js disable` en el contenedor del API (`sudo ./install.sh demo-users disable`) los desactiva en Keycloak y en el portal; desde entonces la semilla los deja desactivados. Usa `KEYCLOAK_URL` y el administrador de `master` (`OPERATIONS.md §2.3`).
- **Certificado de cliente de las aplicaciones (M3-10, ADR-0022).** Arranca con el proveedor x509 `nginx` y `trust-proxy-verification` (`--spi-x509cert-lookup--…`, en el compose): lee de `SSL_CLIENT_CERT` el certificado que APISIX ya verificó en la ruta de token del gateway. Por eso ninguna otra vía hacia Keycloak debe dejar pasar esa cabecera ni `ssl-client-verify` (§5.2).
- Detalle de los tres realms y los usuarios semilla: `infra/keycloak/README.md`.

### 3.4 etcd + APISIX

**Función de etcd en el despliegue.** Guarda la configuración del gateway: rutas, upstreams, plugins y objetos SSL. El reconciliador del API la escribe por el Admin API de APISIX, y cada nodo de APISIX la lee y aplica los cambios en cuanto ocurren, sin reiniciar. No es una fuente de verdad: si se pierde, el API la reconstruye desde PostgreSQL.

**Función de APISIX en el despliegue.** Es el **gateway**, el corazón del plano de datos: toda llamada entre entidades pasa por él. En cada petición:

1. valida el token de `den-gateway`;
2. borra las cabeceras `X-DEN-*` que solo el gateway puede poner;
3. si la operación lo declara, lee el titular del cuerpo (plugin `den-data-subject`);
4. pregunta a OPA si la llamada se permite;
5. reenvía la petición al proveedor con las cabeceras de trazabilidad que devolvió OPA;
6. envía los metadatos de la llamada a los dos Fluent Bit: analítica y transparencia.

También termina el TLS del gateway en 9443 con su certificado de servidor y, cuando `features.mtls.required` está activo, exige ahí el certificado de cliente de la aplicación (M3-02). Hacia los proveedores con mTLS presenta el certificado de cliente del gateway de esa entidad (M3-03). No guarda cuerpos de petición ni de respuesta. En el piloto se publica en `/gw`.

- etcd guarda la configuración de APISIX (prefijo `/apisix`). Un solo nodo, HTTP sin TLS, no se publica.
- **etcd pide credenciales (B-15, ADR-0031).** `etcd-init` corre `infra/etcd/init.sh` antes de APISIX en cada arranque. Es idempotente: en un etcd sin autenticación crea `apisix` (su rol solo lee y escribe `/apisix`; `APISIX_ETCD_PASSWORD`), `root` (`ETCD_ROOT_PASSWORD`) y `healthcheck` (sin rol, contraseña pública `healthcheck`, para el chequeo de salud del contenedor), y activa la autenticación sin tocar los datos. En los arranques siguientes vuelve a poner la contraseña de APISIX que dice `.env` si APISIX ya no puede entrar con ella. APISIX entra como `apisix` (`deployment.etcd.user`/`password` en `config.yaml`). La contraseña de root no se puede cambiar una vez puesta (`OPERATIONS.md §5.6`).
- APISIX en modo `traditional` con `config_provider: etcd` (`infra/apisix/config.yaml`, montado de solo lectura). La clave del Admin API llega por `APISIX_ADMIN_KEY`.
- El Admin API (9180) acepta solo direcciones privadas (`127.0.0.0/24`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) y exige la clave. Nunca se expone al público.
- Plugins propios en `infra/apisix/plugins` (montados en `/usr/local/apisix/den`): `den-data-subject` (ADR-0017) `den-client-cert` (M3-02: pasa a OPA la huella RFC 8705 del certificado de cliente verificado), `den-rate-limited` (M3-05: el 429 del límite por suscripción en problem+json) y `den-header-guard` (M3-07: borra toda cabecera `X-DEN-*` del cliente salvo la finalidad y el funcionario). La lista de plugins de `config.yaml` es explícita: un plugin nuevo exige reiniciar APISIX.
- **Objetos SSL** (los crea el reconciliador, como las rutas):
  - `den-ssl-gateway`: certificado de servidor del gateway en los nombres de `DEN_GATEWAY_TLS_HOSTS`, emitido por step-ca y renovado por el portal. Con `features.mtls.required`, además `client.ca` con la CA de la red: sin certificado válido, el handshake falla.
  - `den-ssl-gateway-client-<entityId>`: certificado de cliente que el gateway presenta a los upstreams con mTLS de esa entidad proveedora, `CN=den-gateway.<slug>` (prefijo `DEN_GATEWAY_CLIENT_NAME`). Uno por proveedor, para que una entidad no pueda llegar a la API mTLS de otra con la identidad del gateway. Cada proveedor debe aceptar solo su nombre.
- **Upstreams.** Los proveedores entran por el nodo por defecto; `direct` solo existe donde el país lo lista en `features.upstreams` (ADR-0029). Los `direct` verifican el certificado del proveedor y apuntan a las direcciones que el reconciliador resolvió y encontró públicas, con el nombre como Host y SNI (sin DNS rebinding). Los nodos sobre TLS se verifican contra la CA de la red (M3-03).
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

- Config en `infra/opa/config.yaml`: descarga el bundle `den` de `${OPA_PORTAL_URL}/bundle.tar.gz` con `Bearer ${OPA_BUNDLE_TOKEN}` cada 10–20 s, y reporta la revisión activa a `${OPA_PORTAL_URL}/status`.
- **Estado: el último bundle, en disco (M6-04).** Va en el volumen `opa-data` (`/var/lib/opa`, `persist: true`), que `opa-init` le entrega al uid 1000. Un OPA que reinicia mientras el portal no responde arranca con ese bundle. Sin ninguno no tiene política y el gateway niega todo (falla cerrado).
  - El bundle lleva la clave del seudónimo y la sal del funcionario: el volumen es solo de OPA (modo 700) y se respalda o se destruye como un secreto.
  - Borrar el volumen no daña nada mientras el portal responda: OPA descarga el bundle en la siguiente consulta.
- Los *decision logs* están desactivados a propósito (la entrada lleva cabeceras con datos en claro).
- **Su API pide un token (B-15, ADR-0031).** OPA corre con `--authentication=token --authorization=basic` y `infra/opa/authz.rego`, montado desde el repo fuera del bundle. `/health` y `/metrics` siguen abiertos. El gateway solo puede consultar reglas `.../decision`, con `DEN_OPA_DECISION_TOKEN` en el parámetro de query `den_token`: el plugin opa de APISIX no envía cabeceras propias, así que el reconciliador escribe `den/authz/decision?den_token=…` en cada ruta (OPA registra la ruta sin la query). Todo lo demás (datos, políticas, `/v1/config`) pide `DEN_OPA_ADMIN_TOKEN` como `Authorization: Bearer`. Una ruta sin el token recibe 503 (falla cerrado). El chart de Helm no usa el token: OPA escucha solo en el loopback del pod.
- `OPA_PORTAL_URL`: en desarrollo `http://host.docker.internal:4000/api/v1/opa` (el API corre en el host); en el piloto `http://api:4000/api/v1/opa`.

### 3.6 step-ca

**Función en el despliegue.** Es la autoridad certificadora de la red. Firma:

- los certificados de cliente de las aplicaciones consumidoras, a partir de los CSR que las entidades suben al portal (M3-01). Sirven para el mTLS con el gateway y para los tokens ligados al certificado (RFC 8705) cuando `features.mtls.required` está activo;
- el certificado de servidor TLS del gateway (M3-02);
- los certificados de cliente del gateway hacia los proveedores con mTLS, uno por entidad (M3-03).

También firma los de los nodos del kit al enrolarse y al renovarse (M4-02). Solo el API habla con ella: las entidades y los nodos nunca la llaman directamente.

- En el primer arranque la imagen inicializa la CA con `DOCKER_STEPCA_INIT_*`: nombre `DEN Dev CA`, DNS `localhost,step-ca`, provisioner JWK `den-portal`, contraseña `STEP_CA_PASSWORD`. **El piloto usa esta misma CA de desarrollo**; la raíz fuera de línea y la intermedia en HSM son de producción (M6).
- En cada arranque, `infra/step-ca/configure.sh` ajusta el provisioner `den-portal` (plantilla `app.tpl`, solo autenticación de cliente, 90 días por defecto, 397 como máximo). También crea, si no existe, el provisioner `den-gateway-tls` con la contraseña de la CA (plantilla `gateway.tpl`, solo autenticación de servidor, 90 días) y el provisioner `den-nodes` de los nodos del kit (plantilla `node.tpl`, autenticación de servidor y de cliente, 90 días, M4-02). Luego inicia la CA. Es idempotente: una CA existente recibe un provisioner nuevo al reiniciar el contenedor.
- El portal genera las claves de los certificados del gateway y las guarda selladas con `DEN_SECRETS_KEY` (tabla `gateway_certificate`). Los renueva en el último tercio de su vida, en la pasada completa del reconciliador de APISIX.
- El estado (raíz, intermedia, claves, `secrets/password`) vive en `step-ca-data`. **Perder ese volumen invalida todos los certificados emitidos.**
- El API firma los CSR con los provisioners (`DEN_STEP_CA_URL`, `DEN_STEP_CA_PROVISIONER`, `DEN_STEP_CA_GATEWAY_PROVISIONER`, `DEN_STEP_CA_PROVISIONER_PASSWORD` = `STEP_CA_PASSWORD` para los dos) y verifica el TLS de la CA con `DEN_STEP_CA_ROOT_FILE` o `DEN_STEP_CA_ROOT_FINGERPRINT`. Con `NODE_ENV=production` (imágenes del piloto) una de las dos es **obligatoria**; sin ninguna, solo en desarrollo, confía en la raíz que sirve la CA.

### 3.7 Registro de transparencia: Fluent Bit + TSA

**Función de `fluent-bit-transparency` en el despliegue.** Lleva del gateway al portal el registro de cada llamada **autorizada** que tocó datos de una persona: quién consultó, para qué, con qué suscripción y el seudónimo del titular, nunca la ruta ni el número de documento. Deja solo los campos permitidos y descarta las llamadas sin seudónimo o que no llegaron al proveedor. Con su búfer en disco no se pierden registros si el API está caído. Sin este servicio, el ciudadano no ve quién consultó sus datos (ADR-0015).

**Función de `tsa-init` en el despliegue.** Es una tarea que corre una sola vez: genera la cadena de certificados de la TSA de desarrollo y termina.

**Función de `tsa` en el despliegue.** Es la autoridad de sellado de tiempo (RFC 3161), independiente de la clave del operador. Sella dos cosas: los puntos de control del registro de transparencia y el anclaje diario de la bitácora de auditoría. Con el sello cualquiera puede probar que esos datos existían en ese momento y que no se reescribieron después (ADR-0016). Su cadena pública permite que terceros (la app ciudadana, `den-verify-receipt`) verifiquen los sellos sin confiar en el portal.

- **Solo APISIX alcanza las entradas de Fluent Bit (B-17, ADR-0031).** En Fluent Bit 5.1.5 no tienen autenticación, así que los tres Fluent Bit están en la red `logs` con APISIX y en ninguna otra salvo la que usa cada uno para entregar: `analytics` (con OpenSearch) y, en el piloto, `collector` (con el API).
- `fluent-bit-transparency` (`infra/fluent-bit/transparency.yaml`): entrada TCP 5170 en JSON, filtro Lua `transparency.lua`, salida HTTP a `${DEN_TRANSPARENCY_COLLECTOR_HOST}:${DEN_TRANSPARENCY_COLLECTOR_PORT}/api/v1/internal/subject-access` con `Bearer ${DEN_TRANSPARENCY_INGEST_TOKEN}`. Búfer en disco (`transparency-buffer`, hasta 1 GB) y reintentos sin límite: si el API cae, los registros esperan.
- `tsa-init` crea una sola vez la cadena de la TSA de desarrollo en `tsa-data` (`infra/tsa/init.sh`). `tsa` es sigstore timestamp-server con esa clave. En producción se usa la TSA acreditada del país (`DEN_TSA_URL`).
- La cadena de la TSA es pública: `GET /api/v1/timestamp/certchain`.

**Función de `fluent-bit-errors` en el despliegue (M5-01).** Recibe el error log de nginx en APISIX por syslog. Un error real, por ejemplo un proveedor que no responde, trae la línea de la petición y la URI del upstream, con el número de identificación en la ruta. Este servicio las enmascara (`infra/fluent-bit/gateway-errors.lua`) y escribe el resultado en su salida: **el operador lee los errores del gateway con `docker logs den-fluent-bit-errors-1`, no en APISIX**. APISIX depende de él para arrancar, porque nginx resuelve el nombre del servidor syslog al leer su configuración. Si este servicio se cae, los errores se pierden (UDP) y el tráfico no se afecta.

### 3.8 Analítica: Fluent Bit + OpenSearch (perfil `observability`)

**Función de `fluent-bit` en el despliegue.** Es la segunda barrera de privacidad del log de acceso. Recibe del `http-logger` de APISIX los metadatos de **todas** las llamadas, también las negadas con su razón. Descarta cualquier campo fuera de la lista permitida y todo valor sin la forma que pone el gateway. Convierte números y latencias y escribe el resto en OpenSearch.

**Función de `opensearch` en el despliegue.** Guarda los logs de acceso para la analítica de uso: llamadas por consumidor, por finalidad y por operación, latencias y razones de negación. Lo consultan las pantallas de uso y los indicadores (M5-02 a M5-05). Se puede prescindir de él: sin él esas pantallas dicen que la analítica no está disponible, y el tráfico, la auditoría y el registro de transparencia siguen igual.

- `fluent-bit` (`infra/fluent-bit/fluent-bit.yaml`): entrada HTTP 9880, filtro `allowlist.lua`, salida a OpenSearch, índice `den-access-YYYY.MM`.
- OpenSearch en modo un solo nodo **sin plugin de seguridad** (`DISABLE_SECURITY_PLUGIN=true`), solo dentro de la red de Compose. El API lo alcanza en `DEN_OPENSEARCH_URL` (`http://opensearch:9200` en el piloto); con el plugin de seguridad, `DEN_OPENSEARCH_AUTH=usuario:clave`.
- El API mantiene la plantilla de índice `den-access` (campos tipados, `dynamic: strict`) y la política de retención ISM `den-access-retention` (`retention.accessLogMonths` del país, más un mes). Lo hace al arrancar y cada hora, y el estado queda en `sync_state` (`opensearch:*`). No hay que crearlas a mano.
- **Al desplegar M5 sobre un OpenSearch que ya tenía datos:** los índices `den-access-*` anteriores tienen un mapeo dinámico (números como texto) que la plantilla no cambia. En el piloto se borran: `curl -X DELETE 'http://opensearch:9200/den-access-*'`, desde un contenedor de la red. Son logs de la demo.
- `pnpm infra:up:core` levanta todo sin este perfil. Las rutas siguen enviando a `fluent-bit:9880`; sin ese servicio, esos logs se pierden y el tráfico no se afecta.

### 3.8.1 Métricas y alertas: Prometheus, Alertmanager y Grafana (perfil `observability`, M5-06)

**Función de `prometheus` en el despliegue.** Recoge las métricas de APISIX, del API (`GET /metrics` con `DEN_METRICS_TOKEN`) y de OPA, y evalúa las alertas de `ARCHITECTURE.md §9`. También da al API la disponibilidad del gateway, que es uno de los indicadores de la red. Sin él no hay alertas y ese indicador queda "sin datos"; el tráfico no se afecta.

**Función de `alertmanager` en el despliegue.** Agrupa las alertas y las manda por correo al operador. En desarrollo y en el piloto llegan a Mailpit (`operaciones@den.example`). En producción se monta un `alertmanager.yml` propio con el SMTP y la dirección del operador.

**Función de `grafana` en el despliegue.** Muestra el tablero del operador (`DEN · Operador`), aprovisionado desde `infra/grafana`, sin edición en la interfaz: los cambios van por el repositorio. Su usuario es `admin`, con `GRAFANA_ADMIN_PASSWORD`. En el piloto queda detrás del proxy en `/grafana` (`GRAFANA_ROOT_URL`, `GRAFANA_SERVE_FROM_SUB_PATH=true`).

- Prometheus no expande variables en su configuración. Su entrada escribe `DEN_METRICS_TOKEN` en el archivo que lee su trabajo `api` (`credentials_file`). En desarrollo, `api` apunta al API del host (`extra_hosts`); en el piloto, al contenedor.
- Retención de métricas: `PROMETHEUS_RETENTION` (30 días por defecto).

### 3.9 Mailpit

**Función en el despliegue.** Hace de servidor de correo de pruebas: captura todo el correo saliente sin entregarlo a nadie y lo muestra en una bandeja web. Eso incluye las invitaciones, las notificaciones del portal, los anclajes enviados a los reguladores, los correos de verificación y recuperación de Keycloak y los avisos de la app ciudadana. Ocupa el lugar del SMTP real del operador.

- Recibe todo el correo de desarrollo y del piloto (SMTP 1025): el del API (`DEN_SMTP_URL`), el de Keycloak (verificación y recuperación) y el de la app ciudadana.
- En el piloto se sirve en `/mail` (`MP_WEBROOT`) detrás de usuario y contraseña (`MP_UI_AUTH=${MAILPIT_UI_AUTH}`): Keycloak envía allí los enlaces de recuperación de contraseña, así que una bandeja abierta permitiría tomar cualquier cuenta.
- En producción se reemplaza por el SMTP real del operador (`DEN_SMTP_URL`, `DEN_MAIL_FROM`).

### 3.9.1 Antivirus: ClamAV (perfil `antivirus`, M6-08)

**Función en el despliegue.** Revisa cada documento que se sube (designaciones, acuerdos, anexos) antes de guardarlo (ASVS 5.4.3). Es `clamd` en su propio contenedor (GPL-2.0, nunca enlazado: regla 1). Su `freshclam` actualiza las firmas desde internet.

- Se activa con el perfil `antivirus` y `DEN_CLAMAV_URL` en el API (`tcp://clamav:3310` en el piloto; `install.sh` lo pregunta).
- El API le manda el documento por el protocolo INSTREAM de clamd, después de comprobar que es un PDF y antes de escribirlo:
  - si clamd encuentra algo, el documento no se guarda y el usuario ve un error en el campo; el log del API registra la firma y el SHA-256 del archivo, nunca el nombre ni el contenido;
  - si clamd no responde, la subida falla (503) y el documento no se guarda (falla cerrada).
- El primer arranque descarga las firmas (unos minutos) y usa ~1,2 GB de memoria.
- Sin `DEN_CLAMAV_URL` no hay revisión: los documentos solo se comprueban como PDF.

### 3.10 API del portal (`apps/api`)

**Función en el despliegue.** Es el centro del plano de gobierno, y el único componente que escribe en APISIX, Keycloak (`den-gateway`) y step-ca. Tiene dos caras:

- **REST (`/api/v1`).** Atiende a la web y a los sistemas. Aplica los flujos de publicación, solicitud y aprobación. Verifica rol y pertenencia a la entidad en cada endpoint y registra cada cambio en la bitácora.
- **Trabajos en segundo plano.** Traducen el estado de PostgreSQL a configuración: rutas, upstreams y objetos SSL de APISIX, clientes de Keycloak (con la rotación de secretos) y bundle de OPA. También firman certificados con step-ca, reciben y sellan el registro de transparencia (firma del operador más sello de la TSA), envían correos y webhooks, y vencen suscripciones, versiones, certificados y ventanas de rotación de credenciales.

Además sirve la API del titular que consume la app ciudadana.

- Imagen: `apps/api/Dockerfile`, construida desde la raíz del repo (`COPY . .`). **La configuración del país (`config/country/*.yaml`) queda dentro de la imagen**: un cambio en el YAML exige reconstruir.
- Al arrancar: `prisma migrate deploy` (migraciones como dueño) → el seed (`dist/seed/main.js`) si `DEN_ALLOW_SEED=true` → `node dist/main.js` en `API_PORT` (4000). Si la configuración del país es inválida o falta `DEN_COUNTRY`, termina con código 1.
- Corre como usuario `node`. Documentos en `/var/lib/den/documents` (`DEN_DOCUMENTS_DIR`, volumen `api-documents`); allí quedan también los paquetes del kit que el operador sirve desde el portal (P-03), hasta `DEN_KIT_BUNDLE_MAX_BYTES` cada uno (128 MiB por defecto).
- **Trabajos en segundo plano en el mismo proceso** (`OPERATIONS.md §3`). `DEN_WORKER=off` arranca el API sin ellos (pruebas, réplicas de solo lectura).
- Expone `/api/v1/*`. Rutas que **nunca** van al ingreso público: `/api/v1/internal/*` (colector de transparencia) y `/api/v1/opa/*` (bundle y estado de OPA).

### 3.11 Web del portal (`apps/web`)

**Función en el despliegue.** Es la interfaz de las personas. Por un lado, el portal de desarrolladores: catálogo, documentación interactiva, aplicaciones y solicitudes de acceso. Por otro, las consolas de cada rol: publicador, responsable de datos, administrador de entidad, operador, regulador y auditoría. Inicia sesión con Keycloak (`den-portal`) y llama al API con el token del usuario, guardado en la cookie cifrada de Auth.js. No tiene base de datos propia, y la autorización la decide siempre el API.

- Imagen: `apps/web/Dockerfile`. Se compila con secretos de relleno; los reales llegan en tiempo de ejecución. `/files/entity-check.sh` (P-05) se genera desde `scripts/entity-check.sh` al compilar la imagen, que además lleva una copia: un cambio en el script requiere recompilarla.
- Variables: `AUTH_URL`, `AUTH_SECRET`, `KEYCLOAK_URL`, `DEN_PORTAL_WEB_CLIENT_ID`, `DEN_PORTAL_WEB_CLIENT_SECRET`, `DEN_API_URL` (interno, `http://api:4000`), `DEN_WEB_URL`, `DEN_GATEWAY_PUBLIC_URL`, opcional `DEN_AUTH_REFRESH_BEFORE_SECONDS` y `DEN_SESSION_IDLE_SECONDS` (el `ssoSessionIdleTimeout` del realm, 1800 por omisión: la web avisa dos minutos antes de que la sesión termine por inactividad y ofrece seguir, WCAG 2.2.1; si se cambia uno, se cambia el otro). En el piloto, `AUTH_TRUST_HOST=true` (está detrás del proxy).
- Corre con `next start` en 3000.
- **Cabeceras de seguridad (M3-09).** La web pone ella misma la CSP con nonce, HSTS y el resto de las cabeceras (`ARCHITECTURE.md §12`). El proxy de delante no debe quitarlas ni reemplazarlas; tampoco debe agregar otra `Content-Security-Policy`, porque el navegador aplicaría las dos.
  - HSTS va siempre, con `includeSubDomains`: publica la web en un nombre cuyos subdominios también se sirvan por HTTPS.
  - Si Keycloak está en otro origen, `KEYCLOAK_URL` lo autoriza en `form-action`.

### 3.12 App ciudadana de referencia (`infra/mock-citizen-app`)

**Función en el despliegue.** En las demos hace el papel de la aplicación ciudadana del país. El ciudadano:

- entra con la identidad digital simulada (`den-citizens`);
- ve quién consultó sus datos, para qué y con qué resultado;
- recibe avisos por correo cuando lo consultan (webhooks firmados del portal);
- verifica cada comprobante por su cuenta, sin confiar en el portal.

Muestra lo que debe implementar una app ciudadana real; no es un producto.

- Utilería de demostración (MT-07). Su URL pública (`DEN_CITIZEN_APP_URL`) fija la ruta base: en el piloto, `/citizen-app`.
- Variables principales: `DEN_CITIZEN_APP_URL`, `DEN_CITIZEN_ISSUER`, `DEN_CITIZEN_APP_CLIENT_SECRET`, `CITIZEN_APP_WEBHOOK_SECRET` (obligatoria), `CITIZEN_APP_PORTAL_API_URL`, `CITIZEN_APP_JWKS_URL`, `CITIZEN_APP_TSA_ROOT_URL`, `CITIZEN_APP_SMTP_HOST/PORT`, `CITIZEN_APP_DATA_FILE`.
- Guarda correos de ciudadanos y vínculos de avisos en `citizen-app-data` (`alerts.json`).

### 3.13 Proveedores de prueba (`infra/mock-providers`)

**Función en el despliegue.** `mock-salud` y `mock-socioeconomico` simulan los servicios de dos entidades proveedoras (y, con `carga-*` en `DEN_DEV_NODES`, las APIs sintéticas de la prueba de carga, M6-03) con datos sintéticos (ADR-0009). Ocupan el lugar de los nodos del kit hasta M4: el reconciliador apunta los upstreams a ellos según `DEN_DEV_NODES` (`slug=host:puerto`; con `https://host:puerto`, el gateway les habla con mTLS como a un nodo enrolado). Registran en su log las cabeceras `X-DEN-*` que reciben, y así la demo muestra qué le llega al proveedor. En producción no existen: los upstreams son nodos del kit, APIs existentes de las entidades o un Security Server de X-Road.

- Una sola imagen (`den/mock-providers:dev`); `PROVIDER` elige el servicio y sus datos (`salud` o `socioeconomico`), con su OpenAPI en `infra/mock-providers/<proveedor>/openapi.yaml`.
- Escuchan en 8000 dentro de la red de Compose; en desarrollo se publican en 8101 y 8102.
- Verifican la aserción firmada del gateway (`X-DEN-Assertion`, M6-10) como lo haría un proveedor real, con el JWKS de `DEN_GATEWAY_JWKS_URL`: en desarrollo, el API del host (`MOCK_GATEWAY_JWKS_URL`); en el piloto, la URL pública del portal. Registran el resultado (`verified`, `absent` o `invalid: <motivo>`) y la demo lo comprueba. Con `MOCK_ASSERTION_REQUIRED=true` rechazan (401) la llamada sin una aserción válida.

### 3.14 Hub WireGuard (`infra/wg-hub`, M4-03, ADR-0023)

**Función en el despliegue.** Es el extremo central de los túneles de los nodos del kit, que corren en las redes de las entidades, detrás de su firewall. El gateway llama a un nodo a través del hub: APISIX abre TLS hacia `wg-hub:8443` con el nombre del nodo (`den-node-<id>`) como SNI, y el nginx `stream` del hub pasa la conexión, sin abrirla, a la dirección del nodo dentro del túnel. El TLS es de punta a punta entre el gateway y el nodo. Sin el hub, las versiones servidas por nodos no responden.

- Al arrancar, el agente (`hub-agent.mjs`) levanta `wg0` en la primera dirección de `DEN_WG_SUBNET` con `DEN_WG_HUB_PRIVATE_KEY`. Usa WireGuard del kernel si el host lo tiene; si no, `wireguard-go`.
- El contenedor necesita `NET_ADMIN` y `/dev/net/tun`. Corre con `net.ipv4.ip_forward=0`: el hub no reenvía paquetes, y su firewall descarta todo lo nuevo que llega por `wg0`. Un nodo no alcanza otros nodos, el hub ni la plataforma.
- El agente (puerto 8090, `DEN_WG_HUB_AGENT_TOKEN`, solo red interna) recibe del reconciliador del portal el estado completo (peers y rutas SNI) y lo aplica con `wg syncconf` y una recarga de nginx. Guarda el último estado en `wg-hub-data`, así un reinicio vuelve a servir a los nodos antes de la siguiente pasada.
- Los nodos llegan al hub por UDP 51820 desde internet. En el piloto, `docker-compose.deploy.yml` publica ese puerto (`WG_HUB_UDP_PORT`), y `DEN_WG_HUB_ENDPOINT` es el nombre público con ese puerto. El firewall del host debe dejarlo pasar.
- La clave privada del hub está en `.env` (`make-deploy-env.mjs` la genera). Cambiarla obliga a reenrolar todos los nodos, porque la clave pública va en su configuración.
- `mock-node` (perfil `nodes`) es un nodo simulado para pruebas: espera un token en `/var/lib/mock-node/token`, se enrola, se une al hub y sirve `mock-salud` por mTLS. No es el kit (ADR-0011).

## 4. Variables de entorno

La referencia completa, comentada, es `.env.example`. Todos los servicios leen el mismo `.env` de la raíz (Compose con `--env-file .env`; en el piloto también `env_file` para `api`, `web` y `citizen-app`).

### 4.1 Secretos que no se pueden cambiar a la ligera

| Variable | Qué pasa si cambia |
| :-- | :-- |
| `DEN_SUBJECT_REF_KEY` (≥ 32 caracteres) | Cambia el seudónimo de cada titular: se pierde el vínculo entre un ciudadano y sus registros anteriores |
| `DEN_END_USER_HASH_SALT` (≥ 16 caracteres) | Cambian todos los hashes de funcionario |
| `DEN_TRANSPARENCY_SIGNING_JWK` | Los comprobantes anteriores solo verifican si la clave pública vieja pasa a `DEN_TRANSPARENCY_RETIRED_JWKS` |
| `DEN_SECRETS_KEY` (32 bytes base64). Se rota con `DEN_SECRETS_KEYS_PREVIOUS` y `secrets:reseal` (`OPERATIONS.md §5.6`), nunca reemplazándola sin más | Si se reemplaza sin rotar, no se pueden abrir los secretos de cliente sellados que el reconciliador de Keycloak aún no aplicó, ni las claves de los certificados del gateway (`gateway_certificate`): el reconciliador de APISIX falla hasta que se emitan certificados nuevos |
| `POSTGRES_PASSWORD`, `DEN_APP_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD` | Solo se aplican al crear el volumen (§3.2) |
| `DEN_PORTAL_WEB_CLIENT_SECRET`, `DEN_GATEWAY_PROVISIONER_SECRET`, `DEN_CITIZEN_APP_CLIENT_SECRET` | Solo se aplican al importar el realm (§3.3) |
| `STEP_CA_PASSWORD` | Cifra las claves de la CA y de los provisioners `den-portal` y `den-gateway-tls` ya creadas |
| `AUTH_SECRET` | Cierra todas las sesiones de la web |
| `DEN_APISIX_KEYRING` (16 caracteres) | APISIX no puede leer las claves privadas que cifró con el anterior (TLS del gateway, aserciones). Para rotarlo, se agrega el nuevo **primero** en `data_encryption.keyring` dejando el anterior detrás, hasta que el reconciliador reescriba esos objetos |

Si falta `DEN_SUBJECT_REF_KEY` o `DEN_END_USER_HASH_SALT`, o son cortas, o (con `NODE_ENV=production`) son los valores de ejemplo de `.env.example`, el API no puede construir el bundle de OPA y el gateway niega todo. Cada despliegue tiene las suyas (`make-deploy-env.mjs` las genera al azar): así el mismo funcionario o titular no tiene el mismo hash en dos redes (M3-06).

Seguridad del API (M6-01):
- `DEN_TRUST_PROXY`: quién puede fijar `X-Forwarded-For`, la dirección del llamante en los límites y en los eventos de seguridad.
  - La dirección del proxy o su red, separadas por comas (`172.30.0.2`). En el piloto es la dirección de Traefik en la red `edge`: `docker inspect -f '{{(index .NetworkSettings.Networks "lab-router_default").IPAddress}}' <contenedor-de-traefik>`. Si Traefik cambia de dirección al reiniciarse, se fija con `ipv4_address` en su Compose.
  - La red completa solo si en ella no hay más contenedores que el proxy y el portal: cualquier otro podría elegir con qué dirección se registra y se limita.
  - Un número confía en ese número de saltos, venga de donde venga: solo donde nada más que el proxy alcanza el API.
  - Vacío (lo que genera `make-deploy-env.mjs` si no se le pasa): nadie. Los llamantes sin sesión comparten entonces la cuota de la dirección del proxy.
- `DEN_LOG_FORMAT`: `text` (por omisión) o `json`, un objeto por línea para un colector de logs (el chart de Helm fija `json`). Las líneas van enmascaradas en los dos formatos (`ARCHITECTURE.md §8`).
- `DEN_RATE_LIMIT_PER_MINUTE` (600 por usuario verificado, o por dirección sin un token válido) y `DEN_RATE_LIMIT_STRICT_PER_MINUTE` (30 en subidas, versiones nuevas, solicitudes de alta, invitaciones y enrolamiento de nodos).

**Redes de Compose (M6-01).** `default` es la plataforma, `gateway` es el control del gateway (etcd y OPA solo ahí, ambos con credenciales desde B-15), `providers` son los upstreams y el runner de contrato, y `logs` une a APISIX con sus Fluent Bit (B-17), que llegan a OpenSearch por `analytics` y, en el piloto, al API por `collector`. En el piloto APISIX no está en `default`. El API no está en `providers`: comparte con el runner de contrato la red `runner`, solo de ellos dos. Ver `ARCHITECTURE.md §12`.

**Desplegar M6-04 sobre un piloto existente.** `up -d` crea el volumen `opa-data`, corre `opa-init` y recrea OPA: durante unos segundos no hay OPA y el gateway niega (falla cerrado).

**Desplegar M6-03 sobre un piloto existente.** Las rutas pasan a consultar `den/authz/decision`, que solo existe en el bundle nuevo de OPA. Hasta que OPA lo descarga (10–20 s después de arrancar el API nuevo), las llamadas se niegan, como en el paso 6 de M3. Conviene hacerlo en una ventana de poco tráfico.

**Desplegar M6-01 sobre un piloto existente:**
1. Agregar `DEN_APISIX_KEYRING` (16 caracteres al azar) y `DEN_TRUST_PROXY` (la dirección de Traefik, arriba) al `.env`.
2. Recrear todo con `up -d`: cambian las redes.
3. Aplicar al realm `den-portal` ya importado la política de contraseñas, las URIs exactas y los eventos (con `kcadm`, como en §3.3), y las URIs exactas al realm `den-citizens`.
4. Si el Traefik es propio, agregar los límites `den-rate-api` y `den-rate-auth` de `infra/edge/den.yml.template`.

Plano de control del gateway (B-15, ADR-0031): `DEN_OPA_DECISION_TOKEN` (el token del gateway para las decisiones de OPA; el API lo escribe en las rutas y OPA lo verifica) y `DEN_OPA_ADMIN_TOKEN` (el resto del API de OPA), de 32 caracteres o más; `APISIX_ETCD_PASSWORD` (el usuario de APISIX en etcd) y `ETCD_ROOT_PASSWORD` (el root de etcd, para `etcd-init` y el operador). `make-deploy-env.mjs` los genera e `install.sh` los agrega a un `.env` anterior.

Analítica (M5): `DEN_OPENSEARCH_URL` (OpenSearch como lo alcanza el API) y opcional `DEN_OPENSEARCH_AUTH`.

Métricas y alertas (M5-06):
- `DEN_METRICS_TOKEN`, el token con que Prometheus lee `/metrics` del API; sin él, el endpoint no existe.
- `DEN_PROMETHEUS_URL`, Prometheus como lo alcanza el API, para la disponibilidad del gateway.
- `GRAFANA_ADMIN_PASSWORD`, y en el piloto `GRAFANA_ROOT_URL` y `GRAFANA_SERVE_FROM_SUB_PATH`.

`make-deploy-env` las genera.

Validaciones al enviar a revisión (M4-06): `DEN_VALIDATION_TOKEN` (las rutas de verificación de APISIX solo existen con él), `DEN_GATEWAY_INTERNAL_URL` (APISIX como lo alcanza el API), `DEN_CONTRACT_RUNNER_URL` y `DEN_CONTRACT_RUNNER_TOKEN` (el runner de Schemathesis), `DEN_CONTRACT_RUNNER_GATEWAY_URL` (APISIX como lo alcanza el runner) y opcionales `DEN_CONTRACT_MAX_EXAMPLES` (20) y `DEN_CONTRACT_TIMEOUT_SECONDS` (120). Sin el token, la healthcheck falla y el operador no puede aprobar; sin el runner, la prueba de contrato se omite.

X-Road (M4-05, `ARCHITECTURE.md §4.1`): `DEN_XROAD_SECURITY_SERVER_URL` (el Security Server del operador, como lo alcanza APISIX), `DEN_XROAD_CLIENT` (el subsistema del operador, `INSTANCIA/CLASE/MIEMBRO/SUBSISTEMA`) y `DEN_XROAD_SECURITY_SERVER_CA` (ruta del PEM que verifica el certificado TLS interno del Security Server). Sin las dos primeras, las versiones `xroad` no tienen ruta, y el portal no ofrece X-Road a los proveedores aunque el país lo liste en `features.upstreams` (ADR-0029); un país que solo lista `xroad` las necesita, o el API no arranca. Sobre HTTPS, el operador registra en su Security Server el certificado `CN=<DEN_GATEWAY_CLIENT_NAME>.xroad` del gateway (objeto SSL `den-ssl-gateway-xroad`).

Nodos del kit (M4-02, `ARCHITECTURE.md §10`): `DEN_NODE_CONTROL_TOKEN` (lo agrega la ruta de control del gateway; sin él y sin `DEN_GATEWAY_PORTAL_API_URL` no hay ruta de control), `DEN_NODE_CONTROL_URL` (URL del canal de control que se le da al nodo, por defecto `DEN_GATEWAY_PUBLIC_URL`), `DEN_WG_SUBNET`, `DEN_WG_HUB_PUBLIC_KEY` y `DEN_WG_HUB_ENDPOINT` (sin estos dos, el enrolamiento da 503), `DEN_WG_HUB_AGENT_URL` y `DEN_WG_HUB_AGENT_TOKEN` (el agente del hub; sin ellos, el reconciliador no da de alta peers), `DEN_GATEWAY_WG_HUB` (el enrutador SNI del hub como lo alcanza APISIX, `wg-hub:8443`; M4-04), y opcionales `DEN_NODE_ENROLLMENT_TTL_HOURS` (72), `DEN_NODE_HEARTBEAT_SECONDS` (60), `DEN_NODE_OFFLINE_AFTER_SECONDS` (300), `DEN_NODE_CERT_VALIDITY_HOURS` (2160), `DEN_NODE_RENEWAL_GRACE_HOURS` (24) y `DEN_NODE_MIN_KIT_VERSION`.

Otras variables del gateway (M3): `DEN_GATEWAY_NODES` (cuántos nodos de APISIX atienden el tráfico, 1 por defecto: cada nodo cuenta las peticiones por su lado y el bundle le da a cada uno su parte del límite de la suscripción, ADR-0020; un valor inválido deja a OPA sin bundle), `DEN_GATEWAY_TLS_HOSTS` (nombres del certificado de servidor del gateway, por defecto `localhost`; en el piloto, el nombre propio del gateway de M3-10) y `DEN_GATEWAY_CLIENT_NAME` (prefijo del certificado de cliente hacia los proveedores, por defecto `den-gateway`). La ventana de rotación de credenciales es `lifecycle.credentialRotationDays` en la configuración del país (7 días por defecto).

### 4.2 Lo que cambia entre desarrollo y piloto

`scripts/make-deploy-env.mjs` las escribe; en desarrollo valen los valores de `.env.example`.

| Variable | Desarrollo | Piloto |
| :-- | :-- | :-- |
| `DATABASE_URL`, `DATABASE_MIGRATION_URL` | `@localhost:5432` | `@postgres:5432` |
| `KEYCLOAK_URL` | `http://localhost:8080` | `${DEN_PUBLIC_URL}/auth` |
| `DEN_GATEWAY_KEYCLOAK_URL` | `http://keycloak:8080` | `http://keycloak:8080/auth` |
| `DEN_API_URL` | `http://localhost:4000` | `http://api:4000` |
| `APISIX_ADMIN_URL` | `http://localhost:9180` | `http://apisix:9180` |
| `OPA_PORTAL_URL` | `http://host.docker.internal:4000/api/v1/opa` | `http://api:4000/api/v1/opa` |
| `DEN_TRANSPARENCY_COLLECTOR_HOST` | `host.docker.internal` | `api` |
| `DEN_TSA_URL` | `http://localhost:3004` | `http://tsa:3004` |
| `DEN_STEP_CA_URL` | `https://localhost:9000` | `https://step-ca:9000` |
| `DEN_STEP_CA_ROOT_FILE` | vacío | `/var/lib/den/step-ca/root_ca.crt` |
| `DEN_WEB_URL`, `AUTH_URL` | `http://localhost:3000` | `${DEN_PUBLIC_URL}` |
| `DEN_GATEWAY_PUBLIC_URL` | `https://localhost:9443` | `https://<nombre del gateway>` con mTLS (`--gateway-host`); `${DEN_PUBLIC_URL}/gw` sin mTLS |
| `DEN_CITIZEN_ISSUER` | `http://localhost:8080/realms/den-citizens` | `${DEN_PUBLIC_URL}/auth/realms/den-citizens` |
| `DEN_CITIZEN_APP_URL` | `http://localhost:3100` | `${DEN_PUBLIC_URL}/citizen-app` |
| `DEN_CITIZEN_APPS` (webhook) | `http://localhost:3100/api/den/alerts` | `http://citizen-app:3100/citizen-app/api/den/alerts` |
| `DEN_DEMO_USER_PASSWORD` | `den-demo-password` (12 caracteres o más: la política de contraseñas del realm, M6-01) | aleatoria, salvo `--demo-password` |
| `DEN_DEMO_TOTP_SECRET` | `den-demo-totp-secret` | aleatoria (`pnpm demo:otp` da el código) |
| `DEN_GATEWAY_PORTAL_API_URL` (ruta de control de los nodos) | `http://host.docker.internal:4000` | `http://api:4000` |
| `DEN_NODE_CONTROL_TOKEN` | valor de desarrollo | aleatorio |
| `DEN_WG_HUB_PRIVATE_KEY`, `DEN_WG_HUB_PUBLIC_KEY` | par de desarrollo | par aleatorio |
| `DEN_WG_HUB_ENDPOINT` | `wg-hub:51820` | `<nombre del gateway>:51820` |
| `MAILPIT_UI_AUTH`, `TRAEFIK_NETWORK`, `DEN_PUBLIC_URL` | — | solo piloto |

El API usa `KEYCLOAK_URL` para validar los tokens y para el Admin API de `den-gateway`: en el piloto llega a Keycloak por la URL pública, a través del proxy.

**Actualizar una instalación existente: la app ciudadana de referencia cambió de nombre.** Usaba un nombre propio de un país. En un `.env` existente, renombra `DEN_CARPETA_URL` a `DEN_CITIZEN_APP_URL` (su ruta pasa de `/carpeta` a `/citizen-app`) y `DEN_CARPETA_CLIENT_SECRET` a `DEN_CITIZEN_APP_CLIENT_SECRET`, y reemplaza el client id `carpeta-ciudadana` por `citizen-app` en `DEN_CITIZEN_CLIENTS` y `DEN_CITIZEN_APPS`, cuya URL de webhook pasa a `http://citizen-app:3100/citizen-app/api/den/alerts`. Keycloak importa un realm solo si no existe: en un realm `den-citizens` existente, renombra el cliente a mano en la consola de administración (Client ID y URIs de redirección). En Compose, el servicio, su alias y su volumen ahora son `citizen-app`, `den-citizen-app` y `citizen-app-data`: copia `alerts.json` del volumen anterior `carpeta-data` si importan las suscripciones a avisos de la demo. `sudo ./install.sh update` vuelve a generar las rutas del proxy.

## 5. Piloto en una máquina

La forma recomendada de instalar el piloto es `sudo ./install.sh` ([`INSTALL.md`](INSTALL.md)): hace las preguntas, escribe `.env` con `make-deploy-env.mjs`, pone el proxy y arranca todo. Esta sección describe lo que hay debajo, para quien lo hace a mano o tiene su propio proxy.

**Proxy incluido (`docker-compose.edge.yml`).** Para un servidor sin proxy propio: Traefik en 80 y 443 con las rutas de §5.2, generadas por `install.sh` desde `infra/edge/den.yml.template` en `infra/edge/dynamic/den.yml`. Termina HTTPS en el nombre del portal (Let's Encrypt, o un certificado propio en `infra/edge/certs/`) y pasa el TLS del nombre del gateway intacto a APISIX. En la red `den-edge` toma los dos nombres públicos como alias (`DEN_PORTAL_HOST`, `DEN_GATEWAY_HOST`), así el API y la web llegan a Keycloak por la URL pública sin salir del servidor. No lleva log de accesos.

### 5.1 Qué hace el override `docker-compose.deploy.yml`

- Quita todos los puertos publicados (`ports: !reset []`) y pone `restart: unless-stopped`.
- Agrega `api`, `web` y `citizen-app` como contenedores. El API aplica migraciones y el seed al arrancar (`DEN_ALLOW_SEED=true`) y envía correo a `smtp://mailpit:1025`.
- Une al proxy, por la red externa `${TRAEFIK_NETWORK}` (por defecto `lab-router_default`), solo los servicios que se publican, con alias fijos: `den-portal-web`, `den-portal-api`, `den-keycloak`, `den-apisix`, `den-mailpit`, `den-citizen-app`, `den-tsa`.
- Keycloak con `start_period` de 300 s: en una máquina compartida tarda minutos en arrancar.

### 5.2 Rutas del proxy inverso (un solo nombre público)

| Ruta pública | Destino | Prefijo |
| :-- | :-- | :-- |
| `/` | `den-portal-web:3000` | se conserva |
| `/api/v1` | `den-portal-api:4000` | se conserva; **excepto** `/api/v1/internal` y `/api/v1/opa`, que no se publican |
| `/auth` | `den-keycloak:8080` | se conserva (`KC_HTTP_RELATIVE_PATH=/auth`) |
| `/gw` | `den-apisix:9080` | **se quita** `/gw` |
| `/mail` | `den-mailpit:8025` | se conserva (`MP_WEBROOT=/mail`) |
| `/citizen-app` | `den-citizen-app:3100` | se conserva (ruta base de `DEN_CITIZEN_APP_URL`) |
| `/tsa/api/v1/timestamp/certchain` | `den-tsa:3004` | **se quita** `/tsa`; nada más de la TSA se publica |

`/api/auth/*` (Auth.js) es de la web: por eso la regla del API es `/api/v1`, no `/api`.

Ejemplo para Traefik (proveedor de archivo). No está en el repo; ajústalo a tu proxy y a tu resolutor de certificados:

```yaml
http:
  middlewares:
    den-strip-gw: { stripPrefix: { prefixes: ['/gw'] } }
    den-strip-tsa: { stripPrefix: { prefixes: ['/tsa'] } }
  routers:
    den-web:     { rule: 'Host(`portal.example.org`)', service: den-web, tls: { certResolver: le } }
    den-api:     { rule: 'Host(`portal.example.org`) && PathPrefix(`/api/v1`) && !PathPrefix(`/api/v1/internal`) && !PathPrefix(`/api/v1/opa`)', service: den-api, tls: { certResolver: le } }
    den-auth:    { rule: 'Host(`portal.example.org`) && PathPrefix(`/auth`)', service: den-keycloak, tls: { certResolver: le } }
    den-gw:      { rule: 'Host(`portal.example.org`) && PathPrefix(`/gw`)', service: den-apisix, middlewares: [den-strip-gw], tls: { certResolver: le } }
    den-mail:    { rule: 'Host(`portal.example.org`) && PathPrefix(`/mail`)', service: den-mailpit, tls: { certResolver: le } }
    den-citizen-app: { rule: 'Host(`portal.example.org`) && PathPrefix(`/citizen-app`)', service: den-citizen-app, tls: { certResolver: le } }
    den-tsa:     { rule: 'Host(`portal.example.org`) && Path(`/tsa/api/v1/timestamp/certchain`)', service: den-tsa, middlewares: [den-strip-tsa], tls: { certResolver: le } }
  services:
    den-web:      { loadBalancer: { servers: [{ url: 'http://den-portal-web:3000' }] } }
    den-api:      { loadBalancer: { servers: [{ url: 'http://den-portal-api:4000' }] } }
    den-keycloak: { loadBalancer: { servers: [{ url: 'http://den-keycloak:8080' }] } }
    den-apisix:   { loadBalancer: { servers: [{ url: 'http://den-apisix:9080' }] } }
    den-mailpit:  { loadBalancer: { servers: [{ url: 'http://den-mailpit:8025' }] } }
    den-citizen-app:  { loadBalancer: { servers: [{ url: 'http://den-citizen-app:3100' }] } }
    den-tsa:      { loadBalancer: { servers: [{ url: 'http://den-tsa:3004' }] } }
```

Traefik da más prioridad a la regla más larga, así que `/api/v1`, `/auth`, etc. ganan sobre `/`.

**El espejo del kit (P-03)** no necesita una ruta propia: `/kit/<versión>/<archivo>` es una ruta de páginas de la web (`/`), que lo transmite desde el API, y también lo es la subida del operador (`/files/kit-releases/<versión>/bundle`). El proxy debe aceptar cuerpos de petición tan grandes como el paquete (decenas de MB): Traefik no tiene límite por defecto; otro proxy (`client_max_body_size` de nginx) debe permitir `DEN_KIT_BUNDLE_MAX_BYTES`.

**mTLS (M3-10, `features.mtls.required`).** El TLS del gateway debe terminar en APISIX (SPIKE S-3): detrás de un proxy que termina TLS, `/gw` no puede pasar el certificado del cliente. Hacen falta tres cosas:

1. **Un nombre propio para el gateway**, por ejemplo `gw.example.org`, con paso directo TLS hacia el 9443 de APISIX. APISIX presenta allí su certificado de servidor, emitido por step-ca para `DEN_GATEWAY_TLS_HOSTS`. En `.env`: `DEN_GATEWAY_PUBLIC_URL=https://gw.example.org` y `DEN_GATEWAY_TLS_HOSTS=gw.example.org` (`make-deploy-env.mjs --gateway-host gw.example.org`). Las aplicaciones piden ahí también su token: `https://gw.example.org/oauth/token`.
2. **Que `/auth` borre `SSL_CLIENT_CERT` y `ssl-client-verify`** antes de llegar a Keycloak. Keycloak cree en esas cabeceras (S-4), y solo la ruta de token del gateway puede ponerlas (ADR-0022).
3. Que el puerto 9443 de APISIX esté en la red del proxy. Ya lo está, por el alias `den-apisix`.

```yaml
tcp:
  routers:
    den-gateway-mtls:
      rule: 'HostSNI(`gw.example.org`)'
      service: den-apisix-tls
      tls: { passthrough: true }
  services:
    den-apisix-tls: { loadBalancer: { servers: [{ address: 'den-apisix:9443' }] } }
http:
  middlewares:
    den-no-client-cert-headers:
      headers: { customRequestHeaders: { SSL_CLIENT_CERT: '', ssl-client-verify: '' } }
  routers:
    den-auth: { rule: 'Host(`portal.example.org`) && PathPrefix(`/auth`)', service: den-keycloak, middlewares: [den-no-client-cert-headers], tls: { certResolver: le } }
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
# 1. Respaldo si la versión trae migraciones (OPERATIONS.md §6): sudo ./install.sh backup
# 2. Código nuevo
git pull --ff-only
# 3. Reconstruir y reiniciar (todo, o solo los servicios que cambiaron)
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml \
  --env-file .env --profile observability up -d --build [api web citizen-app]
```

- Las migraciones se aplican solas al arrancar el API.
- Revisa en las notas de la historia (`BACKLOG.md`) si la versión pide pasos manuales: cambios de realm de Keycloak (no se reimportan, §3.3), variables nuevas en `.env` (`make-deploy-env.mjs` no edita un `.env` existente) o volúmenes nuevos.
- **Al pasar a M3 (M3-01 a M3-04)**, sobre un piloto anterior:
  1. Agregar a `.env`: `DEN_STEP_CA_URL=https://step-ca:9000`, `DEN_STEP_CA_PROVISIONER_PASSWORD` (= `STEP_CA_PASSWORD`), `DEN_STEP_CA_ROOT_FILE=/var/lib/den/step-ca/root_ca.crt` y, si cambian sus valores por defecto, `DEN_GATEWAY_TLS_HOSTS` y `DEN_GATEWAY_CLIENT_NAME`.
  2. Recrear `step-ca` (crea el provisioner `den-gateway-tls`) y `apisix` (carga `den-client-cert`) antes que el API.
  3. Aplicar la política de rotación al realm existente: `node scripts/keycloak-client-policies.mjs` con `KEYCLOAK_URL` y el administrador de `master` (`OPERATIONS.md §5.3`).
  4. **M3-08 (segundo factor).** Agregar a `.env` un `DEN_DEMO_TOTP_SECRET` aleatorio, por ejemplo con `openssl rand -hex 20`. Luego aplicar el flujo y los códigos de demo al realm existente: `node scripts/keycloak-portal-mfa.mjs --demo-otp`. Hazlo antes de arrancar el API nuevo: desde ese momento, los usuarios con rol crítico necesitan el código.
  5. **M3-10 (mTLS).**
     - DNS del nombre del gateway hacia la máquina.
     - Router TCP con paso directo y middleware en `/auth`, como en el ejemplo de §5.2.
     - En `.env`: `DEN_GATEWAY_PUBLIC_URL=https://<nombre>` y `DEN_GATEWAY_TLS_HOSTS=<nombre>`.
     - Recrear `keycloak` (arranca con el proveedor x509 `nginx`), luego `apisix` y el API. El API reemite el certificado de servidor del gateway para el nombre nuevo, agrega `client.ca` al objeto SSL, crea la ruta `den-oauth-token` y liga los tokens de cada aplicación al certificado.
     - Desde ese momento, una aplicación sin certificado vigente no puede llamar: cada desarrollador emite el suyo desde la ficha de su aplicación (M3-01).
  6. Con M3-05, durante los primeros 10–20 s tras arrancar el API nuevo, las llamadas permitidas pueden dar 500: las rutas ya llevan `limit-count` y OPA todavía tiene el bundle anterior, sin `X-DEN-Rate-Limit`. Se corrige solo con la siguiente descarga del bundle. Si no se tolera, hacer la actualización en una ventana de mantenimiento.
- **Al pasar a M6-06 (respaldos con pgBackRest)**, sobre un piloto anterior: agregar a `.env` `PGBACKREST_REPO1_CIPHER_PASS` (32 caracteres al azar) y guardar una copia fuera del servidor. `install.sh` lo hace solo si falta, al instalar o actualizar. Si la actualización la corre el `install.sh` anterior, Compose se detiene pidiendo la variable: basta volver a ejecutar `sudo ./install.sh update`. Al arrancar, PostgreSQL se reinicia con el archivado activo y `pgbackrest` toma el primer respaldo completo.
- **P-08 (enlace de verificación y usuarios de demo)**, sobre cualquier piloto anterior: `sudo ./install.sh update` aplica el enlace de 60 minutos al realm existente (`install.sh realms`; con `docker compose` a mano, `node scripts/keycloak-portal-mfa.mjs`, `OPERATIONS.md §5.3`). Los usuarios de demo siguen como están hasta que el operador corre `sudo ./install.sh demo-users disable` (`OPERATIONS.md §2.3`).
- **P-06 (carpeta de documentos)**, sobre cualquier despliegue anterior: `.env` traía `DEN_DOCUMENTS_DIR=data/documents` y toda subida fallaba. El overlay de despliegue fija ahora `/var/lib/den/documents` para el API e `install.sh update` corrige `.env`; con `docker compose` a mano, cambiar la línea en `.env` y recrear el API. No se guardó nada, así que no hay nada que mover.
- **R-02 (credenciales en el plano de control del gateway, ADR-0031)**, sobre cualquier piloto anterior: `sudo ./install.sh update` agrega a `.env` `DEN_OPA_DECISION_TOKEN`, `DEN_OPA_ADMIN_TOKEN`, `ETCD_ROOT_PASSWORD` y `APISIX_ETCD_PASSWORD`. Si la actualización la corre el `install.sh` anterior, Compose se detiene y pide una de ellas: basta correr otra vez `sudo ./install.sh update` (o `sudo ./install.sh start`). En el `up`, `etcd-init` activa la autenticación de etcd (los datos se quedan) y se recrean OPA, APISIX, los Fluent Bit y OpenSearch (banderas y redes nuevas). Hasta que el API nuevo reescribe las rutas con el token de decisión (su pasada completa al arrancar), el gateway responde 503. Con `docker compose` a secas, agrega las cuatro variables a mano (32 caracteres al azar cada una, p. ej. `openssl rand -hex 32`).
- Un cambio en `infra/apisix/config.yaml`, `infra/opa/config.yaml`, `infra/fluent-bit/*` o `infra/step-ca/*` se monta desde el repo: basta reiniciar ese servicio (`up -d <servicio>` o `restart <servicio>`).

## 6. Desarrollo local

```bash
cp .env.example .env
pnpm install
pnpm infra:up            # o infra:up:core (sin OpenSearch ni el Fluent Bit de analítica)
pnpm db:migrate && pnpm db:seed
pnpm dev                 # web 3000 + api 4000 + app ciudadana 3100
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
| Integración del API | `docker compose up -d --wait postgres etcd apisix tsa step-ca` y `pnpm --filter @den/api test:integration`; luego `test:dist` sobre el build |
| Políticas OPA | `opa check --strict`, `opa test`, cobertura ≥ 90 % |

`.github/workflows/pages.yml` publica las guías HTML en GitHub Pages (https://centre-for-dpi.github.io/data-exchange-admin-portal/) cuando cambian. `scripts/docs-site.sh` arma el sitio: envuelve cada guía en un documento completo con su idioma y agrega la portada `docs/site/index.html`. En la configuración del repositorio, Pages debe estar puesto para desplegar desde GitHub Actions.

## 8. Límites del piloto frente a producción

| Tema | Piloto (hoy) | Producción (objetivo, `ARCHITECTURE.md §11`) |
| :-- | :-- | :-- |
| Datos iniciales | Siempre carga el seed: entidades ficticias y usuarios de demo, incluidos administradores de plataforma, hasta que el operador los desactiva (`install.sh demo-users disable`, `OPERATIONS.md §2.3`) | Sin datos de demo. El primer `platform_admin` sale de `DEN_BOOTSTRAP_ADMIN_EMAIL` (§9.3) |
| Keycloak | `start-dev`, misma instancia de PostgreSQL | Clúster en modo producción, base propia |
| CA | CA de desarrollo en un volumen | Raíz fuera de línea, intermedia en HSM |
| TSA | sigstore con clave en archivo | TSA acreditada del país |
| etcd | Un nodo, sin TLS | Clúster de 3 con mTLS |
| OpenSearch | Sin seguridad, sin retención | Plugin de seguridad, política de retención |
| Correo | Mailpit | SMTP del operador |
| Secretos | `.env` en disco | Gestor de secretos (OpenBao) |
| Alta disponibilidad | Ninguna | ≥ 2 nodos de APISIX con OPA local, ≥ 2 réplicas de web y API, PostgreSQL con réplica |
| Métricas y alertas | Prometheus, Alertmanager y Grafana con el perfil `observability` (§3.8.1); las alertas van a Mailpit | Los mismos como subcharts de `den-platform`, con el SMTP del operador |
| Respaldos | pgBackRest: WAL continuo y respaldos diarios en un repositorio cifrado del mismo servidor; la copia fuera de él es manual (`install.sh backup`) | Barman Cloud al almacenamiento de objetos del operador (M6-06) |
| mTLS de aplicaciones | Obligatorio, como en producción (`features.mtls.required: true` en `co.yaml` desde M3-10) | Obligatorio |

## 9. Kubernetes: charts de Helm (M6-05, en curso)

> **Estado (2026-11-16).** Los charts están completos y validados de forma estática: `helm lint`, más `helm template` y kubeconform estricto contra Kubernetes 1.31 (116 recursos válidos). Las imágenes se construyeron y escanearon en local, sin hallazgos altos ni críticos. **Todavía no se instalaron en ningún clúster.** `pnpm helm:kind` lo hará en kind cuando se decida, y es de esperar que haya ajustes en esa primera instalación.

### 9.1 Los dos charts

| Chart | Qué instala | Cuándo |
| :-- | :-- | :-- |
| `infra/helm/den-platform` | Los operadores del clúster: CloudNativePG 0.29.1 (PostgreSQL con réplicas) con su plugin Barman Cloud 0.8.1 (respaldos, M6-06), External Secrets 2.14.0 (secretos desde OpenBao u otro almacén) y cert-manager v1.21.3 | Una vez por clúster, antes de `den`, en el namespace `den-platform` |
| `infra/helm/den` | Todo DEN: web y API, el gateway (APISIX con su OPA y los Fluent Bit de transparencia y de errores en cada pod), etcd con mTLS, Keycloak, las dos bases de datos, step-ca, el hub de nodos, el runner de contrato, el pipeline de acceso, OpenSearch con su plugin de seguridad, Prometheus con Alertmanager, Grafana, la PKI interna (cert-manager) y las NetworkPolicies de entrada y de salida | Un `helm install` |

Son dos porque Helm no puede crear un operador y sus recursos en la misma instalación: los recursos (un `Cluster` de base de datos, un `ExternalSecret`) llegan al webhook del operador antes de que este responda.

**Prerrequisitos del clúster:**
- **Traefik como ingress**: `ingress.className`. ingress-nginx está retirado. Con otro controlador, este debe quitar `SSL_CLIENT_CERT` y `ssl-client-verify` de toda petición al host público.
- **Una StorageClass con `ReadWriteMany`** para los documentos subidos (`api.documents`). Las demás piezas usan `ReadWriteOnce`.
- **Un balanceador de red (`LoadBalancer`)** para el gateway, que termina el mTLS de las aplicaciones (no pasa por el ingress), y para el UDP del hub de nodos.
- **OpenBao** (o cualquier almacén de External Secrets) con un `ClusterSecretStore`: `secrets.externalSecrets.secretStoreRef`.
- **Un almacenamiento de objetos S3-compatible fuera del clúster** para los respaldos de las bases (`postgres.backup`): un bucket propio, con cifrado, y una clave de acceso que solo escriba en él.
- **Un colector de logs del clúster** (un DaemonSet de Fluent Bit, Vector u otro) que lleve la salida de los contenedores al sistema central del operador. Ahí llegan los logs del API, en JSON enmascarado (`ARCHITECTURE.md §8`), y el error log enmascarado del gateway. El chart no lo instala: es de la plataforma, como para cualquier otra carga.
- **Un CNI que aplique NetworkPolicies** (Calico, Cilium). Sin él, las políticas del chart no tienen efecto.

### 9.2 Secretos

Cada componente tiene su Secret `den-<componente>`, solo con las claves que usa. Con `secrets.mode: externalSecrets`, todas son propiedades de una sola entrada del almacén (`secrets.externalSecrets.remoteKey`, por omisión `den/platform`). External Secrets arma los Secrets y además deriva las URL de conexión y los Secrets `basic-auth` de CloudNativePG a partir de las contraseñas, para que nunca se guarde un mismo valor dos veces. Con `secrets.mode: existing`, el operador crea esos Secrets con esos nombres. La lista exacta de claves está en `templates/_helpers.tpl` (`den.secrets`), y son las mismas de `.env.example`, salvo:
- `DB_OWNER_PASSWORD` y `DB_APP_PASSWORD`, de las que se derivan `DATABASE_MIGRATION_URL` y `DATABASE_URL`;
- `KEYCLOAK_SMTP_USER` y `KEYCLOAK_SMTP_PASSWORD`, para el correo del realm;
- `ALERTMANAGER_SMTP_PASSWORD`, la del servidor de correo de las alertas (`prometheus.alertmanager.config.global`);
- `DB_BACKUP_ACCESS_KEY_ID` y `DB_BACKUP_SECRET_ACCESS_KEY`, la clave de acceso al almacenamiento de los respaldos;
- `DEN_SECRETS_KEYS_PREVIOUS`, vacía salvo mientras se rota `DEN_SECRETS_KEY` (`OPERATIONS.md §5.6`);
- `OPENSEARCH_INTERNAL_USERS_YML`, el `internal_users.yml` del plugin de seguridad de OpenSearch con tres usuarios: `admin`, `den-logs` (Fluent Bit: `OPENSEARCH_USER` y `OPENSEARCH_PASSWORD`) y `den-api` (el portal: `DEN_OPENSEARCH_AUTH`, `usuario:contraseña`). Lleva solo los hashes bcrypt, hechos con `plugins/opensearch-security/tools/hash.sh` de la imagen de OpenSearch. El índice de seguridad se crea desde él en el primer arranque; cambios posteriores van con `securityadmin.sh` y el certificado `den-opensearch-admin`.

`GRAFANA_ADMIN_PASSWORD` es la de `.env.example`; el usuario es `admin`.

Las URL de conexión usan `sslmode=verify-full` con el certificado de la CA de cada base de datos. Nunca se monta su clave.

**Rotación.** Se cambia el valor en el almacén y External Secrets actualiza el Secret dentro de `refreshInterval`. Los pods leen sus secretos al arrancar: hay que reiniciarlos (`kubectl rollout restart`) o dejar que lo haga Reloader. El orden de cada rotación es el de OPERATIONS §5.6.

### 9.3 Primera instalación

0. **`den-platform`.** Si trae cert-manager (lo normal), la primera vez se instala con `--set plugin-barman-cloud.enabled=false` y enseguida se actualiza sin esa opción: el plugin de respaldos emite sus certificados con cert-manager, que debe estar corriendo antes. Si el clúster ya tiene cert-manager (`cert-manager.enabled=false`), basta una instalación.
1. **La CA de la red.** La raíz se crea fuera del clúster, fuera de línea. El Secret `stepCa.pkiSecret` lleva `root_ca.crt`, `intermediate_ca.crt` e `intermediate_ca_key` (cifrada con `DEN_STEP_CA_PROVISIONER_PASSWORD`). `stepCa.rootFingerprint` es la huella de la raíz, que el API fija. En cada arranque, step-ca toma la raíz y la intermedia del Secret; en el primero, además, escribe su `ca.json` y los tres provisioners del portal, como `infra/step-ca/configure.sh`. Rotar la intermedia es reemplazarla en el Secret y reiniciar (`RUNBOOK.md §3.2`).
2. **Keycloak.** Importa los realms de producción: los de desarrollo sin sus personas (`pnpm helm:sync` solo deja las cuentas de servicio de los clientes) y con el SMTP de `keycloak.smtp`. Arranca con un administrador temporal (`keycloak.bootstrapAdmin`), que se reemplaza por uno propio con segundo factor.
3. **El primer `platform_admin`.** Producción no tiene seed. `api.bootstrapAdminEmail` (`DEN_BOOTSTRAP_ADMIN_EMAIL`) le da el rol a quien entra primero con esa dirección, verificada por Keycloak, mientras la red no tiene ninguno. Queda auditado. Después se borra el valor, y el resto de los roles de plataforma se da, auditado, con `node dist/admin/platform-roles-cli.js grant <correo> <rol>` en el contenedor del API (`OPERATIONS.md §2`).
4. **Migraciones.** Corren en un contenedor de inicio del API con las credenciales del dueño del esquema, que solo llegan a ese contenedor. Prisma toma un bloqueo, así que dos réplicas no migran a la vez.

### 9.4 Archivos compartidos con Compose

Helm solo lee archivos dentro del chart. `pnpm helm:sync` copia a `infra/helm/den/files/` lo que el chart comparte con Compose:
- los plugins de APISIX;
- los filtros y configuraciones de Fluent Bit;
- las reglas de Prometheus y el tablero de Grafana;
- la configuración de OPA y las plantillas de step-ca;
- los realms, en su forma de producción.

`tests/infra` falla si una copia no coincide con su fuente. Las configuraciones cuyo host cambia en Kubernetes (la de APISIX, la del pipeline de acceso) son plantillas del chart. Si cambia la fuente, se cambia también la plantilla.

### 9.5 Valores que fija cada despliegue

Además de `country`, `publicUrl`, `gatewayHost` y `gatewayPublicUrl`:
- `stepCa.rootFingerprint` y `stepCa.pkiSecret` (§9.3);
- `postgres.backup.destinationPath` (`s3://<bucket>/<ruta>`) y, con un almacenamiento propio del operador, `endpointURL` y `endpointCASecret`. Sin `destinationPath` el chart no se instala; los respaldos solo se desactivan a propósito (`postgres.backup.enabled=false`, como en kind);
- `keycloak.smtp` (servidor y remitente del realm) y `prometheus.alertmanager.config` (servidor, remitente y destinatarios de las alertas);
- con ingress-nginx, `ingress.annotations` con `nginx.ingress.kubernetes.io/proxy-body-size` suficiente para las subidas de PDF y el paquete del kit que el operador sirve desde el portal (P-03; su valor por defecto es 1 MiB). `/kit/<versión>/` va a la web por `/` como cualquier página;
- `antivirus.replicas` (2 por omisión: con el antivirus activado, una subida falla si ClamAV no responde) y sus recursos;
- `grafana."grafana.ini".server.root_url`: `<publicUrl>/grafana/`. Sin él, Grafana redirige a `localhost`;
- `networkPolicy`: el namespace del ingress (`ingressControllerNamespace`), y las redes privadas que el gateway (`gatewayExtraEgressCidrs`: proveedores dentro de la red del operador, un Security Server de X-Road) o el API y Keycloak (`servicesEgressCidrs`: el correo, la TSA) deban alcanzar. Por omisión solo salen a direcciones públicas.

### 9.6 Imágenes

`.github/workflows/images.yml` construye las cuatro imágenes propias del chart: `den-portal-api`, `den-portal-web`, `den-wg-hub` y `den-contract-runner`.
- **SBOM.** Guarda un SBOM CycloneDX de cada una como artefacto de la ejecución, por 90 días.
- **Escaneo.** Las escanea con Trivy (0.76.1, fijado por digest). Una vulnerabilidad alta o crítica con arreglo disponible detiene la publicación. Una excepción aceptada va en `.trivyignore`, con su razón y fecha de vencimiento.
- **Publicación.** Con una etiqueta `vX.Y.Z` publica en `ghcr.io/centre-for-dpi/<imagen>:X.Y.Z` (el `appVersion` del chart), con las atestaciones de SBOM y de procedencia de BuildKit. A mano (`workflow_dispatch`) solo construye y escanea, salvo que se marque `publish`.
- **Acciones fijadas.** Las acciones de terceros están fijadas por commit.

**v0.2.0 (2026-11-19).** Las primeras imágenes `den-*`: `ghcr.io/centre-for-dpi/{den-portal-api,den-portal-web,den-wg-hub,den-contract-runner}:0.2.0`, x86_64, con los seguimientos del piloto P-01 a P-08 (`BACKLOG.md`). Un piloto las usa con `sudo ./install.sh images 0.2.0`, una vez que un dueño de la organización hizo públicos los cuatro paquetes.

**v0.1.0 (2026-11-17).** Primera publicación, desde el repositorio antes de hacerse público y antes del cambio de nombre a DEN (ADR-0028): `ghcr.io/centre-for-dpi/{rid-portal-api,rid-portal-web,rid-wg-hub,rid-contract-runner}:0.1.0`, privadas. Esas imágenes leen las variables `RID_*` antiguas y no funcionan con este código; todavía no hay imágenes `den-*`. La próxima versión las publica desde este repositorio, y un dueño de la organización hace público cada paquete (configuración del paquete → Change visibility) para que clústeres y pilotos las bajen sin credenciales.

Las imágenes del API y de la web son de varias etapas. La de ejecución lleva solo las dependencias de producción (`pnpm deploy --prod`) y los archivos del repositorio que lee el proceso: la configuración del país y, en el API, las políticas de OPA y el realm del seed del piloto. No lleva gestor de paquetes. El contenedor de migraciones corre `node_modules/.bin/prisma migrate deploy`.

### 9.7 Pendiente en M6-05

- **Instalar** en kind (`pnpm helm:kind`) y luego en el entorno tipo producción del operador. El chart nunca se ha instalado.

## 10. Un país nuevo (M6-09)

El código no cambia de un país a otro (regla 6 de CLAUDE.md). Lo propio de cada país está en:

| Qué | Dónde |
| :-- | :-- |
| Nombre, idioma de fechas y números, zona horaria, autoridades, marco legal, tipos de documento, sectores, finalidades, reglas (`features`), plazos, retención, plantilla de acuerdo y marca | `config/country/<código>.yaml`, copiado de `config/country/example.yaml`. El esquema (`packages/config/src/schema.ts`) rechaza claves desconocidas y valores inválidos, y el API no arranca con un archivo inválido |
| Textos de la interfaz | `apps/web/messages/es.json` y `en.json`: completos en los dos idiomas. Los textos del país en el YAML aceptan uno o los dos idiomas |
| Identidad ciudadana | El realm del país reemplaza a `den-citizens`. Su token trae el tipo y el número de documento en los claims de `DEN_CITIZEN_DOCUMENT_TYPE_CLAIM` y `DEN_CITIZEN_DOCUMENT_NUMBER_CLAIM`, con los tipos de `identifiers.person` y cada número en la forma canónica de su tipo (`identifiers.personNumberFormat`, ADR-0030; antes se quitan separadores y mayúsculas), o el API de ciudadanos rechaza el token |
| Selección del país | `DEN_COUNTRY=<código>` (y `DEN_CONFIG_DIR` si los archivos no están en `config/country`), en el API y en la web |

**Idioma por omisión.** La web abre en español y sirve el inglés bajo `/en` (regla 7 de CLAUDE.md). Para un país cuyo idioma principal es el inglés, el idioma por omisión es `defaultLocale` en `apps/web/src/i18n/routing.ts`: cambiarlo cambia también las URL de cierre de sesión que el realm acepta (`post.logout.redirect.uris`).

**Prueba:** `pnpm example:country` (`scripts/example-country.mjs`):
1. Convierte `example.yaml` en el país XX.
2. Levanta un stack propio: el proyecto Compose `denxx`, con todos los puertos desplazados en 10000 y sus volúmenes. El de desarrollo no se toca.
3. Arranca el portal con ese país.
4. Comprueba la web en los dos idiomas con la marca del país.
5. Corre la demo de `DEMO.md` de punta a punta, con el sector, las finalidades y el tipo de documento de XX.
6. Borra lo que creó (`--keep` lo conserva para mirar).

La demo (`pnpm demo`) toma esos datos de la configuración del país, así que también sirve para el despliegue de cualquier país.
