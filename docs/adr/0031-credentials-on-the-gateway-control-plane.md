# ADR-0031 — Credentials on the gateway's control plane, and only the gateway reaches its log inputs

- Status: Accepted
- Date: 2026-11-19
- Story: R-02 (`docs/BACKLOG.md`), findings B-15 and B-17 of the 2026-11 general review

## Context

In the Compose stack (development and the single-host pilot), the gateway's control plane relied on network segmentation alone (M6-01):

- **OPA** listened on `opa:8181` without authentication. Any container on the `gateway` network (Keycloak, the Fluent Bits, Prometheus and, in the pilot, the API) could read `data.config`, with the pseudonym key and the official's salt, replace a policy, or ask for decisions with a forged token and get the pseudonym of any document number.
- **etcd** listened on `etcd:2379` without authentication: the same containers could read and rewrite the gateway's routes, upstreams and plugin metadata.
- **The Fluent Bit inputs** (HTTP 9880 for analytics, TCP 5170 for the transparency register, syslog 5140 for the error log) were on `default` and `gateway`: any container of the platform could inject fake access records or fake consultations of a citizen's data.

The Helm chart already avoids the three: OPA listens on loopback inside the gateway's pod (its diagnostic listener serves only `/health` and `/metrics`), etcd requires mutual TLS (`--client-cert-auth`), the transparency and error Fluent Bits are sidecars of that pod, and NetworkPolicies let only the gateway's pods reach the analytics Fluent Bit.

Constraints found in the pinned versions:

- The `opa` plugin of APISIX 3.19 sends no header of its own to OPA (only `Content-Type`), and `lua-resty-http` 0.16 ignores credentials in the URL. It calls `{host}/v1/data/{policy}` with `policy` taken as is.
- etcd 3.6 refuses every anonymous call once authentication is on, health checks included, and its image has no shell to script a bootstrap.
- Fluent Bit 5.1.5's `http` and `tcp` inputs have no authentication (only TLS, and APISIX's `http-logger` and `tcp-logger` cannot present a client certificate).

## Decision

1. **OPA's API needs a token** (Compose). OPA runs with `--authentication=token --authorization=basic` and a fixed policy, `infra/opa/authz.rego` (`system.authz`), loaded from a file outside the bundle's roots, so the bundle cannot change it:
   - `GET /health` and `GET /metrics` stay open (they carry no data): the health check and Prometheus.
   - The gateway may only query rules named `decision` (`POST /v1/data/.../decision`), with the decision token `DEN_OPA_DECISION_TOKEN` in the `den_token` query parameter. The reconciler writes it into each route's `opa.policy` (`den/authz/decision?den_token=…`); OPA logs the path without the query.
   - Everything else (reading data, policies, configuration) needs the admin token `DEN_OPA_ADMIN_TOKEN` as a bearer token: the operator and the integration tests.
   - Tokens have at least 32 characters. A route without the token gets a 401 from OPA, which the plugin turns into 503: it fails closed.
2. **etcd requires credentials** (Compose). A one-shot `etcd-init` container (etcdctl on the step-ca image the stack already uses) runs `infra/etcd/init.sh` before APISIX on every start. It is idempotent: on an etcd without authentication (new, or created by an earlier version) it creates the user `apisix`, whose role reads and writes only `/apisix`, the user `root` and a user `healthcheck` without any role, then turns authentication on. On later starts it checks the same users and role exist and puts APISIX's password back to the one in `.env` if APISIX can no longer log in. APISIX logs in as `apisix` (`deployment.etcd.user` and `password`). The health check logs in as `healthcheck`, whose password is public on purpose: it can read or write nothing, and `endpoint health` takes "permission denied" as healthy.
3. **Only the gateway reaches the Fluent Bit inputs** (Compose). A `logs` network joins APISIX and its three Fluent Bits, which are on no other network but the one each needs to deliver: `analytics` (the analytics Fluent Bit and OpenSearch) and, in the pilot, `collector` (the transparency Fluent Bit and the API). The inputs themselves stay without authentication.
4. **The Helm chart keeps its model**: loopback OPA, etcd with mTLS, sidecars and NetworkPolicies. `DEN_OPA_DECISION_TOKEN` is not set there, and the routes carry no token.
5. **Existing deployments.** `make-deploy-env.mjs` generates the four new secrets; `install.sh` adds them to an existing `.env` (`ensure_env_additions`, on install, `update` and `start`), and `update` now continues with the installer it just pulled. The next `up` runs `etcd-init`, which turns etcd's authentication on without touching its data, and recreates OPA and APISIX. Until the new API rewrites the routes with the decision token, the gateway answers 503 (seconds: the API reconciles every route on start).

## Alternatives considered

- **OPA on loopback in APISIX's network namespace** (`network_mode: service:apisix`), as in the Helm pod. Compose would recreate APISIX and OPA together, the development tests that load policies into OPA from the host would need APISIX's port mapping, and a restart of APISIX would cut OPA off. The token keeps OPA a service of its own.
- **A custom APISIX plugin, or a local proxy that adds the token as a header.** More code to maintain in the hot path for the same effect; the query parameter is supported by the stock plugin and is not logged.
- **Network isolation for etcd instead of credentials.** It would leave the platform components on `gateway` (Keycloak, Prometheus, the API in the pilot) able to rewrite the gateway's configuration. With the idempotent init the bootstrap is a few etcdctl calls; the data stays.
- **mTLS for etcd in Compose**, as in Helm. It needs a CA and certificates for a single-host pilot whose etcd is not exposed; credentials give the same separation between containers.
- **TLS with client certificates on the Fluent Bit inputs.** `http-logger` and `tcp-logger` cannot present one.

## Consequences

- No container on the gateway's network can read the pseudonym key, replace OPA's policy, ask OPA for pseudonyms, or change the gateway's configuration without a credential it does not have. No container but APISIX can send records to the log pipelines.
- The decision token is in each route's configuration (in etcd, now protected) and in OPA's input (`input.route`, never logged: decision logs stay off). Rotating it means changing `.env` and recreating `opa` and the API: the reconciler rewrites the routes.
- `ETCD_ROOT_PASSWORD` cannot change by editing `.env` once authentication is on: `etcd-init` stops with a message (`OPERATIONS.md`, etcd credentials). Since etcd only holds what the reconciler rebuilds from PostgreSQL, the way out is to recreate the `etcd-data` volume.
- The three Fluent Bits share `logs`, so each could reach another's input; they run our configuration only. OpenSearch can reach the analytics input, and the API the transparency one.
- What this does not cover: the containers that legitimately hold a credential (APISIX, the API) and anyone with access to Docker or to `.env`.
