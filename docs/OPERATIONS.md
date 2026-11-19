# Operations guide — DEN Portal

> Versión en español: [docs/es/OPERATIONS.md](es/OPERATIONS.md)

Version 0.3 · November 2026 · code as of M6: all of it except the load test (M6-03) and the cluster installation (M6-05), which need the operator's production-like environment

What each component does at startup, what the operator has to do or run to make it operational, how to check that it works and what to review day to day. How each piece is deployed is in [`DEPLOYMENT.md`](DEPLOYMENT.md). Entity onboarding, incident response, intermediate CA rotation and mass certificate revocation are in the operator runbook ([`RUNBOOK.md`](RUNBOOK.md)).

## 0. Conventions

On the pilot, all commands are run at the root of the clone, with this shortcut:

```bash
alias dc='docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml --env-file .env --profile observability'
```

In development, the equivalent is `docker compose -f infra/compose/docker-compose.yml --env-file .env --profile observability` (or `pnpm infra:ps` / `pnpm infra:logs`), and the API runs on the host (`pnpm dev`), so the `dc exec api ...` commands are replaced by calls to `localhost`.

Internal services have no published ports on the pilot. To talk to them, use the `api` container, which has `wget` and is on the same network:

```bash
dc exec api wget -qO- http://opa:8181/health
```

## 1. Dependency map and startup order

```
postgres ──▶ keycloak ─────────────┐
etcd ──────▶ apisix ───────────────┤
step-ca ───────────────────────────┼──▶ api ──▶ web
tsa-init ──▶ tsa ──────────────────┘      └───▶ citizen-app
opa ················ downloads the bundle from api (retries on its own)
fluent-bit-transparency ··· sends records to api (disk buffer while api does not respond)
opensearch ──▶ fluent-bit ··· receives analytics logs from apisix
mailpit ··· receives email from api, keycloak and citizen-app
```

Compose follows this order with `depends_on` and health checks: `api` waits for `postgres`, `step-ca`, `keycloak` and `apisix` to be healthy and for `tsa` to have started; `web` and `citizen-app` wait for `api` to be healthy. OPA and the Fluent Bits do not depend on the API: they retry until it responds.

**Data plane vs. governance plane.** If `api`, `web` or `keycloak` go down, the gateway keeps serving with the last etcd configuration and the last OPA bundle. Without Keycloak no new tokens are issued, and validating the current ones depends on APISIX having the realm's keys (JWKS) cached; this is not tested yet (M6-04). If `apisix`, `etcd` or `opa` go down, traffic stops.

## 2. Go-live (day 0)

### 2.1 What each component does on its own and what you have to do

| Component | Does on its own at startup | What the operator has to do | How to check it |
| :-- | :-- | :-- | :-- |
| `postgres` | With an empty volume: roles `den_app` and `keycloak`, databases `keycloak` and `den_test` (`infra/postgres/init`) | Nothing. The passwords in `.env` are set here and only here | `dc exec postgres pg_isready` |
| `keycloak` | Imports the realms `den-portal`, `den-gateway` and `den-citizens` if they do not exist, with the secrets from `.env` | Nothing on a new deployment. On an existing one, apply the realm changes the version calls for (§5.3), among them the secret rotation policy of M3-04 and the second factor of M3-08 | `curl -fsS $DEN_PUBLIC_URL/auth/realms/den-portal/.well-known/openid-configuration` |
| `etcd` | — | Nothing | `dc ps etcd` (healthy) |
| `apisix` | Reads `infra/apisix/config.yaml`; no routes or SSL objects until the API reconciles | **Nothing by hand**: routes, upstreams and SSL objects are created by the API | `dc ps apisix` (healthy); §2.2 |
| `step-ca` | First time: creates the CA and the `den-portal` provisioner. Always: `configure.sh` sets templates and durations, and creates `den-gateway-tls` if it is missing | Save the root fingerprint if another system needs it (§5.4) | `dc exec step-ca step ca health --ca-url=https://localhost:9000 --root=/home/step/certs/root_ca.crt` |
| `tsa-init` / `tsa` | `tsa-init` creates the TSA chain once; `tsa` signs timestamps | Nothing | `curl -fsS $DEN_PUBLIC_URL/tsa/api/v1/timestamp/certchain` returns PEM |
| `opa` | Requests the bundle from the API every 10–20 s; denies everything until it has it | Nothing | `dc exec api wget -qO- 'http://opa:8181/health?bundles'` responds `{}` (200) only with the bundle active |
| `fluent-bit-transparency` | Listens on 5170; sends to the API collector with retries | Nothing | `dc exec api wget -qO- http://fluent-bit-transparency:2020/api/v1/health` |
| `opensearch` / `fluent-bit` | `den-access-YYYY.MM` indexes when the first log arrives | On the host, `vm.max_map_count` (DEPLOYMENT §2) | `dc ps opensearch fluent-bit` (healthy) |
| `mailpit` | — | Save the `MAILPIT_UI_AUTH` user | Open `$DEN_PUBLIC_URL/mail` |
| `api` | Migrations (`prisma migrate deploy`), idempotent seed (`DEN_ALLOW_SEED=true`), start of the background jobs and an **immediate full reconciliation** of APISIX and Keycloak | Review the log of the first start | `dc logs api` shows `Portal API listening on 4000 (country <code>)`; `curl -fsS $DEN_PUBLIC_URL/api/v1/health` → `{"status":"ok"}` |
| `web` | — | Nothing | Open `$DEN_PUBLIC_URL` and sign in |
| `citizen-app` | — | Nothing | Open `$DEN_PUBLIC_URL/citizen-app` |
| Reverse proxy | — | Configure the routes from DEPLOYMENT §5.2 **without** `/api/v1/internal` or `/api/v1/opa` | `curl -i $DEN_PUBLIC_URL/api/v1/opa/bundle.tar.gz` must **not** reach the API (404 from the proxy or the web) |

Overall status at a glance: `dc ps` (all `running`, and `healthy` those that have a health check; `tsa-init` in `exited (0)`).

### 2.2 End-to-end check

1. **Gateway without a token.** With a published API, `curl -i $DEN_GATEWAY_PUBLIC_URL/<route>` responds `401`. With no API published, APISIX responds `404`.
2. **Reconciled routes.**
   ```bash
   dc exec api sh -c 'wget -qO- --header "X-API-KEY: $APISIX_ADMIN_KEY" http://apisix:9180/apisix/admin/routes'
   ```
   Each published version has a route `den-route-<apiVersionId>`. With `.../apisix/admin/ssls` you can see `den-ssl-gateway` (the gateway's TLS) and one `den-ssl-gateway-client-<entityId>` per provider with mTLS upstreams.
3. **Full demo rehearsal** (`scripts/demo.mjs`, the 11 steps of `DEMO.md`). On the pilot it is run on the same machine, because it reads the mock's logs with `docker logs`:
   ```bash
   # once: build the open verifier (step 11)
   pnpm --filter @den/transparency-verifier build      # or inside a node:24 container
   set -a; . ./.env; set +a
   DEN_API_URL=$DEN_PUBLIC_URL \
   CITIZEN_APP_TSA_ROOT_URL=$DEN_PUBLIC_URL/tsa/api/v1/timestamp/certchain \
   node scripts/demo.mjs
   ```
   It exits with code 0 if everything behaves as the script says. It creates its own API on each run, so it can be repeated.

### 2.3 Functional configuration

| What | Where | When it takes effect |
| :-- | :-- | :-- |
| Country: authorities, document types, sectors, purposes, texts, `features`, validity periods, retention | `config/country/<code>.yaml` (`DEN_COUNTRY`); validated at startup | It is baked into the images: **rebuild** `api` and `web`. Purposes are loaded or refreshed with the seed |
| Additional purposes | Operator console → Purposes (`purpose.manage`) | Immediately |
| Entities | The requester registers and requests onboarding for their entity; a `platform_reviewer` or `platform_admin` approves it (`entity_review.decide`) and the requester becomes `entity_admin`. The `platform_admin` can also create them from the console (`entity_admin.create`) and suspend, reactivate or offboard them (`entity_admin.decide`) | Immediately |
| People in an entity | The `entity_admin` invites them by email and assigns roles (ADR-0018) | Immediately; roles are read on every request |
| Platform roles | The seed gives them to the demo users (`infra/keycloak/README.md`). The operator's own people get theirs from the server's command line, after they register and sign in once: `sudo ./install.sh platform-role grant <email> <role>` in the pilot, `node dist/admin/platform-roles-cli.js grant <email> <role>` in the API container elsewhere (`revoke`, `list`). Audited (`platform_role.granted`, `platform_role.revoked`); the last `platform_admin` cannot be revoked | Immediately; the second factor is asked at the person's next sign-in |
| Demo users (pilot) | `sudo ./install.sh demo-users disable [--reason "..."]`, `node dist/admin/demo-users-cli.js disable` in the API container elsewhere (`list` shows their state). Each demo user of the realm file is disabled in Keycloak (sessions ended) and in the portal, and loses its platform roles; audited (`user.disabled`, `platform_role.revoked`). It refuses while no active `platform_admin` other than the demo users exists, and changes nothing if Keycloak does not answer. It needs `KEYCLOAK_ADMIN_USER` and `KEYCLOAK_ADMIN_PASSWORD` in the API container (the pilot's `.env` has them). No command undoes it | Immediately; the seed leaves them disabled on every start |
| Self-registration | Realm `den-portal`: `registrationAllowed` and `verifyEmail`; the verification link lasts 60 minutes (`actionTokenGeneratedByUserLifespan`, P-08) | Already active on new realms; on an existing one, §5.3 |

> **Warning.** The pilot always loads the demo seed, with fictitious entities and demo users that keep their platform roles. Giving the operator's people their own accounts and roles with the command above does not remove them: `demo-users disable` does, once they have them. Even then a pilot is a demonstration environment, not a production one (`DEPLOYMENT.md §8`). After it, the demo rehearsal (§2.2) no longer runs on that installation.

## 3. API background processes

They all run inside the `api` process. With `DEN_WORKER=off`, none of them runs.

| Process | Frequency | What it does | If it fails |
| :-- | :-- | :-- | :-- |
| Outbox relay | 1 s | Moves the `outbox` rows to pg-boss queues | The rows stay without `published_at` and are retried |
| `gateway.sync` | When an API version changes | APISIX reconciler: routes, upstreams and plugins of that version | pg-boss retries; the error is stored in `sync_state` |
| Full APISIX reconciliation | At startup and every 5 min | Ensures the gateway's TLS (and renews its certificate), recomputes all served versions, with the gateway client certificates they need, and deletes orphans | Recorded per version and per SSL object; the next pass corrects it |
| `keycloak.sync` | When an application or its secrets change | Keycloak reconciler: `den-app-<uuid>` clients in `den-gateway`, secrets and their rotation (rotated secret during the window) | Same as APISIX |
| Full Keycloak reconciliation | At startup and every 5 min | Corrects drift in all clients | — |
| `policy.sync` | When subscriptions, versions or application certificates change | Updates OPA's sync state; the bundle is generated when OPA requests it | Subscriptions stay "Approved (activating)" until OPA reports the revision |
| `notification.dispatch` | Per audit event that triggers a notification | Notices in the portal and by email | pg-boss retries |
| `invitation.email` | Per invitation | Invitation email | Retries for hours |
| `audit.anchor_email` | Per anchor | Email of the daily anchor to the regulators | Retries |
| `citizen.alert` | Per new record with a notice requested | Signed webhook to the citizen application (`DEN_CITIZEN_APPS`) | Up to 20 retries with exponential backoff (max. 1 h) |
| Subscription lifecycle | `DEN_LIFECYCLE_INTERVAL_SECONDS` (300 s) | Marks expired ones as `expired` and sends renewal notices | — |
| Version lifecycle | Same | Retires deprecated versions whose retirement date has passed (ADR-0019) | — |
| Credential lifecycle | Same | Sends notices before certificates expire and marks them `expired`; closes expired rotation windows (the previous credential becomes `expired`) | — |
| Audit log anchoring | `DEN_AUDIT_ANCHOR_INTERVAL_SECONDS` (3600 s) | Timestamps with the TSA the last event of each closed day (country time zone) | If the TSA does not respond, it retries on the next round. Advisory lock: only one node anchors |
| Transparency sealing | `DEN_TRANSPARENCY_SEAL_INTERVAL_SECONDS` (10 s) | Groups records into Merkle batches (up to `DEN_TRANSPARENCY_BATCH_MAX`), signs and timestamps them with the TSA | The batch stays pending and is retried. Only one node seals |
| Transparency purge | Every 6 h | Deletes records older than `retention.subjectAccessMonths` (never less than the database floor) | — |

## 4. Operating routine

### 4.1 Daily checks

| What | How | Expected |
| :-- | :-- | :-- |
| Services | `dc ps` | Everything `running`/`healthy` |
| Gateway sync | SQL 1 (§4.2) | No rows in `error` or `drift`; `pending` only for a few seconds |
| Outbox | SQL 2 | No rows pending for more than a minute |
| OPA bundle | `dc exec api wget -qO- 'http://opa:8181/health?bundles'` | 200 |
| Audit chain | Console → Audit → "Verify integrity", or `GET /api/v1/audit/verify` (`audit.read`) | Chain intact; each closed day with its anchor |
| Transparency log | `GET /api/v1/transparency/verify` (`audit.read`); `?fromSeq=N` to review only what is new | No records tampered with, deleted early or inserted |
| Fluent Bit buffer | `dc exec api wget -qO- http://fluent-bit-transparency:2020/api/v1/metrics` | No accumulated retries |
| Disk | `docker system df -v` | `den_*` volumes with headroom |

Since M5-06, the alerts in `ARCHITECTURE.md §9` reach the operator by email (Alertmanager), and the Grafana dashboard `DEN · Operador` summarizes the status. This list remains for manual review and for when the `observability` profile is missing. Sync is also visible at `/operator/sync` (M5-07).

| Alert | First action |
| :-- | :-- |
| `DenGateway5xxRate` | `dc logs fluent-bit-errors` (gateway errors, masked); the affected provider's usage (`/my-apis/usage`) |
| `DenGatewayLatencyHigh` | The latency panel: if the full request goes up but the gateway's share does not, it is the provider |
| `DenTargetDown` | `dc ps` and the service's logs |
| `DenOpaBundleBehind`, `DenOpaBundleFetchFailing` | `dc logs opa`; that OPA reaches `OPA_PORTAL_URL` with its token |
| `DenReconcileFailing` | `/operator/sync`, filter "With problems": the last error, and retry |
| `DenNodeOffline` | `/operator/nodes`; the entity that owns the node gets its own notice |
| `DenCertificateExpiring` | Automatic renewal failed: API logs and `dc ps step-ca` |
| `DenQueueBacklog` | API logs; SQL 2 (§4.2) |

### 4.2 Diagnostic queries

With the schema owner (read-only in practice; do not modify data by hand):

```bash
dc exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

```sql
-- 1. Objects out of sync (apisix | keycloak | opa)
SELECT target, system, status, attempts, last_error, updated_at
FROM sync_state WHERE status <> 'in_sync' ORDER BY updated_at;

-- 2. Outbox messages not yet relayed
SELECT topic, aggregate, attempts, last_error, created_at
FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 50;

-- 3. Latest OPA bundle revisions
SELECT revision, cardinality(subscription_ids) AS subscriptions, created_at
FROM policy_bundle ORDER BY created_at DESC LIMIT 5;

-- 4. Latest anchors and checkpoints
SELECT * FROM audit_anchor ORDER BY 1 DESC LIMIT 3;
SELECT seq, tree_size, sealed_at FROM transparency_checkpoint ORDER BY seq DESC LIMIT 3;
```

### 4.3 Logs

| Service | Command | Notes |
| :-- | :-- | :-- |
| API | `dc logs -f api` | Reconciliation, CA and TSA errors |
| OPA | `dc logs opa` | Bundle download (`--log-format=json`); no decision logs, on purpose |
| APISIX | `dc logs apisix` | Startup only. No access log (privacy), and its errors go to `fluent-bit-errors` |
| API refusals | `dc logs api \| grep request_refused` | One JSON line per 400/401/403/404/409/429: `sub`, IP, route and code (M6-01). A streak of 403/404 from the same `sub` or IP is probing |
| Keycloak sign-ins and administration | `dc logs keycloak \| grep -E "type=(LOGIN\|LOGOUT\|REGISTER)"` | Events of the `den-portal` realm (M6-01); 90 days in the Keycloak database |
| Gateway errors | `dc logs fluent-bit-errors` | The nginx error log, with the request line, the upstream URI and numbers masked (M5-01) |
| Keycloak | `dc logs keycloak` | Startup and realm import |

Logs do not contain bodies, real paths or query strings, and must not contain them. If you see a document number in a log, it is a privacy incident (rule 2 of `CLAUDE.md`).

## 5. One-off tasks

### 5.1 Restarting a component

| Component | Impact while it is down | When it comes back |
| :-- | :-- | :-- |
| `api` | No portal; the gateway keeps the last configuration; transparency records wait in the Fluent Bit buffer | Migrations, full reconciliation, drains the outbox |
| `web` | No portal; the API keeps running | — |
| `keycloak` | Nobody can sign in and no application tokens can be issued. Validating current tokens (5 min) depends on APISIX's JWKS cache (untested, M6-04) | — |
| `apisix` | No traffic | Reads the configuration from etcd |
| `etcd` | APISIX keeps what it has in memory, with no new changes | — |
| `opa` | No traffic (the gateway cannot decide) | Downloads the bundle in 10–20 s |
| `step-ca` | No certificates are issued (503 in the portal) | — |
| `tsa` | No batches or anchors are sealed (they stay pending) | They are sealed on the next round |
| `fluent-bit-transparency` | APISIX retries sending | Resends what is in the disk buffer |
| `postgres` | The whole governance plane goes down; traffic continues | — |

```bash
dc restart <service>        # or: dc up -d <service> if its configuration changed
```

### 5.2 Forcing reconciliation

In the sync console (`/operator/sync`, M5-07), a `platform_admin` retries an object: its reconciler's job is queued. The console also shows the drift that was found, that is, changes made outside the portal that the reconciler undid. Restarting the API triggers a full reconciliation of APISIX and Keycloak; otherwise, the periodic pass runs every 5 minutes. APISIX and Keycloak are **never** corrected by hand: the reconciler reverts it (rule 5).

The console also lists, under "Versions on a channel no longer accepted", the versions whose upstream type the country configuration (`features.upstreams`) or the deployment (X-Road settings) no longer accepts (P-04, ADR-0029). They keep working. The operator decides: keep them, ask the entity for a new version through the node (the old one cannot be revised), or accept the type again in the country configuration, which needs a new API image.

Under "Nodes not serving the published contract", the console lists the published versions whose node reports, for the version's service path, an OpenAPI other than the published one (with both SHA-256 and since when), or none (P-02, `ARCHITECTURE.md §10`). Traffic is not affected: the gateway keeps routing by the published contract. The entity's publishers and admins are notified when a version goes from matching to differing, and see the same on the version sheet and the node page. What to do is the entity's call: publish a revision or a new version with what the node serves, or put the published OpenAPI back on the node. "Not reported" means the node declares no service on that path, or the service has no OpenAPI on the node (its log shows `(unknown)` routes): the entity sets `openapi` in the service's file on the node.

### 5.2.1 Synthetic traffic for demos

`pnpm traffic:simulate [--from YYYY-MM-DD] [--days 30] [--scale 1] [--seed 42]` generates a month of simulated calls from the active production subscriptions, to show the indicators, the usage and the exchange map without real traffic. The calls follow a business-day and office-hours pattern, with denials and their reasons, and provider errors.

- **Where they go.** It writes documents shaped like the access log into `den-access-synthetic-YYYY.MM`, with `gateway_node: synthetic`. They never make real calls or carry personal data.
- **Deleting it.** `--clear` deletes everything; `--tag` keeps it separate (the tests use their own).
- **Restriction.** Development and demos only: in production it requires `DEN_ALLOW_SYNTHETIC_TRAFFIC=true`. On the pilot it is run inside the API container.

### 5.2.2 Gateway load test (M6-03)

Measures whether the gateway sustains the load in SPEC §9: 500 requests/s, with a p95 of the latency the gateway adds (excluding the provider) under 50 ms. Results, findings and sizing in `docs/performance/M6-03.md`.

1. **The network at scale.** `pnpm load:seed` creates, if they do not exist, 200 entities, 1,000 published APIs, 200 applications and 5,000 subscriptions. They are synthetic (prefix `carga-`) and audited like any other change. It takes about 2 minutes, and the reconcilers take a few more minutes to create the routes, the clients and the OPA data.
   - Their APIs use the test service: `DEN_DEV_NODES` includes `carga-*=mock-salud:8000`.
   - In an environment with `NODE_ENV=production`, `DEN_ALLOW_LOAD_SEED=true` is required. Never on the data of a real network: the synthetic entities would appear in the catalog, the indicators and the audit log.
2. **The test.** `pnpm load:test [--rate 500] [--duration 5m] [--warmup 30s] [--seed]`:
   - prepares, like the demo, a published API and an application with a certificate and an approved subscription;
   - launches k6 (`grafana/k6:2.3.0`, in its own container) against `DEN_GATEWAY_PUBLIC_URL` with mTLS;
   - reads in Prometheus (`DEN_PROMETHEUS_PUBLIC_URL`, by default `http://localhost:9090`) the latency that APISIX measures for its route.
   It exits with 1 if the target is not met. `DEN_LOAD_DEBUG=1` shows the first failures of each k6 virtual user.
3. **Where to run it.** k6 needs its own CPU: on the same machine as the gateway it competes with it, and the result measures the machine, not the gateway. The criterion is validated in the production-like environment at the close of M6.

### 5.2.3 Resilience test (M6-04)

`pnpm resilience:test [--outage 45s] [--portal-container den-api-1]` checks against the stack that the gateway works without the portal:

1. Prepares an application with an active subscription, like the demo.
2. Stops the portal and, during the outage, alternates allowed and denied calls.
3. Restarts OPA and APISIX without the portal.
4. Brings it back and checks that the transparency log has every call from the outage and that a revocation reaches the gateway again.

Result in `docs/performance/M6-04.md`.

- **Pilot.** It stops and starts the API container. During the test the portal does not respond to anyone: it is a real outage.
- **Development.** The API runs on the host. The script starts its own from `apps/api/dist` (build it first) and requires `pnpm dev` to be stopped.

**What to expect in a real portal outage.** Traffic continues with the last state OPA had. The alerts `DenTargetDown` (the API does not respond to Prometheus) and `DenOpaBundleFetchFailing` (more than 2 min without a bundle) notify the operator. Whatever is approved or revoked in the portal does not reach the gateway until it comes back. To cut off a compromised application right away without the portal, disable its client in Keycloak: without a new token, its calls are denied when the one it has expires (5 minutes).

### 5.3 Changes to an existing Keycloak realm

The import does not touch realms that already exist. Changes are applied with `kcadm.sh`:

```bash
dc exec keycloak sh -c '/opt/keycloak/bin/kcadm.sh config credentials \
  --server http://localhost:8080/auth --realm master \
  --user "$KC_BOOTSTRAP_ADMIN_USERNAME" --password "$KC_BOOTSTRAP_ADMIN_PASSWORD"'
# example (M2-01): self-registration with email verification
dc exec keycloak /opt/keycloak/bin/kcadm.sh update realms/den-portal \
  -s registrationAllowed=true -s verifyEmail=true
```

In development the server is `http://localhost:8080` (without `/auth`).

**Secret rotation policy (M3-04).** It is applied from the realm JSON, without deleting data, with an idempotent script:

```bash
set -a; . ./.env; set +a
node scripts/keycloak-client-policies.mjs     # KEYCLOAK_URL and the master administrator
```

On the pilot, `KEYCLOAK_URL` is the public URL (`$DEN_PUBLIC_URL/auth`). Check: in the Keycloak console, realm `den-gateway` → Client policies, `den-secret-rotation` appears as active.

**With `install.sh` (pilot).** `sudo ./install.sh realms` runs this script and `keycloak-portal-mfa.mjs` (without `--demo-otp`) in a Node container on the Compose network, with the internal Keycloak URL (`DEN_GATEWAY_KEYCLOAK_URL`) and the `master` administrator of `.env`. `sudo ./install.sh update` runs it after restarting; if it fails, it says so and the update goes on.

**Second factor (M3-08, ADR-0021).** The `den-browser` login flow and the level map are also applied from the JSON, with an idempotent script:

```bash
set -a; . ./.env; set +a
node scripts/keycloak-portal-mfa.mjs              # flow, acr map and OTP policy
node scripts/keycloak-portal-mfa.mjs --demo-otp   # also the demo users' codes
```

- `--demo-otp` is for development and the pilot only. It reimports from the JSON, with the same id, each seed user with a critical role that does not yet have a code: it sets the password from `DEN_DEMO_USER_PASSWORD` and the code from `DEN_DEMO_TOTP_SECRET` again. A demo user disabled in Keycloak (`demo-users disable`) is skipped, so it is not enabled again.
- **Verification link (P-08).** The same script sets how long the email verification and password reset links last (`actionTokenGeneratedByUserLifespan`, 60 minutes; Keycloak's default is 5).
- Check: in the Keycloak console, realm `den-portal` → Authentication, `den-browser` is bound to the browser flow. `pnpm demo:otp` prints the current code for the demo users and the key for an authenticator app.
- **Credential notice.** Keycloak writes to the account owner when a password or a second factor is set or removed, and keeps those events for 90 days (realm `den-portal` → Events). If someone says they did not enroll the second factor mentioned in the notice, treat it as an incident: disable the account in Keycloak, delete the OTP credential and reset the password before enabling it again.
- **Lost second factor.** The Keycloak administrator deletes the person's OTP credential (Users → the person → Credentials). The next time the portal asks for the code, Keycloak asks them to enroll a new app. First verify the identity of whoever asks for it, through a channel other than the account's email.

### 5.4 CA root fingerprint

```bash
dc exec step-ca step certificate fingerprint certs/root_ca.crt
```

This is the value of `DEN_STEP_CA_ROOT_FINGERPRINT` for an API that does not mount the CA volume.

### 5.5 Application credentials

Rotating and revoking the applications' secrets and certificates is done by their developers from the application page (M3-04); the operator does not step in.

- During a rotation, the previous secret or certificate keeps working for `lifecycle.credentialRotationDays`.
- Revoking a certificate removes it from the gateway with the next bundle download (10–20 s).
- Revoking a secret removes it from Keycloak when the reconciler runs (`keycloak.sync`, seconds).
- If a revocation does not take effect, check SQL 1 (§4.2) with `system = 'keycloak'` or `'opa'`.

### 5.6 Rotating platform secrets

| Secret | How to rotate it today |
| :-- | :-- |
| `APISIX_ADMIN_KEY`, `OPA_BUNDLE_TOKEN`, `DEN_TRANSPARENCY_INGEST_TOKEN` | Change it in `.env` and recreate the services that use it at the same time (`apisix` + `api`; `opa` + `api`; `fluent-bit-transparency` + `api`) |
| `AUTH_SECRET` | Change it and recreate `web`: all sessions are closed |
| Keycloak client secrets (`DEN_PORTAL_WEB_CLIENT_SECRET`, `DEN_GATEWAY_PROVISIONER_SECRET`, `DEN_CITIZEN_APP_CLIENT_SECRET`) | Change the client secret in Keycloak (console or `kcadm`) **and** in `.env`, and recreate `web`, `api` or `citizen-app` |
| PostgreSQL passwords | `ALTER ROLE ... PASSWORD` **and** `.env` (with its URLs), and recreate the services |
| `DEN_TRANSPARENCY_SIGNING_JWK` | New key with a different `kid`; the old public key goes to `DEN_TRANSPARENCY_RETIRED_JWKS`. Full procedure for production still pending |
| Gateway certificates (server, and clients towards providers) | The APISIX reconciler renews them on its own; to force it, restart the API after deleting the matching `gateway_certificate` row |
| `DEN_SECRETS_KEY` (seals pending client secrets and the gateway's private keys) | 1. Generate the new one (32 bytes base64), put it in `DEN_SECRETS_KEY` and move the old one to `DEN_SECRETS_KEYS_PREVIOUS`. 2. Recreate the API (`dc up -d api`): new values are sealed with the new key and old ones can still be opened. 3. Reseal: `dc exec api node dist/secrets/main.js` (in development, `pnpm --filter @den/api secrets:reseal`). It is idempotent and leaves `secrets.resealed` in the audit log. 4. Empty `DEN_SECRETS_KEYS_PREVIOUS` and recreate the API. If the reseal finds a value that no key opens, it stops without changing anything else: a previous key is missing |
| Gateway assertion signing key (M6-10) | The portal rotates it on its own every `lifecycle.assertionKeyRotationDays` (90 days); the previous one stays in the JWKS. To rotate it now: `POST /api/v1/admin/gateway-signing-keys/rotate` as `platform_admin`; with `"compromised": true` the previous one is removed from the JWKS (`RUNBOOK.md §2.2`) |
| `DEN_SUBJECT_REF_KEY`, `DEN_END_USER_HASH_SALT` | **Not rotated**: they break the link with earlier records (`DEPLOYMENT.md §4.1`) |
| Intermediate CA | `RUNBOOK.md §3` |

### 5.7 A new version of the node kit (P-03)

The kit is released in its own repository. When it publishes a release, as `platform_admin` (with the second factor):

1. **Operator console → Node kit → Set the current version:** the version (`0.2.0`), the link to the bundle asset (`https://…/den-node-kit-0.2.0.tar.gz`), its size in bytes and its SHA-256 (the release's `.sha256` file, or `sha256sum` of the downloaded file). Saving makes it current at once on every entity's _Kit nodes_ page and on `/kit`; the audit log records `kit_release.created` and `kit_release.made_current`.
2. **Mirror (optional)**, for entities whose servers reach the portal but not GitHub: in the version's row, choose the downloaded bundle and **Upload to the mirror**. The portal accepts it only with that size and SHA-256 and serves it at `<portal>/kit/<version>/<file>` (and `<file>.sha256`), without a session; it cannot be replaced afterwards. The page then offers both links. A bundle larger than `DEN_KIT_BUNDLE_MAX_BYTES` (128 MiB) is refused: raise it on the API and recreate it, and check the proxy's body limit (`DEPLOYMENT.md §5.2`).
3. **Roll back:** **Make current** on an earlier version. **Correct** a version (wrong link, size or checksum) with its form; once mirrored only the signature fields can change.
4. Give each entity the checksum (and, once releases are signed, the operator's key) **through another channel** as well, for example the agreement: whoever controls the portal controls both the file and the checksum it shows.

The development seed sets v0.2.0 as current only while the portal has no release at all.

## 6. Backups

The `den` and `keycloak` databases are backed up with pgBackRest on the pilot and with Barman Cloud on Kubernetes (ADR-0026). Both let you go back to any instant within the retention period, not just to the last backup.

### 6.1 Pilot (Compose): pgBackRest

- **Continuous.** PostgreSQL archives every WAL segment to the `pgbackrest-repo` repository, at least every 5 minutes: at most 5 minutes of changes are lost. The repository is encrypted (AES-256) with `PGBACKREST_REPO1_CIPHER_PASS`.
- **Scheduled.** The `pgbackrest` service takes a full backup on Sundays and a differential one on the other days, at 02:00 UTC (`DEN_BACKUP_FULL_DAY`, `DEN_BACKUP_HOUR`). It keeps four full backups: you can go back to any instant in the last month.
- **Status:** `dc exec pgbackrest pgbackrest --stanza=den info` shows the backups and the range of archived WAL. `dc logs pgbackrest` shows each backup. If `info` says anything other than `status: ok`, or the last backup is more than two days old, it needs looking into.

**The `PGBACKREST_REPO1_CIPHER_PASS` key is kept off the server**, with the copy of `.env`. Without it, no backup can be restored.

**The repository lives on the same server.** It does not protect against losing the disk or the machine. `sudo ./install.sh backup` copies everything to `backups/<date>/`, so it can be taken off the server:
- a full pgBackRest backup and the entire repository (`pgbackrest-repo.tgz`, already encrypted);
- the logical dumps `den.dump` and `keycloak.dump`, which can be used to restore on another PostgreSQL version or another platform (from the pilot to Kubernetes);
- the volumes and `.env` (table below).

Do it before every update and on a regular basis.

**Restoring the database** (`sudo ./install.sh restore`):

| Case | Command |
| :-- | :-- |
| Go back to the last archived state (the data volume was damaged or lost) | `sudo ./install.sh restore` |
| Go back to an instant (a deletion or a migration that went wrong) | `sudo ./install.sh restore "2026-11-20 14:30:00-05"` |

The command:
1. shows the backups;
2. asks for confirmation;
3. stops everything and restores the database with `pgbackrest --delta restore`, which only rewrites what changed;
4. starts again and takes a full backup on the new timeline.

Whatever was written after the chosen instant is lost. After restoring:
- check the audit chain (Console → Audit → "Verify integrity");
- check that nothing is out of sync with the gateway (§4.2). The reconcilers bring APISIX, OPA and Keycloak to the state of the restored database.

**If the server was lost:** install the portal on another one (`INSTALL.md`) with the saved `.env`. Before the first start, restore the `pgbackrest-repo` volume from `pgbackrest-repo.tgz` and the other volumes from their `.tgz` files. Then run `sudo ./install.sh restore`.

**Testing the procedure:** `pnpm restore:test`, also in CI. It uses the same image and the same commands, in separate containers. It tests losing the data volume, point-in-time recovery, a backup after restoring, and that the repository cannot be read without its key.

**Other data** that `install.sh backup` saves separately:

| What | Why | How to restore it |
| :-- | :-- | :-- |
| `step-ca-data` volume | The CA's keys: without it, every certificate is orphaned | `docker run --rm -v den_step-ca-data:/v -v "$PWD":/b alpine tar xzf /b/step-ca-data.tgz -C /v`, with the service stopped |
| `tsa-data` volume | Chain and key of the development TSA (timestamps already issued are verified with the chain) | Same, with `den_tsa-data` |
| `api-documents` volume | Uploaded documents (designations, agreements) | Same, with `den_api-documents` |
| `.env` | Keys without which the data cannot be verified, pseudonymized the same way or restored | Encrypted copy off the machine |

There is no need to back up `etcd-data` (it is rebuilt from PostgreSQL), OPA (it only keeps a copy of the bundle) or `opensearch-data` (analytics, can be lost). `transparency-buffer` only holds what has not yet reached the API.

### 6.2 Kubernetes: Barman Cloud

The `den` chart archives the WAL and takes a daily base backup of both databases (`den-db` and `den-keycloak-db`) to the operator's S3-compatible storage (`postgres.backup`, `DEPLOYMENT.md §9.5`). Retention is 30 days by default.
- **Status:** `kubectl get backups,scheduledbackups -n den`, and on each `Cluster` the `ContinuousArchiving` and `LastBackupSucceeded` conditions (`kubectl cnpg status den-db`).
- **Restore:** create a new `Cluster` with `bootstrap.recovery`, with the `den-db-backup` `ObjectStore` as the source (plugin `barman-cloud.cloudnative-pg.io`, `serverName` = name of the original cluster). To go back to an instant, add `recoveryTarget.targetTime`. Then point the API (or Keycloak) to the new cluster.
- **Test:** the procedure has not been tested on a cluster: the chart has not been installed (M6-05). It is tested on the first installation, against the operator's real storage.

## 7. Common problems

| Symptom | Probable cause | What to do |
| :-- | :-- | :-- |
| The gateway responds `403` to everything, even with a subscription | OPA without a bundle: the API cannot build it (`DEN_SUBJECT_REF_KEY` or `DEN_END_USER_HASH_SALT` is missing, too short or the example value) or OPA cannot reach `OPA_PORTAL_URL` | `dc logs opa`, `dc logs api`; check those variables and `OPA_BUNDLE_TOKEN` |
| Subscription "Approved (activating)" that does not become "Active" | OPA did not download or report the new revision | OPA's `health?bundles`; SQL 1 with `system = 'opa'` |
| Published API that does not appear on the gateway (`404`) | APISIX reconciler error | SQL 1 with `system = 'apisix'`; `dc logs api`; check `APISIX_ADMIN_URL` and `APISIX_ADMIN_KEY` |
| The application does not become "Ready" | Keycloak reconciler error | SQL 1 with `system = 'keycloak'`; check `KEYCLOAK_URL` and `DEN_GATEWAY_PROVISIONER_SECRET` (it must match the realm's) |
| `api` exits at startup with a configuration message | `DEN_COUNTRY` has no value or the country YAML is invalid | Fix the YAML and rebuild the image |
| `api` does not start: migration error | Failed migration, or the database is not reachable as owner | `dc logs api`; `dc exec api node_modules/.bin/prisma migrate status` |
| Uploading a document fails with 503 ("the antivirus did not respond") | `DEN_CLAMAV_URL` is set and ClamAV does not respond: starting up (it downloads signatures for a few minutes), down or out of memory | `dc ps clamav`, `dc logs clamav`; wait until it is healthy. Without antivirus, remove `DEN_CLAMAV_URL` and recreate the API (documents will only be checked as PDF) |
| Uploading a document fails ("We could not complete the operation"); the API log says `EACCES: mkdir '/repo/apps/api/data'` | `.env` has the development value `DEN_DOCUMENTS_DIR=data/documents` (deployments generated before P-06) and the API runs a deploy overlay without the fixed value | `sudo ./install.sh update` corrects it; by hand, set `DEN_DOCUMENTS_DIR=/var/lib/den/documents` in `.env` and recreate the API (`dc up -d api`). Uploads that failed must be repeated |
| Certificates are not issued (503) | step-ca down, different provisioner password, or root not configured with `NODE_ENV=production` | `dc logs api` (`step-ca: ...` messages); `DEN_STEP_CA_PROVISIONER_PASSWORD` = `STEP_CA_PASSWORD`; `DEN_STEP_CA_ROOT_FILE` |
| `sync_state` in error for `apisix:ssl:...` | step-ca does not respond, the `den-gateway-tls` provisioner is missing (step-ca not recreated) or `DEN_SECRETS_KEY` changed | `dc logs api`; `dc up -d step-ca`; §5.6 |
| `direct` upstream that responds 502 | The gateway now verifies the provider's certificate (expired, self-signed or for another name), or the provider with mTLS does not accept `CN=den-gateway.<slug>` | Ask the provider for a valid public certificate for its name, or to trust the network CA and that name |
| An application gets 429 `rate_limited` before its limit | With several gateway nodes, the limit is split between them (`DEN_GATEWAY_NODES`) and load balancing is uneven (ADR-0020) | Check that `DEN_GATEWAY_NODES` is the real number of nodes; balance by source hash |
| The gateway responds 500 to allowed calls | `limit-count` without a positive integer limit (old OPA bundle, without `X-DEN-Rate-Limit`) | OPA's `health?bundles`; that the API serves the current bundle |
| When a secret is rotated, the old one stops working right away | The rotation policy is missing from the existing `den-gateway` realm | §5.3 |
| The citizen does not see their queries | Records stuck in Fluent Bit (collector token or host) or the operation does not declare a data subject | `dc logs fluent-bit-transparency`; `DEN_TRANSPARENCY_INGEST_TOKEN` and `DEN_TRANSPARENCY_COLLECTOR_HOST` |
| Queries that stay "Being sealed" | The TSA does not respond or `DEN_TRANSPARENCY_SIGNING_JWK` is missing | `dc logs api`; `dc ps tsa` |
| Sign-in loops or issuer error | `KC_HOSTNAME`, `KEYCLOAK_URL` or `AUTH_URL` do not match the public URL | Check `DEN_PUBLIC_URL` and the derived URLs (`DEPLOYMENT.md §4.2`) |
| A change in a realm JSON does not show up | The import ignores existing realms | §5.3 |
| OpenSearch does not start | `vm.max_map_count` too low or too little memory | `DEPLOYMENT.md §2` |
