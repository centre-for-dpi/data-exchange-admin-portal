# Deployment — DEN Portal

> Versión en español: [docs/es/DEPLOYMENT.md](es/DEPLOYMENT.md)

Version 0.3 · November 2026 · code as of M6: all of it except the load test (M6-03) and the cluster installation (M6-05), which need the operator's production-like environment

This document describes **how each component** of the portal and the gateway **is deployed**: image, configuration, ports, volumes, secrets and dependencies. How to bring it into service and how to run it day to day is in [`OPERATIONS.md`](OPERATIONS.md). The reference architecture is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

> **Scope (ADR-0011).** Only the portal + the gateway are deployed here. The instant API kit that is installed at the entities is a separate product, with its own repository. `mock-salud`, `mock-socioeconomico` and the citizen app (`citizen-app`) are test and demo props.

## 1. Topologies

| Topology | Files | Status | Use |
| :-- | :-- | :-- | :-- |
| **Local development** | `infra/compose/docker-compose.yml`; web and API on the host with `pnpm dev` | Available | Coding and testing |
| **Single-machine pilot** | `docker-compose.yml` + `docker-compose.deploy.yml`, behind an existing reverse proxy or the bundled one (`docker-compose.edge.yml`) | Available; **interactive installer `install.sh`** ([`INSTALL.md`](INSTALL.md)) | Demos, pilots and bootcamp |
| **Production** | Helm charts (`infra/helm/`) with the topology of `ARCHITECTURE.md §11` | Written and statically validated; **not installed in a cluster yet** (M6-05, §9) | National operator |

The pilot is not a production deployment. Its known limits are in §8.

## 2. Requirements

| Requirement | Version | What for |
| :-- | :-- | :-- |
| Docker Engine with Compose v2 | Compose ≥ 2.26 | `!reset` on ports and the `subpath` mount of the step-ca volume (pilot) |
| Node.js | ≥ 24 (`engines` in `package.json`) | Development, `scripts/make-deploy-env.mjs` |
| pnpm | 11.15.0 (`packageManager`) | Development |
| Host `vm.max_map_count` | ≥ 262144 | OpenSearch (`observability` profile) |
| Memory | OpenSearch starts with `-Xms512m -Xmx512m`; Keycloak, APISIX and the Next.js builds add up to several GB | — |

On Linux, for OpenSearch:

```bash
echo 'vm.max_map_count=262144' | sudo tee /etc/sysctl.d/99-den-opensearch.conf
sudo sysctl --system
```

## 3. Components

All services are in `infra/compose/docker-compose.yml` (Compose project `den`). In development, each published port binds only to `127.0.0.1` and can be moved with its `*_PORT` variable in `.env`. In the pilot no port is published (§5).

The components fall into two planes (`ARCHITECTURE.md §1`):

- **Governance plane:** PostgreSQL, Keycloak, step-ca, the TSA, the API and the web. They decide who may do what and translate it into configuration.
- **Data plane:** etcd, APISIX, OPA and the Fluent Bit instances. They serve and record every call between entities. They keep working even if the governance plane goes down.

Each subsection starts with the component's **role** in the deployment and continues with its configuration.

### 3.1 Summary

| Service | Image | Internal port | Dev port (host) | Volume | Profile | Health check |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| `postgres` | `den/postgres` (`postgres:18.6-alpine` with pgBackRest, `infra/postgres`) | 5432 | `POSTGRES_PORT` 5432 | `pg-data`; in the pilot also `pgbackrest-repo` and `pg-socket` | base | `pg_isready` |
| `pgbackrest` | `den/postgres` | — (no network) | — | `pg-data`, `pgbackrest-repo`, `pg-socket` | pilot only (M6-06) | none |
| `keycloak` | `quay.io/keycloak/keycloak:26.8.0` | 8080 (HTTP), 9000 (management) | `KEYCLOAK_PORT` 8080 | — (uses `postgres`) | base | `GET /health/ready` on 9000 |
| `etcd` | `quay.io/coreos/etcd:v3.6.16` | 2379 | not published | `etcd-data` | base | `etcdctl endpoint health` |
| `apisix` | `apache/apisix:3.19.0-debian` | 9080 (HTTP), 9443 (HTTPS), 9180 (admin), 7085 (status), 9091 (metrics) | 9080, 9443, 9180 | — (state in etcd) | base | `GET /status/ready` on 7085 |
| `opa` | `openpolicyagent/opa:1.21.4-static` | 8181 | `OPA_PORT` 8181 | `opa-data` (last bundle, M6-04) | base | `GET /health` |
| `step-ca` | `smallstep/step-ca:0.30.2` | 9000 | `STEP_CA_PORT` 9000 | `step-ca-data` | base | `step ca health` |
| `fluent-bit-transparency` | `fluent/fluent-bit:5.1.5-debug` | 5170 (TCP), 2020 (health) | not published | `transparency-buffer` | base | `GET /api/v1/health` on 2020 |
| `fluent-bit-errors` | `fluent/fluent-bit:5.1.5-debug` | 5140/udp (syslog), 2020 (health) | not published | — | base | `GET /api/v1/health` on 2020 |
| `tsa-init` | `smallstep/step-ca:0.30.2` | — (one-off task) | — | `tsa-data` | base | exits with code 0 |
| `tsa` | `ghcr.io/sigstore/timestamp-server:v2.1.4` | 3004 | `DEN_TSA_PORT` 3004 | `tsa-data` (read-only) | base | none (distroless image) |
| `mailpit` | `axllent/mailpit:v1.32.0` | 8025 (UI), 1025 (SMTP) | 8025, 1025 | — | base | `mailpit readyz` |
| `clamav` | `clamav/clamav:1.5.4` | 3310 (clamd) | `CLAMAV_PORT` 3310 | `clamav-data` (signatures) | `antivirus` (M6-08) | `clamdcheck.sh` |
| `mock-salud`, `mock-socioeconomico` | `den/mock-providers:dev` (local build) | 8000 | 8101, 8102 | — | base | `GET /health` |
| `wg-hub` | `den/wg-hub:dev` (local build, `infra/wg-hub`) | 51820/udp (tunnel), 8443 (SNI router), 8090 (agent) | 51820/udp and 8095 (agent) on `127.0.0.1` | `wg-hub-data` | base | `GET /health` on 8090 |
| `contract-runner` | `den/contract-runner:dev` (local build, `infra/contract-runner`) | 8096 | `CONTRACT_RUNNER_PORT` 8096 on `127.0.0.1` | — | base | `GET /health` |
| `mock-node` | `den/mock-node:dev` (local build, `infra/mock-node`) | 8443 on its tunnel address | not published | anonymous | `nodes` | — |
| `opensearch` | `opensearchproject/opensearch:3.9.0` | 9200 | `OPENSEARCH_PORT` 9200 | `opensearch-data` | `observability` | `_cluster/health` yellow |
| `fluent-bit` | `fluent/fluent-bit:5.1.5-debug` | 9880 (HTTP), 2020 | not published | — | `observability` | `GET /api/v1/health` on 2020 |
| `prometheus` | `prom/prometheus:v3.15.1` | 9090 | `PROMETHEUS_PORT` 9090 on `127.0.0.1` | `prometheus-data` | `observability` | `GET /-/ready` |
| `alertmanager` | `prom/alertmanager:v0.34.2` | 9093 | `ALERTMANAGER_PORT` 9093 on `127.0.0.1` | `alertmanager-data` | `observability` | `GET /-/ready` |
| `grafana` | `grafana/grafana:13.3.0` (AGPL, its own container) | 3000 | `GRAFANA_PORT` 3001 on `127.0.0.1` | `grafana-data` | `observability` | `GET /api/health` |
| `api` | `den/portal-api:deploy` (`apps/api/Dockerfile`) | 4000 | — (runs on the host in dev) | `api-documents`, `step-ca-data` (only `certs/`, read-only) | pilot only | `GET /api/v1/health` |
| `web` | `den/portal-web:deploy` (`apps/web/Dockerfile`) | 3000 | — (runs on the host in dev) | — | pilot only | `GET /api/auth/providers` |
| `citizen-app` | `den/mock-citizen-app:deploy` (`infra/mock-citizen-app/Dockerfile`) | 3100 | — (runs on the host in dev) | `citizen-app-data` | pilot only | — |

Prometheus, Alertmanager and Grafana are **not** in the Compose file yet (M5-06).

### 3.2 PostgreSQL

**Role in the deployment.** It is the only source of truth for the governance plane. It stores:

- the domain state: entities, people and roles, APIs and versions, applications, subscriptions and documents;
- the hash-chained audit log, with its anchors;
- the outbox and the background job queues (pg-boss; there is no Redis);
- the transparency log and its sealed batches;
- in a separate database, Keycloak's data.

What is in APISIX, OPA and the Keycloak clients is computed from here, so it can be rebuilt. If PostgreSQL goes down, the portal stops, but the gateway keeps serving with the last configuration.

- A single instance holds the portal database (`POSTGRES_DB`, `den` by default), the test database (`den_test`) and Keycloak's (`keycloak`).
- **Backups (M6-06, ADR-0026).** The image ships pgBackRest. In the pilot, PostgreSQL archives its WAL to the encrypted repository `pgbackrest-repo` (`PGBACKREST_REPO1_CIPHER_PASS`). The `pgbackrest` service takes the scheduled backups: it reaches the database through the socket and the data volume, with no network. Nothing is archived in development. Procedure and restore in `OPERATIONS.md §6`.
- **Init scripts** (`infra/postgres/init`, only with an empty volume):
  - `01-keycloak.sh`: role `KEYCLOAK_DB_USER` and database `keycloak`.
  - `02-app-role.sh`: role `den_app` (no DDL) with password `DEN_APP_DB_PASSWORD`, database `den_test`, and default privileges so that `den_app` can use everything the owner creates.
- **Two portal roles:** the schema owner (`POSTGRES_USER`, `den`) only runs migrations (`DATABASE_MIGRATION_URL`); the API runs as `den_app` (`DATABASE_URL`). The audit and transparency tables are insert-only even for the owner (triggers, `ARCHITECTURE.md §7` and §13).
- **Migrations:** Prisma (`apps/api/prisma/migrations`), with `DATABASE_MIGRATION_URL` (`apps/api/prisma.config.ts`). The pg-boss queue schema is also a migration: the API starts pg-boss without DDL permissions (`migrate: false`).
- The passwords in `.env` are used only **the first time**. Changing them in `.env` once the volume exists does not change the roles: you have to run `ALTER ROLE ... PASSWORD` and update `.env` at the same time.

### 3.3 Keycloak

**Role in the deployment.** It is the identity provider: **it authenticates, it does not authorize**. Roles live in PostgreSQL (ADR-0004). It has three realms, one per type of user:

- **`den-portal`**, for the people who use the portal: the web's OIDC sign-in, self-registration, email verification and password recovery.
- **`den-gateway`**, for consumer applications. It issues the `client_credentials` tokens (5 min, `aud = den-gateway`) that APISIX validates on every call. Its `den-app-<uuid>` clients are created and maintained by the API's reconciler, never by a person.
- **`den-citizens`**, which simulates the country's digital identity for the citizen app. In production it is replaced by the country's issuer (`DEN_CITIZEN_ISSUER`).

If Keycloak goes down, nobody can sign in and applications cannot get new tokens.

- It runs with `start-dev --import-realm` (in the pilot too: the override does not change the command).
- On startup it imports `infra/keycloak/*-realm.json` (`den-portal`, `den-gateway`, `den-citizens`). The secrets are `${VARIABLE}` placeholders resolved from the container's environment: `DEN_PORTAL_WEB_CLIENT_SECRET`, `DEN_GATEWAY_PROVISIONER_SECRET`, `DEN_CITIZEN_APP_CLIENT_SECRET`, `DEN_WEB_URL`, `DEN_CITIZEN_APP_URL`, `DEN_DEMO_USER_PASSWORD`, `DEN_DEMO_TOTP_SECRET`.
- **The import does not update a realm that already exists** (`IGNORE_EXISTING`). A change in the JSON files, in those secrets or in the URLs does not reach an already initialized Keycloak: apply it with `kcadm.sh` (see `OPERATIONS.md §5.3`) or by deleting Keycloak's database.
- Token issuer: in development `KC_HOSTNAME=http://localhost:${KEYCLOAK_PORT}`; in the pilot `${DEN_PUBLIC_URL}/auth` with `KC_HTTP_RELATIVE_PATH=/auth` and `KC_PROXY_HEADERS=xforwarded`. `KC_HOSTNAME_BACKCHANNEL_DYNAMIC` lets the containers (APISIX) reach it by service name.
- Initial administrator: `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` (`KC_BOOTSTRAP_ADMIN_*`).
- **Client policy `den-secret-rotation`** in `den-gateway` (M3-04): on clients with the attribute `den.managed = true`, the ones the portal creates, regenerating the secret keeps the previous one as a rotated secret for the rotation window (30 days at most). It ships with the realm on a new installation; on a Keycloak that has already imported the realm, apply it with `node scripts/keycloak-client-policies.mjs` (`OPERATIONS.md §5.3`). Without it, rotating a secret stops accepting the previous one as soon as the reconciler applies the new one.
- **Second factor (M3-08, ADR-0021)** in `den-portal`. The `den-browser` flow asks for the password and, when the web sends `acr_values=mfa`, a TOTP code. The API requires that level for platform roles and for `data_steward`.
  - It ships with the realm on a new installation. On a Keycloak that has already imported the realm, apply it with `node scripts/keycloak-portal-mfa.mjs` (`OPERATIONS.md §5.3`).
  - Without the flow, Keycloak cannot issue `acr=mfa`, and those roles get 403 `mfa_required` across the whole portal.
  - The seed users with a critical role come with the code from `DEN_DEMO_TOTP_SECRET`. In production there are no seed users: each person enrolls their app the first time.
- **Application client certificate (M3-10, ADR-0022).** It starts with the `nginx` x509 provider and `trust-proxy-verification` (`--spi-x509cert-lookup--…`, in the compose file): it reads from `SSL_CLIENT_CERT` the certificate that APISIX has already verified on the gateway's token route. That is why no other path to Keycloak may let that header, or `ssl-client-verify`, through (§5.2).
- Details of the three realms and the seed users: `infra/keycloak/README.md`.

### 3.4 etcd + APISIX

**Role of etcd in the deployment.** It stores the gateway's configuration: routes, upstreams, plugins and SSL objects. The API's reconciler writes it through APISIX's Admin API, and each APISIX node reads it and applies the changes as soon as they happen, without restarting. It is not a source of truth: if it is lost, the API rebuilds it from PostgreSQL.

**Role of APISIX in the deployment.** It is the **gateway**, the heart of the data plane: every call between entities goes through it. On each request it:

1. validates the `den-gateway` token;
2. removes the `X-DEN-*` headers that only the gateway may set;
3. if the operation declares it, reads the data subject from the body (`den-data-subject` plugin);
4. asks OPA whether the call is allowed;
5. forwards the request to the provider with the traceability headers that OPA returned;
6. sends the call's metadata to the two Fluent Bit instances: analytics and transparency.

It also terminates the gateway's TLS on 9443 with its server certificate and, when `features.mtls.required` is on, requires the application's client certificate there (M3-02). Towards providers with mTLS it presents the gateway's client certificate for that entity (M3-03). It does not store request or response bodies. In the pilot it is published at `/gw`.

- etcd stores APISIX's configuration (prefix `/apisix`). A single node, plain HTTP without TLS, not published.
- APISIX in `traditional` mode with `config_provider: etcd` (`infra/apisix/config.yaml`, mounted read-only). The Admin API key arrives through `APISIX_ADMIN_KEY`.
- The Admin API (9180) accepts only private addresses (`127.0.0.0/24`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) and requires the key. It is never exposed to the public.
- Custom plugins in `infra/apisix/plugins` (mounted at `/usr/local/apisix/den`): `den-data-subject` (ADR-0017), `den-client-cert` (M3-02: passes OPA the RFC 8705 fingerprint of the verified client certificate), `den-rate-limited` (M3-05: the 429 of the per-subscription limit as problem+json) and `den-header-guard` (M3-07: removes every `X-DEN-*` header from the client except the purpose and the official). The plugin list in `config.yaml` is explicit: a new plugin requires restarting APISIX.
- **SSL objects** (created by the reconciler, like the routes):
  - `den-ssl-gateway`: the gateway's server certificate for the names in `DEN_GATEWAY_TLS_HOSTS`, issued by step-ca and renewed by the portal. With `features.mtls.required`, also `client.ca` with the network's CA: without a valid certificate, the handshake fails.
  - `den-ssl-gateway-client-<entityId>`: the client certificate that the gateway presents to the mTLS upstreams of that provider entity, `CN=den-gateway.<slug>` (prefix `DEN_GATEWAY_CLIENT_NAME`). One per provider, so that one entity cannot reach another's mTLS API with the gateway's identity. Each provider must accept only its own name.
- **Upstreams.** `direct` upstreams verify the provider's certificate and point to the addresses that the reconciler resolved and found to be public, with the name as Host and SNI (no DNS rebinding). Nodes over TLS are verified against the network's CA (M3-03).
- In development APISIX reaches the host through `host.docker.internal` (only for the mTLS tests towards upstreams); the pilot override removes it.
- **Privacy:** the nginx access log is disabled and the error log is at `error` level (`ARCHITECTURE.md §8`).
- **Nobody writes routes by hand.** Routes, upstreams and plugins are created by the API's reconciler (ADR-0007). Each route carries `prometheus`, `http-logger` (analytics → `fluent-bit:9880`) and, if any operation declares a data subject, `tcp-logger` (transparency → `fluent-bit-transparency:5170`).
- **Rebuildable state:** if etcd is lost, the full reconciler (every 5 minutes or when the API restarts) recreates everything from PostgreSQL.

### 3.5 OPA

**Role in the deployment.** It decides each call: it allows it or denies it with a stable reason (`no_subscription`, `purpose_not_allowed`…). It decides only with the data in the **bundle** that the portal publishes:

- routes and operations;
- clients and their status, with the fingerprints of their current certificates (M3-02);
- current subscriptions with their operations, purposes and dates;
- the official's salt, the pseudonym key and whether the network requires mTLS (`mtlsRequired`).

It also computes the official's hash and the data subject's pseudonym, and returns the traceability headers that APISIX sends to the provider. It never queries the portal's database online, which is why traffic survives a portal outage. Its status report tells the portal when an approved subscription is already in force at the gateway, and the subscription then moves to `active`.

- Config in `infra/opa/config.yaml`: it downloads the `den` bundle from `${OPA_PORTAL_URL}/bundle.tar.gz` with `Bearer ${OPA_BUNDLE_TOKEN}` every 10–20 s, and reports the active revision to `${OPA_PORTAL_URL}/status`.
- **State: the last bundle, on disk (M6-04).** It lives in the `opa-data` volume (`/var/lib/opa`, `persist: true`), which `opa-init` hands over to uid 1000. An OPA that restarts while the portal is not responding starts with that bundle. Without one it has no policy and the gateway denies everything (fails closed).
  - The bundle carries the pseudonym key and the official's salt: the volume belongs to OPA alone (mode 700) and is backed up or destroyed like a secret.
  - Deleting the volume does no harm as long as the portal responds: OPA downloads the bundle on the next poll.
- *Decision logs* are disabled on purpose (the input carries headers with data in clear text).
- `OPA_PORTAL_URL`: in development `http://host.docker.internal:4000/api/v1/opa` (the API runs on the host); in the pilot `http://api:4000/api/v1/opa`.

### 3.6 step-ca

**Role in the deployment.** It is the network's certificate authority. It signs:

- the client certificates of consumer applications, from the CSRs that entities upload to the portal (M3-01). They are used for mTLS with the gateway and for certificate-bound tokens (RFC 8705) when `features.mtls.required` is on;
- the gateway's TLS server certificate (M3-02);
- the gateway's client certificates towards providers with mTLS, one per entity (M3-03).

It also signs the kit nodes' certificates when they enroll and when they renew (M4-02). Only the API talks to it: entities and nodes never call it directly.

- On first start the image initializes the CA with `DOCKER_STEPCA_INIT_*`: name `DEN Dev CA`, DNS `localhost,step-ca`, JWK provisioner `den-portal`, password `STEP_CA_PASSWORD`. **The pilot uses this same development CA**; the offline root and the HSM-backed intermediate are for production (M6).
- On every start, `infra/step-ca/configure.sh` adjusts the `den-portal` provisioner (template `app.tpl`, client authentication only, 90 days by default, 397 at most). It also creates, if it does not exist, the `den-gateway-tls` provisioner with the CA's password (template `gateway.tpl`, server authentication only, 90 days) and the `den-nodes` provisioner for the kit nodes (template `node.tpl`, server and client authentication, 90 days, M4-02). Then it starts the CA. It is idempotent: an existing CA gets a new provisioner when the container restarts.
- The portal generates the keys for the gateway's certificates and stores them sealed with `DEN_SECRETS_KEY` (table `gateway_certificate`). It renews them in the last third of their lifetime, during the APISIX reconciler's full pass.
- The state (root, intermediate, keys, `secrets/password`) lives in `step-ca-data`. **Losing that volume invalidates every certificate issued.**
- The API signs CSRs with the provisioners (`DEN_STEP_CA_URL`, `DEN_STEP_CA_PROVISIONER`, `DEN_STEP_CA_GATEWAY_PROVISIONER`, `DEN_STEP_CA_PROVISIONER_PASSWORD` = `STEP_CA_PASSWORD` for both) and verifies the CA's TLS with `DEN_STEP_CA_ROOT_FILE` or `DEN_STEP_CA_ROOT_FINGERPRINT`. With `NODE_ENV=production` (pilot images) one of the two is **required**; with neither, in development only, it trusts the root that the CA serves.

### 3.7 Transparency log: Fluent Bit + TSA

**Role of `fluent-bit-transparency` in the deployment.** It carries from the gateway to the portal the record of every **authorized** call that touched a person's data: who queried, for what purpose, under which subscription, and the data subject's pseudonym, never the path or the ID number. It keeps only the allowed fields and discards calls without a pseudonym or that did not reach the provider. With its disk buffer, no records are lost if the API is down. Without this service, citizens cannot see who queried their data (ADR-0015).

**Role of `tsa-init` in the deployment.** It is a task that runs only once: it generates the certificate chain of the development TSA and exits.

**Role of `tsa` in the deployment.** It is the time-stamping authority (RFC 3161), independent of the operator's key. It stamps two things: the checkpoints of the transparency log and the daily anchor of the audit log. With the stamp anyone can prove that the data existed at that moment and was not rewritten afterwards (ADR-0016). Its public chain lets third parties (the citizen app, `den-verify-receipt`) verify the stamps without trusting the portal.

- `fluent-bit-transparency` (`infra/fluent-bit/transparency.yaml`): TCP input 5170 in JSON, Lua filter `transparency.lua`, HTTP output to `${DEN_TRANSPARENCY_COLLECTOR_HOST}:${DEN_TRANSPARENCY_COLLECTOR_PORT}/api/v1/internal/subject-access` with `Bearer ${DEN_TRANSPARENCY_INGEST_TOKEN}`. Disk buffer (`transparency-buffer`, up to 1 GB) and unlimited retries: if the API goes down, the records wait.
- `tsa-init` creates the development TSA's chain once, in `tsa-data` (`infra/tsa/init.sh`). `tsa` is sigstore timestamp-server with that key. In production the country's accredited TSA is used (`DEN_TSA_URL`).
- The TSA chain is public: `GET /api/v1/timestamp/certchain`.

**Role of `fluent-bit-errors` in the deployment (M5-01).** It receives the nginx error log from APISIX over syslog. A real error, for example a provider that does not respond, carries the request line and the upstream URI, with the ID number in the path. This service masks them (`infra/fluent-bit/gateway-errors.lua`) and writes the result to its output: **the operator reads the gateway's errors with `docker logs den-fluent-bit-errors-1`, not in APISIX**. APISIX depends on it to start, because nginx resolves the syslog server's name when it reads its configuration. If this service goes down, errors are lost (UDP) and traffic is not affected.

### 3.8 Analytics: Fluent Bit + OpenSearch (`observability` profile)

**Role of `fluent-bit` in the deployment.** It is the second privacy barrier for the access log. It receives from APISIX's `http-logger` the metadata of **all** calls, including denied ones with their reason. It discards any field outside the allowlist and any value without the shape that the gateway gives it. It converts numbers and latencies and writes the rest to OpenSearch.

**Role of `opensearch` in the deployment.** It stores the access logs for usage analytics: calls per consumer, per purpose and per operation, latencies and denial reasons. The usage screens and the indicators query it (M5-02 to M5-05). It can be left out: without it those screens say that analytics is not available, and traffic, the audit log and the transparency log carry on unchanged.

- `fluent-bit` (`infra/fluent-bit/fluent-bit.yaml`): HTTP input 9880, `allowlist.lua` filter, output to OpenSearch, index `den-access-YYYY.MM`.
- OpenSearch in single-node mode **without the security plugin** (`DISABLE_SECURITY_PLUGIN=true`), only inside the Compose network. The API reaches it at `DEN_OPENSEARCH_URL` (`http://opensearch:9200` in the pilot); with the security plugin, `DEN_OPENSEARCH_AUTH=user:password`.
- The API maintains the `den-access` index template (typed fields, `dynamic: strict`) and the ISM retention policy `den-access-retention` (the country's `retention.accessLogMonths`, plus one month). It does so on startup and every hour, and the state is kept in `sync_state` (`opensearch:*`). You do not need to create them by hand.
- **When deploying M5 on an OpenSearch that already had data:** the earlier `den-access-*` indices have a dynamic mapping (numbers as text) that the template does not change. In the pilot they are deleted: `curl -X DELETE 'http://opensearch:9200/den-access-*'`, from a container on the network. They are demo logs.
- `pnpm infra:up:core` brings everything up without this profile. Routes keep sending to `fluent-bit:9880`; without that service, those logs are lost and traffic is not affected.

### 3.8.1 Metrics and alerts: Prometheus, Alertmanager and Grafana (`observability` profile, M5-06)

**Role of `prometheus` in the deployment.** It collects the metrics of APISIX, the API (`GET /metrics` with `DEN_METRICS_TOKEN`) and OPA, and evaluates the alerts of `ARCHITECTURE.md §9`. It also gives the API the gateway's availability, which is one of the network's indicators. Without it there are no alerts and that indicator shows "no data"; traffic is not affected.

**Role of `alertmanager` in the deployment.** It groups the alerts and emails them to the operator. In development and in the pilot they arrive in Mailpit (`operaciones@den.example`). In production you mount your own `alertmanager.yml` with the operator's SMTP and address.

**Role of `grafana` in the deployment.** It shows the operator's dashboard (`DEN · Operador`), provisioned from `infra/grafana`, with no editing in the UI: changes go through the repository. Its user is `admin`, with `GRAFANA_ADMIN_PASSWORD`. In the pilot it sits behind the proxy at `/grafana` (`GRAFANA_ROOT_URL`, `GRAFANA_SERVE_FROM_SUB_PATH=true`).

- Prometheus does not expand variables in its configuration. Its entrypoint writes `DEN_METRICS_TOKEN` into the file that its `api` job reads (`credentials_file`). In development, `api` points to the API on the host (`extra_hosts`); in the pilot, to the container.
- Metrics retention: `PROMETHEUS_RETENTION` (30 days by default).

### 3.9 Mailpit

**Role in the deployment.** It acts as a test mail server: it captures all outgoing mail without delivering it to anyone and shows it in a web inbox. That includes invitations, portal notifications, the anchors sent to regulators, Keycloak's verification and recovery emails, and the citizen app's alerts. It stands in for the operator's real SMTP.

- It receives all mail in development and in the pilot (SMTP 1025): the API's (`DEN_SMTP_URL`), Keycloak's (verification and recovery) and the citizen app's.
- In the pilot it is served at `/mail` (`MP_WEBROOT`) behind a username and password (`MP_UI_AUTH=${MAILPIT_UI_AUTH}`): Keycloak sends password recovery links there, so an open inbox would allow taking over any account.
- In production it is replaced by the operator's real SMTP (`DEN_SMTP_URL`, `DEN_MAIL_FROM`).

### 3.9.1 Antivirus: ClamAV (`antivirus` profile, M6-08)

**Role in the deployment.** It scans every uploaded document (designations, agreements, annexes) before it is stored (ASVS 5.4.3). It is `clamd` in its own container (GPL-2.0, never linked: rule 1). Its `freshclam` updates the signatures from the internet.

- It is enabled with the `antivirus` profile and `DEN_CLAMAV_URL` in the API (`tcp://clamav:3310` in the pilot; `install.sh` asks for it).
- The API sends it the document over clamd's INSTREAM protocol, after checking that it is a PDF and before writing it:
  - if clamd finds something, the document is not stored and the user sees an error on the field; the API log records the signature and the file's SHA-256, never the name or the content;
  - if clamd does not respond, the upload fails (503) and the document is not stored (fails closed).
- The first start downloads the signatures (a few minutes) and uses ~1.2 GB of memory.
- Without `DEN_CLAMAV_URL` there is no scanning: documents are only checked as PDFs.

### 3.10 Portal API (`apps/api`)

**Role in the deployment.** It is the center of the governance plane, and the only component that writes to APISIX, Keycloak (`den-gateway`) and step-ca. It has two sides:

- **REST (`/api/v1`).** It serves the web and other systems. It applies the publication, request and approval flows. It checks the role and the entity membership on every endpoint and records every change in the audit log.
- **Background jobs.** They translate the PostgreSQL state into configuration: APISIX routes, upstreams and SSL objects, Keycloak clients (with secret rotation) and the OPA bundle. They also sign certificates with step-ca, receive and seal the transparency log (operator signature plus TSA stamp), send emails and webhooks, and expire subscriptions, versions, certificates and credential rotation windows.

It also serves the data subject API that the citizen app consumes.

- Image: `apps/api/Dockerfile`, built from the repo root (`COPY . .`). **The country configuration (`config/country/*.yaml`) is baked into the image**: a change in the YAML requires a rebuild.
- On startup: `prisma migrate deploy` (migrations as owner) → the seed (`dist/seed/main.js`) if `DEN_ALLOW_SEED=true` → `node dist/main.js` on `API_PORT` (4000). If the country configuration is invalid or `DEN_COUNTRY` is missing, it exits with code 1.
- It runs as user `node`. Documents in `/var/lib/den/documents` (`DEN_DOCUMENTS_DIR`, volume `api-documents`).
- **Background jobs in the same process** (`OPERATIONS.md §3`). `DEN_WORKER=off` starts the API without them (tests, read-only replicas).
- It exposes `/api/v1/*`. Routes that **never** go to the public ingress: `/api/v1/internal/*` (transparency collector) and `/api/v1/opa/*` (OPA bundle and status).

### 3.11 Portal web (`apps/web`)

**Role in the deployment.** It is the interface for people. On one side, the developer portal: catalog, interactive documentation, applications and access requests. On the other, the consoles for each role: publisher, data steward, entity administrator, operator, regulator and audit. It signs in with Keycloak (`den-portal`) and calls the API with the user's token, stored in Auth.js's encrypted cookie. It has no database of its own, and authorization is always decided by the API.

- Image: `apps/web/Dockerfile`. It is built with placeholder secrets; the real ones arrive at runtime.
- Variables: `AUTH_URL`, `AUTH_SECRET`, `KEYCLOAK_URL`, `DEN_PORTAL_WEB_CLIENT_ID`, `DEN_PORTAL_WEB_CLIENT_SECRET`, `DEN_API_URL` (internal, `http://api:4000`), `DEN_WEB_URL`, `DEN_GATEWAY_PUBLIC_URL`, optionally `DEN_AUTH_REFRESH_BEFORE_SECONDS` and `DEN_SESSION_IDLE_SECONDS` (the realm's `ssoSessionIdleTimeout`, 1800 by default: the web warns two minutes before the session ends from inactivity and offers to continue, WCAG 2.2.1; if you change one, change the other). In the pilot, `AUTH_TRUST_HOST=true` (it is behind the proxy).
- It runs with `next start` on 3000.
- **Security headers (M3-09).** The web sets the nonce-based CSP, HSTS and the other headers itself (`ARCHITECTURE.md §12`). The proxy in front must not remove or replace them; nor must it add another `Content-Security-Policy`, because the browser would apply both.
  - HSTS is always sent, with `includeSubDomains`: publish the web on a name whose subdomains are also served over HTTPS.
  - If Keycloak is on another origin, `KEYCLOAK_URL` authorizes it in `form-action`.

### 3.12 Reference citizen app (`infra/mock-citizen-app`)

**Role in the deployment.** In demos it plays the part of the country's citizen application. The citizen:

- signs in with the simulated digital identity (`den-citizens`);
- sees who queried their data, for what purpose and with what result;
- gets email alerts when they are queried (signed webhooks from the portal);
- verifies each receipt independently, without trusting the portal.

It shows what a real citizen app must implement; it is not a product.

- Demo prop (MT-07). Its public URL (`DEN_CITIZEN_APP_URL`) sets the base path: in the pilot, `/citizen-app`.
- Main variables: `DEN_CITIZEN_APP_URL`, `DEN_CITIZEN_ISSUER`, `DEN_CITIZEN_APP_CLIENT_SECRET`, `CITIZEN_APP_WEBHOOK_SECRET` (required), `CITIZEN_APP_PORTAL_API_URL`, `CITIZEN_APP_JWKS_URL`, `CITIZEN_APP_TSA_ROOT_URL`, `CITIZEN_APP_SMTP_HOST/PORT`, `CITIZEN_APP_DATA_FILE`.
- It stores citizens' email addresses and alert links in `citizen-app-data` (`alerts.json`).

### 3.13 Test providers (`infra/mock-providers`)

**Role in the deployment.** `mock-salud` and `mock-socioeconomico` simulate the services of two provider entities (and, with `carga-*` in `DEN_DEV_NODES`, the synthetic APIs of the load test, M6-03) with synthetic data (ADR-0009). They stand in for the kit nodes until M4: the reconciler points the upstreams at them according to `DEN_DEV_NODES` (`slug=host:port`; with `https://host:port`, the gateway talks to them over mTLS as it would to an enrolled node). They log the `X-DEN-*` headers they receive, so the demo shows what reaches the provider. They do not exist in production: the upstreams are kit nodes, existing entity APIs or an X-Road Security Server.

- A single image (`den/mock-providers:dev`); `PROVIDER` chooses the service and its data (`salud` or `socioeconomico`), with its OpenAPI in `infra/mock-providers/<provider>/openapi.yaml`.
- They listen on 8000 inside the Compose network; in development they are published on 8101 and 8102.
- They verify the gateway's signed assertion (`X-DEN-Assertion`, M6-10) as a real provider would, with the JWKS from `DEN_GATEWAY_JWKS_URL`: in development, the API on the host (`MOCK_GATEWAY_JWKS_URL`); in the pilot, the portal's public URL. They log the result (`verified`, `absent` or `invalid: <reason>`) and the demo checks it. With `MOCK_ASSERTION_REQUIRED=true` they reject (401) a call without a valid assertion.

### 3.14 WireGuard hub (`infra/wg-hub`, M4-03, ADR-0023)

**Role in the deployment.** It is the central end of the tunnels from the kit nodes, which run in the entities' networks, behind their firewall. The gateway calls a node through the hub: APISIX opens TLS towards `wg-hub:8443` with the node's name (`den-node-<id>`) as SNI, and the hub's nginx `stream` passes the connection, without opening it, to the node's address inside the tunnel. TLS is end to end between the gateway and the node. Without the hub, the versions served by nodes do not respond.

- On startup, the agent (`hub-agent.mjs`) brings up `wg0` on the first address of `DEN_WG_SUBNET` with `DEN_WG_HUB_PRIVATE_KEY`. It uses kernel WireGuard if the host has it; otherwise, `wireguard-go`.
- The container needs `NET_ADMIN` and `/dev/net/tun`. It runs with `net.ipv4.ip_forward=0`: the hub does not forward packets, and its firewall drops everything new that arrives through `wg0`. A node cannot reach other nodes, the hub or the platform.
- The agent (port 8090, `DEN_WG_HUB_AGENT_TOKEN`, internal network only) receives the full state (peers and SNI routes) from the portal's reconciler and applies it with `wg syncconf` and an nginx reload. It keeps the last state in `wg-hub-data`, so a restart serves the nodes again before the next pass.
- Nodes reach the hub over UDP 51820 from the internet. In the pilot, `docker-compose.deploy.yml` publishes that port (`WG_HUB_UDP_PORT`), and `DEN_WG_HUB_ENDPOINT` is the public name with that port. The host firewall must let it through.
- The hub's private key is in `.env` (`make-deploy-env.mjs` generates it). Changing it forces you to re-enroll every node, because the public key is part of their configuration.
- `mock-node` (`nodes` profile) is a simulated node for testing: it waits for a token in `/var/lib/mock-node/token`, enrolls, joins the hub and serves `mock-salud` over mTLS. It is not the kit (ADR-0011).

## 4. Environment variables

The complete, commented reference is `.env.example`. All services read the same `.env` at the root (Compose with `--env-file .env`; in the pilot also `env_file` for `api`, `web` and `citizen-app`).

### 4.1 Secrets you cannot change lightly

| Variable | What happens if it changes |
| :-- | :-- |
| `DEN_SUBJECT_REF_KEY` (≥ 32 characters) | Every data subject's pseudonym changes: the link between a citizen and their earlier records is lost |
| `DEN_END_USER_HASH_SALT` (≥ 16 characters) | All official hashes change |
| `DEN_TRANSPARENCY_SIGNING_JWK` | Earlier receipts only verify if the old public key is moved to `DEN_TRANSPARENCY_RETIRED_JWKS` |
| `DEN_SECRETS_KEY` (32 bytes, base64). It is rotated with `DEN_SECRETS_KEYS_PREVIOUS` and `secrets:reseal` (`OPERATIONS.md §5.6`), never simply replaced | If it is replaced without rotating, the sealed client secrets that the Keycloak reconciler has not applied yet cannot be opened, nor can the keys of the gateway's certificates (`gateway_certificate`): the APISIX reconciler fails until new certificates are issued |
| `POSTGRES_PASSWORD`, `DEN_APP_DB_PASSWORD`, `KEYCLOAK_DB_PASSWORD` | Only applied when the volume is created (§3.2) |
| `DEN_PORTAL_WEB_CLIENT_SECRET`, `DEN_GATEWAY_PROVISIONER_SECRET`, `DEN_CITIZEN_APP_CLIENT_SECRET` | Only applied when the realm is imported (§3.3) |
| `STEP_CA_PASSWORD` | It encrypts the already created keys of the CA and of the `den-portal` and `den-gateway-tls` provisioners |
| `AUTH_SECRET` | Ends every web session |
| `DEN_APISIX_KEYRING` (16 characters) | APISIX cannot read the private keys it encrypted with the previous one (gateway TLS, assertions). To rotate it, add the new one **first** in `data_encryption.keyring`, keeping the previous one after it, until the reconciler rewrites those objects |

If `DEN_SUBJECT_REF_KEY` or `DEN_END_USER_HASH_SALT` is missing, too short, or (with `NODE_ENV=production`) one of the sample values from `.env.example`, the API cannot build the OPA bundle and the gateway denies everything. Each deployment has its own (`make-deploy-env.mjs` generates them at random): that way the same official or data subject does not have the same hash in two networks (M3-06).

API security (M6-01):
- `DEN_TRUST_PROXY`: who may set `X-Forwarded-For`, the caller's address in the limits and in the security events.
  - The proxy's address or its network, comma-separated (`172.30.0.2`). In the pilot it is Traefik's address on the `edge` network: `docker inspect -f '{{(index .NetworkSettings.Networks "lab-router_default").IPAddress}}' <traefik-container>`. If Traefik changes address when it restarts, pin it with `ipv4_address` in its Compose file.
  - The whole network only if it holds no containers other than the proxy and the portal: any other one could choose the address under which it is recorded and limited.
  - A number trusts that many hops, wherever they come from: only where nothing but the proxy can reach the API.
  - Empty (what `make-deploy-env.mjs` generates if you pass nothing): nobody. Callers without a session then share the proxy address's quota.
- `DEN_LOG_FORMAT`: `text` (default) or `json`, one object per line for a log collector (the Helm chart sets `json`). Lines are masked in both formats (`ARCHITECTURE.md §8`).
- `DEN_RATE_LIMIT_PER_MINUTE` (600 per verified user, or per address without a valid token) and `DEN_RATE_LIMIT_STRICT_PER_MINUTE` (30 on uploads, new versions, onboarding requests, invitations and node enrollment).

**Compose networks (M6-01).** `default` is the platform, `gateway` is gateway control (etcd and OPA only there) and `providers` holds the upstreams and the contract runner. In the pilot APISIX is not on `default`. The API is not on `providers`: it shares the `runner` network with the contract runner, for the two of them only. See `ARCHITECTURE.md §12`.

**Deploying M6-04 on an existing pilot.** `up -d` creates the `opa-data` volume, runs `opa-init` and recreates OPA: for a few seconds there is no OPA and the gateway denies (fails closed).

**Deploying M6-03 on an existing pilot.** Routes switch to querying `den/authz/decision`, which exists only in the new OPA bundle. Until OPA downloads it (10–20 s after the new API starts), calls are denied, as in step 6 of M3. It is best done in a low-traffic window.

**Deploying M6-01 on an existing pilot:**
1. Add `DEN_APISIX_KEYRING` (16 random characters) and `DEN_TRUST_PROXY` (Traefik's address, above) to `.env`.
2. Recreate everything with `up -d`: the networks change.
3. Apply the password policy, the exact URIs and the events to the already imported `den-portal` realm (with `kcadm`, as in §3.3), and the exact URIs to the `den-citizens` realm.
4. If you run your own Traefik, add the `den-rate-api` and `den-rate-auth` limits from `infra/edge/den.yml.template`.

Analytics (M5): `DEN_OPENSEARCH_URL` (OpenSearch as the API reaches it) and, optionally, `DEN_OPENSEARCH_AUTH`.

Metrics and alerts (M5-06):
- `DEN_METRICS_TOKEN`, the token Prometheus uses to read the API's `/metrics`; without it, the endpoint does not exist.
- `DEN_PROMETHEUS_URL`, Prometheus as the API reaches it, for the gateway's availability.
- `GRAFANA_ADMIN_PASSWORD`, and in the pilot `GRAFANA_ROOT_URL` and `GRAFANA_SERVE_FROM_SUB_PATH`.

`make-deploy-env` generates them.

Validations on submission for review (M4-06): `DEN_VALIDATION_TOKEN` (APISIX's verification routes exist only with it), `DEN_GATEWAY_INTERNAL_URL` (APISIX as the API reaches it), `DEN_CONTRACT_RUNNER_URL` and `DEN_CONTRACT_RUNNER_TOKEN` (the Schemathesis runner), `DEN_CONTRACT_RUNNER_GATEWAY_URL` (APISIX as the runner reaches it) and, optionally, `DEN_CONTRACT_MAX_EXAMPLES` (20) and `DEN_CONTRACT_TIMEOUT_SECONDS` (120). Without the token, the health check fails and the operator cannot approve; without the runner, the contract test is skipped.

X-Road (M4-05, `ARCHITECTURE.md §4.1`): `DEN_XROAD_SECURITY_SERVER_URL` (the operator's Security Server, as APISIX reaches it), `DEN_XROAD_CLIENT` (the operator's subsystem, `INSTANCE/CLASS/MEMBER/SUBSYSTEM`) and `DEN_XROAD_SECURITY_SERVER_CA` (path to the PEM that verifies the Security Server's internal TLS certificate). Without the first two, `xroad` versions have no route. Over HTTPS, the operator registers the gateway's `CN=<DEN_GATEWAY_CLIENT_NAME>.xroad` certificate (SSL object `den-ssl-gateway-xroad`) in its Security Server.

Kit nodes (M4-02, `ARCHITECTURE.md §10`): `DEN_NODE_CONTROL_TOKEN` (added by the gateway's control route; without it and without `DEN_GATEWAY_PORTAL_API_URL` there is no control route), `DEN_NODE_CONTROL_URL` (URL of the control channel given to the node, `DEN_GATEWAY_PUBLIC_URL` by default), `DEN_WG_SUBNET`, `DEN_WG_HUB_PUBLIC_KEY` and `DEN_WG_HUB_ENDPOINT` (without these two, enrollment returns 503), `DEN_WG_HUB_AGENT_URL` and `DEN_WG_HUB_AGENT_TOKEN` (the hub's agent; without them, the reconciler does not register peers), `DEN_GATEWAY_WG_HUB` (the hub's SNI router as APISIX reaches it, `wg-hub:8443`; M4-04), and, optionally, `DEN_NODE_ENROLLMENT_TTL_HOURS` (72), `DEN_NODE_HEARTBEAT_SECONDS` (60), `DEN_NODE_OFFLINE_AFTER_SECONDS` (300), `DEN_NODE_CERT_VALIDITY_HOURS` (2160), `DEN_NODE_RENEWAL_GRACE_HOURS` (24) and `DEN_NODE_MIN_KIT_VERSION`.

Other gateway variables (M3): `DEN_GATEWAY_NODES` (how many APISIX nodes serve the traffic, 1 by default: each node counts requests on its own and the bundle gives each one its share of the subscription's limit, ADR-0020; an invalid value leaves OPA without a bundle), `DEN_GATEWAY_TLS_HOSTS` (names on the gateway's server certificate, `localhost` by default; in the pilot, the gateway's own name from M3-10) and `DEN_GATEWAY_CLIENT_NAME` (prefix of the client certificate towards providers, `den-gateway` by default). The credential rotation window is `lifecycle.credentialRotationDays` in the country configuration (7 days by default).

### 4.2 What differs between development and pilot

`scripts/make-deploy-env.mjs` writes them; in development the values from `.env.example` apply.

| Variable | Development | Pilot |
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
| `DEN_STEP_CA_ROOT_FILE` | empty | `/var/lib/den/step-ca/root_ca.crt` |
| `DEN_WEB_URL`, `AUTH_URL` | `http://localhost:3000` | `${DEN_PUBLIC_URL}` |
| `DEN_GATEWAY_PUBLIC_URL` | `https://localhost:9443` | `https://<gateway name>` with mTLS (`--gateway-host`); `${DEN_PUBLIC_URL}/gw` without mTLS |
| `DEN_CITIZEN_ISSUER` | `http://localhost:8080/realms/den-citizens` | `${DEN_PUBLIC_URL}/auth/realms/den-citizens` |
| `DEN_CITIZEN_APP_URL` | `http://localhost:3100` | `${DEN_PUBLIC_URL}/citizen-app` |
| `DEN_CITIZEN_APPS` (webhook) | `http://localhost:3100/api/den/alerts` | `http://citizen-app:3100/citizen-app/api/den/alerts` |
| `DEN_DEMO_USER_PASSWORD` | `den-demo-password` (12 characters or more: the realm's password policy, M6-01) | random, unless `--demo-password` |
| `DEN_DEMO_TOTP_SECRET` | `den-demo-totp-secret` | random (`pnpm demo:otp` gives the code) |
| `DEN_GATEWAY_PORTAL_API_URL` (node control route) | `http://host.docker.internal:4000` | `http://api:4000` |
| `DEN_NODE_CONTROL_TOKEN` | development value | random |
| `DEN_WG_HUB_PRIVATE_KEY`, `DEN_WG_HUB_PUBLIC_KEY` | development pair | random pair |
| `DEN_WG_HUB_ENDPOINT` | `wg-hub:51820` | `<gateway name>:51820` |
| `MAILPIT_UI_AUTH`, `TRAEFIK_NETWORK`, `DEN_PUBLIC_URL` | — | pilot only |

The API uses `KEYCLOAK_URL` to validate tokens and for the `den-gateway` Admin API: in the pilot it reaches Keycloak through the public URL, via the proxy.

**Upgrading an existing installation: the reference citizen app was renamed.** It used a country-specific name. In an existing `.env`, rename `DEN_CARPETA_URL` to `DEN_CITIZEN_APP_URL` (its path changes from `/carpeta` to `/citizen-app`) and `DEN_CARPETA_CLIENT_SECRET` to `DEN_CITIZEN_APP_CLIENT_SECRET`, and replace the client id `carpeta-ciudadana` with `citizen-app` in `DEN_CITIZEN_CLIENTS` and `DEN_CITIZEN_APPS`, whose webhook URL becomes `http://citizen-app:3100/citizen-app/api/den/alerts`. Keycloak imports a realm only when it does not exist: in an existing `den-citizens` realm, rename the client by hand in the administration console (Client ID and redirect URIs). In Compose, the service, its alias and its volume are now `citizen-app`, `den-citizen-app` and `citizen-app-data`: copy `alerts.json` from the old `carpeta-data` volume if the demo's alert subscriptions matter. `sudo ./install.sh update` regenerates the proxy routes.

## 5. Single-machine pilot

The recommended way to install the pilot is `sudo ./install.sh` ([`INSTALL.md`](INSTALL.md)): it asks the questions, writes `.env` with `make-deploy-env.mjs`, sets up the proxy and starts everything. This section describes what lies underneath, for anyone who does it by hand or has their own proxy.

**Bundled proxy (`docker-compose.edge.yml`).** For a server without a proxy of its own: Traefik on 80 and 443 with the routes of §5.2, generated by `install.sh` from `infra/edge/den.yml.template` into `infra/edge/dynamic/den.yml`. It terminates HTTPS on the portal's name (Let's Encrypt, or your own certificate in `infra/edge/certs/`) and passes the TLS of the gateway's name through to APISIX untouched. On the `den-edge` network it takes the two public names as aliases (`DEN_PORTAL_HOST`, `DEN_GATEWAY_HOST`), so the API and the web reach Keycloak through the public URL without leaving the server. It keeps no access log.

### 5.1 What the `docker-compose.deploy.yml` override does

- It removes all published ports (`ports: !reset []`) and sets `restart: unless-stopped`.
- It adds `api`, `web` and `citizen-app` as containers. The API applies migrations and the seed on startup (`DEN_ALLOW_SEED=true`) and sends mail to `smtp://mailpit:1025`.
- It attaches to the proxy, through the external network `${TRAEFIK_NETWORK}` (`lab-router_default` by default), only the services that are published, with fixed aliases: `den-portal-web`, `den-portal-api`, `den-keycloak`, `den-apisix`, `den-mailpit`, `den-citizen-app`, `den-tsa`.
- Keycloak with a `start_period` of 300 s: on a shared machine it takes minutes to start.

### 5.2 Reverse proxy routes (a single public name)

| Public path | Target | Prefix |
| :-- | :-- | :-- |
| `/` | `den-portal-web:3000` | kept |
| `/api/v1` | `den-portal-api:4000` | kept; **except** `/api/v1/internal` and `/api/v1/opa`, which are not published |
| `/auth` | `den-keycloak:8080` | kept (`KC_HTTP_RELATIVE_PATH=/auth`) |
| `/gw` | `den-apisix:9080` | `/gw` **is stripped** |
| `/mail` | `den-mailpit:8025` | kept (`MP_WEBROOT=/mail`) |
| `/citizen-app` | `den-citizen-app:3100` | kept (base path of `DEN_CITIZEN_APP_URL`) |
| `/tsa/api/v1/timestamp/certchain` | `den-tsa:3004` | `/tsa` **is stripped**; nothing else of the TSA is published |

`/api/auth/*` (Auth.js) belongs to the web: that is why the API rule is `/api/v1`, not `/api`.

Example for Traefik (file provider). It is not in the repo; adapt it to your proxy and your certificate resolver:

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

Traefik gives higher priority to the longer rule, so `/api/v1`, `/auth`, etc. win over `/`.

**mTLS (M3-10, `features.mtls.required`).** The gateway's TLS must terminate at APISIX (SPIKE S-3): behind a proxy that terminates TLS, `/gw` cannot pass on the client certificate. Three things are needed:

1. **A name of its own for the gateway**, for example `gw.example.org`, with TLS passthrough to APISIX's port 9443. There APISIX presents its server certificate, issued by step-ca for `DEN_GATEWAY_TLS_HOSTS`. In `.env`: `DEN_GATEWAY_PUBLIC_URL=https://gw.example.org` and `DEN_GATEWAY_TLS_HOSTS=gw.example.org` (`make-deploy-env.mjs --gateway-host gw.example.org`). Applications also request their token there: `https://gw.example.org/oauth/token`.
2. **`/auth` must strip `SSL_CLIENT_CERT` and `ssl-client-verify`** before the request reaches Keycloak. Keycloak trusts those headers (S-4), and only the gateway's token route may set them (ADR-0022).
3. APISIX's port 9443 must be on the proxy's network. It already is, through the `den-apisix` alias.

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

The TCP router needs Traefik's `websecure` entry point (443) to be the same one as the HTTP routers: Traefik resolves the TCP routers first, by SNI. Traefik does not request the certificate for `gw.example.org`: APISIX presents it. Applications trust it through the network's root (`/api/v1/pki/ca`).

### 5.3 First deployment

```bash
git clone <repo> && cd <repo>
node scripts/make-deploy-env.mjs https://portal.example.org --gateway-host gw.example.org [--traefik-network <network>] [--demo-password <pw>]
# → writes .env (mode 600) with random secrets, a new signing key and the internal names.
#   It refuses to overwrite an existing .env.
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml \
  --env-file .env --profile observability up -d --build
```

- The `api` and `web` builds take several minutes; Keycloak, one or two more.
- Configure the proxy (§5.2) and then follow `OPERATIONS.md §2`.
- Keep a copy of `.env` off the machine: without it the data can be neither recovered nor verified (§4.1).

### 5.4 Updating

```bash
# 1. Backup if the release brings migrations (OPERATIONS.md §6): sudo ./install.sh backup
# 2. New code
git pull --ff-only
# 3. Rebuild and restart (everything, or only the services that changed)
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml \
  --env-file .env --profile observability up -d --build [api web citizen-app]
```

- Migrations are applied automatically when the API starts.
- Check the story notes (`BACKLOG.md`) for manual steps the release requires: Keycloak realm changes (they are not re-imported, §3.3), new variables in `.env` (`make-deploy-env.mjs` does not edit an existing `.env`) or new volumes.
- **When moving to M3 (M3-01 to M3-04)**, on an earlier pilot:
  1. Add to `.env`: `DEN_STEP_CA_URL=https://step-ca:9000`, `DEN_STEP_CA_PROVISIONER_PASSWORD` (= `STEP_CA_PASSWORD`), `DEN_STEP_CA_ROOT_FILE=/var/lib/den/step-ca/root_ca.crt` and, if their defaults change, `DEN_GATEWAY_TLS_HOSTS` and `DEN_GATEWAY_CLIENT_NAME`.
  2. Recreate `step-ca` (it creates the `den-gateway-tls` provisioner) and `apisix` (it loads `den-client-cert`) before the API.
  3. Apply the rotation policy to the existing realm: `node scripts/keycloak-client-policies.mjs` with `KEYCLOAK_URL` and the `master` administrator (`OPERATIONS.md §5.3`).
  4. **M3-08 (second factor).** Add a random `DEN_DEMO_TOTP_SECRET` to `.env`, for example with `openssl rand -hex 20`. Then apply the flow and the demo codes to the existing realm: `node scripts/keycloak-portal-mfa.mjs --demo-otp`. Do this before starting the new API: from then on, users with a critical role need the code.
  5. **M3-10 (mTLS).**
     - DNS for the gateway's name pointing to the machine.
     - TCP router with passthrough and middleware on `/auth`, as in the example in §5.2.
     - In `.env`: `DEN_GATEWAY_PUBLIC_URL=https://<name>` and `DEN_GATEWAY_TLS_HOSTS=<name>`.
     - Recreate `keycloak` (it starts with the `nginx` x509 provider), then `apisix` and the API. The API reissues the gateway's server certificate for the new name, adds `client.ca` to the SSL object, creates the `den-oauth-token` route and binds each application's tokens to its certificate.
     - From then on, an application without a valid certificate cannot call: each developer issues their own from their application's page (M3-01).
  6. With M3-05, during the first 10–20 s after the new API starts, allowed calls may return 500: the routes already carry `limit-count` and OPA still has the previous bundle, without `X-DEN-Rate-Limit`. It fixes itself with the next bundle download. If that cannot be tolerated, do the update in a maintenance window.
- **When moving to M6-06 (backups with pgBackRest)**, on an earlier pilot: add `PGBACKREST_REPO1_CIPHER_PASS` (32 random characters) to `.env` and keep a copy off the server. `install.sh` does this by itself if it is missing, on install or update. If the update is run by the previous `install.sh`, Compose stops and asks for the variable: just run `sudo ./install.sh update` again. On startup, PostgreSQL restarts with archiving on and `pgbackrest` takes the first full backup.
- A change in `infra/apisix/config.yaml`, `infra/opa/config.yaml`, `infra/fluent-bit/*` or `infra/step-ca/*` is mounted from the repo: restarting that service is enough (`up -d <service>` or `restart <service>`).

## 6. Local development

```bash
cp .env.example .env
pnpm install
pnpm infra:up            # or infra:up:core (without OpenSearch or the analytics Fluent Bit)
pnpm db:migrate && pnpm db:seed
pnpm dev                 # web 3000 + api 4000 + citizen app 3100
```

| Command | What it does |
| :-- | :-- |
| `pnpm infra:up` / `infra:up:core` | Brings the services up and waits for their health check (up to 180 s) |
| `pnpm infra:ps` / `infra:logs` | Status and logs |
| `pnpm infra:down` | Stops, keeps data |
| `pnpm infra:reset` | Stops and **deletes** volumes (database, CA, TSA, indices, buffer) |

In development OPA and `fluent-bit-transparency` reach the API on the host through `host.docker.internal`.

## 7. CI

`.github/workflows/ci.yml`:

| Job | What it runs |
| :-- | :-- |
| Lint, typecheck, test, licenses | `pnpm format:check`, `typecheck`, `lint`, `test`, `license:check` |
| API integration | `docker compose up -d --wait postgres etcd apisix tsa step-ca` and `pnpm --filter @den/api test:integration`; then `test:dist` on the build |
| OPA policies | `opa check --strict`, `opa test`, coverage ≥ 90 % |

`.github/workflows/pages.yml` publishes the HTML guides to GitHub Pages (https://centre-for-dpi.github.io/data-exchange-admin-portal/) when they change. `scripts/docs-site.sh` builds the site: it wraps each guide in a full document with its language and adds the landing page `docs/site/index.html`. Pages must be set to deploy from GitHub Actions in the repository's settings.

## 8. Pilot limits compared with production

| Topic | Pilot (today) | Production (target, `ARCHITECTURE.md §11`) |
| :-- | :-- | :-- |
| Initial data | Always loads the seed: fictitious entities and demo users, including platform administrators | No demo data. The first `platform_admin` comes from `DEN_BOOTSTRAP_ADMIN_EMAIL` (§9.3) |
| Keycloak | `start-dev`, same PostgreSQL instance | Cluster in production mode, its own database |
| CA | Development CA in a volume | Offline root, intermediate in an HSM |
| TSA | sigstore with a key in a file | The country's accredited TSA |
| etcd | One node, no TLS | Cluster of 3 with mTLS |
| OpenSearch | No security, no retention | Security plugin, retention policy |
| Mail | Mailpit | The operator's SMTP |
| Secrets | `.env` on disk | Secrets manager (OpenBao) |
| High availability | None | ≥ 2 APISIX nodes with local OPA, ≥ 2 web and API replicas, PostgreSQL with a replica |
| Metrics and alerts | Prometheus, Alertmanager and Grafana with the `observability` profile (§3.8.1); alerts go to Mailpit | The same as subcharts of `den-platform`, with the operator's SMTP |
| Backups | pgBackRest: continuous WAL and daily backups in an encrypted repository on the same server; the off-server copy is manual (`install.sh backup`) | Barman Cloud to the operator's object storage (M6-06) |
| Application mTLS | Required, as in production (`features.mtls.required: true` in `co.yaml` since M3-10) | Required |

## 9. Kubernetes: Helm charts (M6-05, in progress)

> **Status (2026-11-16).** The charts are complete and statically validated: `helm lint`, plus `helm template` and strict kubeconform against Kubernetes 1.31 (116 valid resources). The images were built and scanned locally, with no high or critical findings. **They have not been installed on any cluster yet.** `pnpm helm:kind` will do it on kind when that is decided, and adjustments are to be expected in that first installation.

### 9.1 The two charts

| Chart | What it installs | When |
| :-- | :-- | :-- |
| `infra/helm/den-platform` | The cluster operators: CloudNativePG 0.29.1 (PostgreSQL with replicas) with its Barman Cloud plugin 0.8.1 (backups, M6-06), External Secrets 2.14.0 (secrets from OpenBao or another store) and cert-manager v1.21.3 | Once per cluster, before `den`, in the `den-platform` namespace |
| `infra/helm/den` | All of DEN: web and API, the gateway (APISIX with its OPA and the transparency and error Fluent Bits in each pod), etcd with mTLS, Keycloak, the two databases, step-ca, the node hub, the contract runner, the access pipeline, OpenSearch with its security plugin, Prometheus with Alertmanager, Grafana, the internal PKI (cert-manager) and the ingress and egress NetworkPolicies | One `helm install` |

There are two because Helm cannot create an operator and its resources in the same installation: the resources (a database `Cluster`, an `ExternalSecret`) reach the operator's webhook before it responds.

**Cluster prerequisites:**
- **Traefik as ingress**: `ingress.className`. ingress-nginx is retired. With another controller, it must strip `SSL_CLIENT_CERT` and `ssl-client-verify` from every request to the public host.
- **A StorageClass with `ReadWriteMany`** for uploaded documents (`api.documents`). The other pieces use `ReadWriteOnce`.
- **A network load balancer (`LoadBalancer`)** for the gateway, which terminates the applications' mTLS (it does not go through the ingress), and for the node hub's UDP.
- **OpenBao** (or any External Secrets store) with a `ClusterSecretStore`: `secrets.externalSecrets.secretStoreRef`.
- **S3-compatible object storage outside the cluster** for the database backups (`postgres.backup`): a dedicated bucket, with encryption, and an access key that can only write to it.
- **A cluster log collector** (a Fluent Bit DaemonSet, Vector or another) that ships the containers' output to the operator's central system. The API logs arrive there, as masked JSON (`ARCHITECTURE.md §8`), along with the gateway's masked error log. The chart does not install it: it belongs to the platform, as for any other workload.
- **A CNI that enforces NetworkPolicies** (Calico, Cilium). Without one, the chart's policies have no effect.

### 9.2 Secrets

Each component has its own Secret `den-<component>`, with only the keys it uses. With `secrets.mode: externalSecrets`, all of them are properties of a single store entry (`secrets.externalSecrets.remoteKey`, `den/platform` by default). External Secrets assembles the Secrets and also derives the connection URLs and CloudNativePG's `basic-auth` Secrets from the passwords, so that the same value is never stored twice. With `secrets.mode: existing`, the operator creates those Secrets under those names. The exact list of keys is in `templates/_helpers.tpl` (`den.secrets`), and they are the same as in `.env.example`, except:
- `DB_OWNER_PASSWORD` and `DB_APP_PASSWORD`, from which `DATABASE_MIGRATION_URL` and `DATABASE_URL` are derived;
- `KEYCLOAK_SMTP_USER` and `KEYCLOAK_SMTP_PASSWORD`, for the realm's mail;
- `ALERTMANAGER_SMTP_PASSWORD`, the password of the mail server for alerts (`prometheus.alertmanager.config.global`);
- `DB_BACKUP_ACCESS_KEY_ID` and `DB_BACKUP_SECRET_ACCESS_KEY`, the access key for the backup storage;
- `DEN_SECRETS_KEYS_PREVIOUS`, empty except while `DEN_SECRETS_KEY` is being rotated (`OPERATIONS.md §5.6`);
- `OPENSEARCH_INTERNAL_USERS_YML`, the `internal_users.yml` of OpenSearch's security plugin with three users: `admin`, `den-logs` (Fluent Bit: `OPENSEARCH_USER` and `OPENSEARCH_PASSWORD`) and `den-api` (the portal: `DEN_OPENSEARCH_AUTH`, `user:password`). It carries only the bcrypt hashes, made with `plugins/opensearch-security/tools/hash.sh` from the OpenSearch image. The security index is created from it on first start; later changes go through `securityadmin.sh` and the `den-opensearch-admin` certificate.

`GRAFANA_ADMIN_PASSWORD` is the one from `.env.example`; the user is `admin`.

The connection URLs use `sslmode=verify-full` with the certificate of each database's CA. Its key is never mounted.

**Rotation.** Change the value in the store and External Secrets updates the Secret within `refreshInterval`. Pods read their secrets on startup: you have to restart them (`kubectl rollout restart`) or let Reloader do it. The order of each rotation is the one in OPERATIONS §5.6.

### 9.3 First installation

0. **`den-platform`.** If it includes cert-manager (the usual case), the first time it is installed with `--set plugin-barman-cloud.enabled=false` and immediately upgraded without that option: the backup plugin issues its certificates with cert-manager, which must be running first. If the cluster already has cert-manager (`cert-manager.enabled=false`), a single installation is enough.
1. **The network's CA.** The root is created outside the cluster, offline. The `stepCa.pkiSecret` Secret holds `root_ca.crt`, `intermediate_ca.crt` and `intermediate_ca_key` (encrypted with `DEN_STEP_CA_PROVISIONER_PASSWORD`). `stepCa.rootFingerprint` is the root's fingerprint, which the API pins. On every start, step-ca takes the root and the intermediate from the Secret; on the first start it also writes its `ca.json` and the portal's three provisioners, like `infra/step-ca/configure.sh`. Rotating the intermediate means replacing it in the Secret and restarting (`RUNBOOK.md §3.2`).
2. **Keycloak.** It imports the production realms: the development ones without their personas (`pnpm helm:sync` keeps only the clients' service accounts) and with the SMTP from `keycloak.smtp`. It starts with a temporary administrator (`keycloak.bootstrapAdmin`), which is replaced by a proper one with a second factor.
3. **The first `platform_admin`.** Production has no seed. `api.bootstrapAdminEmail` (`DEN_BOOTSTRAP_ADMIN_EMAIL`) grants the role to whoever signs in first with that address, verified by Keycloak, while the network has none. It is audited. Afterwards the value is removed, and the other roles are granted from the console.
4. **Migrations.** They run in an init container of the API with the schema owner's credentials, which reach only that container. Prisma takes a lock, so two replicas do not migrate at the same time.

### 9.4 Files shared with Compose

Helm only reads files inside the chart. `pnpm helm:sync` copies into `infra/helm/den/files/` what the chart shares with Compose:
- the APISIX plugins;
- the Fluent Bit filters and configurations;
- the Prometheus rules and the Grafana dashboard;
- the OPA configuration and the step-ca templates;
- the realms, in their production form.

`tests/infra` fails if a copy does not match its source. The configurations whose host changes in Kubernetes (APISIX's, the access pipeline's) are chart templates. If the source changes, the template changes too.

### 9.5 Values that each deployment sets

Besides `country`, `publicUrl`, `gatewayHost` and `gatewayPublicUrl`:
- `stepCa.rootFingerprint` and `stepCa.pkiSecret` (§9.3);
- `postgres.backup.destinationPath` (`s3://<bucket>/<path>`) and, with the operator's own storage, `endpointURL` and `endpointCASecret`. Without `destinationPath` the chart does not install; backups are only disabled on purpose (`postgres.backup.enabled=false`, as in kind);
- `keycloak.smtp` (the realm's server and sender) and `prometheus.alertmanager.config` (server, sender and recipients of the alerts);
- `antivirus.replicas` (2 by default: with antivirus enabled, an upload fails if ClamAV does not respond) and its resources;
- `grafana."grafana.ini".server.root_url`: `<publicUrl>/grafana/`. Without it, Grafana redirects to `localhost`;
- `networkPolicy`: the ingress namespace (`ingressControllerNamespace`), and the private networks that the gateway (`gatewayExtraEgressCidrs`: providers inside the operator's network, an X-Road Security Server) or the API and Keycloak (`servicesEgressCidrs`: mail, the TSA) need to reach. By default they only go out to public addresses.

### 9.6 Images

`.github/workflows/images.yml` builds the chart's four own images: `den-portal-api`, `den-portal-web`, `den-wg-hub` and `den-contract-runner`.
- **SBOM.** It keeps a CycloneDX SBOM of each one as a run artifact, for 90 days.
- **Scanning.** It scans them with Trivy (0.76.1, pinned by digest). A high or critical vulnerability with a fix available stops the release. An accepted exception goes in `.trivyignore`, with its reason and expiry date.
- **Publishing.** With a `vX.Y.Z` tag it publishes to `ghcr.io/centre-for-dpi/<image>:X.Y.Z` (the chart's `appVersion`), with BuildKit's SBOM and provenance attestations. Run by hand (`workflow_dispatch`) it only builds and scans, unless `publish` is checked.
- **Pinned actions.** Third-party actions are pinned by commit.

**v0.1.0 (2026-11-17).** First release: `ghcr.io/centre-for-dpi/{den-portal-api,den-portal-web,den-wg-hub,den-contract-runner}:0.1.0`, also as `latest`, scanned with no high or critical findings, with their SBOM and provenance. The repository is public, but the packages were created while it was private and are still private: until an organization owner makes each one public (the package's settings → Change visibility), the cluster needs an `imagePullSecrets` with access to ghcr.io.

The API and web images are multi-stage. The runtime stage carries only the production dependencies (`pnpm deploy --prod`) and the repository files that the process reads: the country configuration and, in the API, the OPA policies and the pilot's seed realm. It has no package manager. The migrations container runs `node_modules/.bin/prisma migrate deploy`.

### 9.7 Pending in M6-05

- **Install** on kind (`pnpm helm:kind`) and then in the operator's production-like environment. The chart has never been installed.

## 10. A new country (M6-09)

The code does not change from one country to another (rule 6 of CLAUDE.md). What is specific to each country lives in:

| What | Where |
| :-- | :-- |
| Name, date and number language, time zone, authorities, legal framework, document types, sectors, purposes, rules (`features`), deadlines, retention, agreement template and branding | `config/country/<code>.yaml`, copied from `config/country/example.yaml`. The schema (`packages/config/src/schema.ts`) rejects unknown keys and invalid values, and the API does not start with an invalid file |
| Interface texts | `apps/web/messages/es.json` and `en.json`: complete in both languages. The country texts in the YAML accept one or both languages |
| Citizen identity | The country's realm replaces `den-citizens`. Its token carries the document type and number in the claims named by `DEN_CITIZEN_DOCUMENT_TYPE_CLAIM` and `DEN_CITIZEN_DOCUMENT_NUMBER_CLAIM`, with the types from `identifiers.person` |
| Country selection | `DEN_COUNTRY=<code>` (and `DEN_CONFIG_DIR` if the files are not in `config/country`), in the API and in the web |

**Default language.** The web opens in Spanish and serves English under `/en` (rule 7 of CLAUDE.md). For a country whose main language is English, the default language is `defaultLocale` in `apps/web/src/i18n/routing.ts`: changing it also changes the logout URLs that the realm accepts (`post.logout.redirect.uris`).

**Test:** `pnpm example:country` (`scripts/example-country.mjs`):
1. Turns `example.yaml` into country XX.
2. Brings up a separate stack: the Compose project `denxx`, with every port shifted by 10000 and its own volumes. The development stack is not touched.
3. Starts the portal with that country.
4. Checks the web in both languages with the country's branding.
5. Runs the demo from `DEMO.md` end to end, with XX's sector, purposes and document type.
6. Deletes what it created (`--keep` keeps it for inspection).

The demo (`pnpm demo`) takes that data from the country configuration, so it also works for any country's deployment.
