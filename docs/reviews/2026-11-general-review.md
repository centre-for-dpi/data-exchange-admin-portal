# DEN Portal general review — November 2026

Spanish original: [docs/es/reviews/2026-11-general-review.md](../es/reviews/2026-11-general-review.md).

- **Date:** 2026-11-17
- **Reviewed commit:** `efdcb06` (branch `main`, clean tree at the start)
- **Method:** nine independent reviewers, one per area, checking the code against SPEC, ARCHITECTURE, AUTHZ, ADR 0001–0028 and the golden rules in CLAUDE.md. Each high finding then went to a second agent that did not know the conclusion and had to establish the facts on its own.
- **Scope:** review only. No code was changed and there are no commits. The tests written to prove findings are uncommitted (section 8).

Each finding carries an evidence label:

- **PROVEN**: a test or a run shows it. The text says which part.
- **INFERRED**: it comes from reading the full code path; it was not run.

---

## 1. Verdict

**The authorization core is well built. What fails is around it: the Compose pilot deployment, the completeness of the transparency log and the convergence of the APISIX reconciler.** There are no critical findings. There are five high findings, all verified by a second agent, and about thirty medium ones.

What was not found, despite looking for it explicitly:

- No IDOR and no cross-entity leak in the API endpoints.
- No bypass of traffic authorization: calling without a subscription, using another application's subscription, skipping purpose, validity or certificate.
- No domain state change without an audit event in the same transaction.
- No way to forge a transparency receipt or to verify one falsely.
- No path by which a request or response body ends up persisted.

### What would block going to production with real data

| # | Finding | Why it blocks |
| :-- | :-- | :-- |
| A-1 | Document upload fails in the pilot installed with `install.sh` | Entity registration with the designation PDF does not work. It affects the entities bootcamp. |
| A-2 | `api`, `web` and the citizen app all receive every secret; the API holds the credential of a PostgreSQL superuser | A flaw in any of the three hands over the database, the CA and the signing keys, and allows rewriting the audit log. |
| A-3 | Transparency batches larger than 32 KB are lost whole | Under sustained traffic, citizens stop seeing queries about their data and nothing warns about it. |
| A-4 | A consumer evades the transparency log with a long `X-Request-Id` | An entity can query a person without leaving a trace for that person. |
| A-5 | The reconciler deletes the X-Road client certificate on every pass | X-Road routes over HTTPS are down most of the time, and the console says they are synchronized. |

In addition, three medium findings weigh as blockers of the product's promise, although not of its operation:

- **M-14:** the accredited TSA cannot be connected; only the development one works, and the same operator runs it. The "not even the operator" guarantee of ADR-0016 does not hold in the pilot.
- **M-11:** the consumer's token reaches the provider. With `mtls.required: true` (Colombia) it is not reusable; with `false` it is.
- **M-03:** in production there is no audited way to create a regulator, a reviewer or an auditor, or to remove an administrator.

### Limits of this review

- **The findings were obtained without the stack running.** The integration and e2e tests were run afterwards, against the local stack; their results are in section 9. No finding was retested with real traffic through APISIX, OPA or Keycloak.
- **`install.sh` was not run in this review** (the author ran it the same day on a clean server, without errors) and the Helm charts were not rendered (`helm` is not installed).
- **These did pass:** `pnpm lint`, `pnpm typecheck`, `pnpm test` (248 API tests plus packages and infra), `pnpm test:policy` (68/68) and `pnpm license:check` (999 packages), run before the review tests existed.
- Section 6 details what was left unexamined.

---

## 2. High findings

### A-1 · Document upload fails in the pilot installed with `install.sh`

- **What is wrong:** the API receives `DEN_DOCUMENTS_DIR=data/documents`, a development value, and tries to write to a directory it cannot create.
- **Where:** `.env.example:46`; `scripts/make-deploy-env.mjs:82-185` (copies the line as is); `infra/compose/docker-compose.deploy.yml:199-204`; `apps/api/Dockerfile:30-35`; `apps/api/src/documents/storage.service.ts:16-19`.
- **Scenario:** `env_file` wins over the image's `ENV`. The API resolves `/repo/apps/api/data/documents`, which belongs to root, and runs as `node`. A person who requests their entity's registration with the designation PDF, or a consumer who uploads an agreement, gets an error. The `api-documents` volume stays empty, so `install.sh backup` would back up nothing.
- **Evidence:** PROVEN that the `api` container receives that value (generated `.env` and `docker compose config`). The permission error was reproduced in a container that imitates the Dockerfile's directory ownership, not in the real API image. The HTTP code the client sees was not checked.
- **Breaks:** DEPLOYMENT §3.10 and OPERATIONS §6.
- **Fix:** set `DEN_DOCUMENTS_DIR: /var/lib/den/documents` in the `environment:` of the `api` service in the deploy overlay, or comment out the variable in `.env.example`. Add the case to `make-deploy-env.test.mjs`.

### A-2 · All secrets in three containers, and the API with superuser credentials

- **What is wrong:** `api`, `web` and `citizen-app` load the whole `.env`; the API process keeps the credential of the `den` role, which is a cluster superuser.
- **Where:** `infra/compose/docker-compose.deploy.yml:199,239,256`; `apps/api/Dockerfile:39`; `scripts/make-deploy-env.mjs:86-87`; `infra/compose/docker-compose.yml:20`.
- **Scenario:** an environment read or code execution in Next.js, or in the reference citizen app (a mock published on the internet), hands over the PostgreSQL password, the Keycloak admin password, the step-ca password, the transparency signing key, the HMAC key of the pseudonym, the APISIX Admin API key and the backup key. With the `den` role the insert-only triggers are disabled and the audit log and its anchors are rewritten.
- **Evidence:** PROVEN with `docker compose config` (more than 100 variables in each service). PROVEN in a disposable PostgreSQL that `den` is a superuser and that `SET session_replication_role = replica` or `DISABLE TRIGGER` skip an equivalent trigger; the test was not run on the real migration. Anchors already sent by email cannot be rewritten.
- **Breaks:** DEPLOYMENT §3.2 ("the schema owner only runs migrations; the API runs as `den_app`") and ARCHITECTURE §7. The Helm chart does get this right.
- **Fix:** a one-shot `migrate` service with the owner URL, and explicit `environment:` lists per service instead of the whole `.env`.

### A-3 · Transparency batches larger than 32 KB are lost whole

- **What is wrong:** the Fluent Bit `tcp` input drops any JSON message larger than its default buffer, and APISIX sends each batch as a single JSON array.
- **Where:** `infra/fluent-bit/transparency.yaml:21-28` (no `buffer_size`); `apps/api/src/reconcilers/apisix/desired-state.ts:599-610` (`batch_max_size: 100`).
- **Scenario:** a route with data-subject data receives more than 50 calls in one worker without a one-second pause. The batch exceeds 32 KB, Fluent Bit closes the connection and drops it. APISIX already counted the send as done and does not retry. The citizen does not see those queries, gets no notice and there is no receipt. Only a `warn` line is left in the container.
- **Evidence:** PROVEN by running `fluent/fluent-bit:5.1.5-debug` (the compose image) with the repository's input: 50 records (32,741 bytes) come out as 50; 51 records (33,396 bytes) come out as 0; a full batch of 100 comes out as 0. The sender was a script that imitates `tcp-logger`; the array format and the lack of retry come from the APISIX 3.19.0 source, not from a running APISIX.
- **Why it was not seen:** with sporadic traffic the batches are small. `docs/performance/M6-03.md` loads 500 req/s with transparency on but does not count the records that arrived.
- **Breaks:** ADR-0015 (decision 3 and "Completeness"); ARCHITECTURE §13.
- **Fix:** set `buffer_size` on the input (1–4 MB) or lower `batch_max_size` so the largest batch fits. Add a load test that compares calls served with rows inserted, and a gap alert.

### A-4 · A consumer evades the transparency log with a long `X-Request-Id`

- **What is wrong:** the collector drops the whole record if `request_id` exceeds 200 characters, and the consumer chooses that field.
- **Where:** `apps/api/src/transparency/subject-access.service.ts:30,92-96,190-192`; `apps/api/src/reconcilers/apisix/desired-state.ts:207,521`; `infra/fluent-bit/transparency.lua:31-45`; `packages/policy/den/authz.rego:257`.
- **Scenario:** an application with a valid subscription queries a person's data sending an `X-Request-Id` of 201 characters. OPA authorizes and the provider responds. The collector marks the record `invalid`, answers 200 to Fluent Bit and the record is lost forever. The only signal is a `warn` with counts, with no metric or alert, and it does not identify the application. Combined with A-3, headers of several KB also take down the whole batch, including records of other consumers.
- **Evidence:** PROVEN in the collector (`subject-access.review.test.ts`). That the gateway keeps the client's value is INFERRED, confirmed by three independent readings of the APISIX 3.19.0 source (`request-id` only generates an id if the header is missing).
- **Breaks:** ADR-0015 §3; ADR-0017, consequence 1 (nothing depends on a claim by the consumer).
- **Fix:** an optional field that cannot be verified must not invalidate the record: truncate it or null it in the collector and bound it in `transparency.lua`, as `allowlist.lua` already does in analytics. Add a metric and an alert for records dropped by reason.

### A-5 · The reconciler deletes the X-Road client certificate on every pass

- **What is wrong:** the orphan cleanup does not count `den-ssl-gateway-xroad` among the SSL objects it must keep.
- **Where:** `apps/api/src/reconcilers/apisix/apisix.reconciler.ts:374-385` (`removeOrphans`); creation at `:399-417` and `:601-606`.
- **Scenario:** the operator configures an `https://` Security Server and an `xroad` version is published. Every full pass creates the SSL and deletes it at the end. The upstream is left pointing at a nonexistent SSL until the next pass (about five minutes), which repeats the cycle. `sync_state` shows `in_sync`.
- **Evidence:** PROVEN at the reconciler level (`orphans.review.test.ts`, which emits `DELETE ssls/den-ssl-gateway-xroad`). That APISIX accepts the delete and that calls fail afterwards is INFERRED from the APISIX 3.19.0 source (`admin/ssl.lua` has no `delete_checker`).
- **Why it was not seen:** `xroad.int.test.ts` uses an `http://` Security Server and does not run `reconcileAll`.
- **Breaks:** ARCHITECTURE §4.1 and ADR-0007 (convergence).
- **Fix:** compute the set of desired SSL objects and delete only what is not in it; at a minimum, keep that id while an xroad version is served over https.

---

## 3. Medium findings

### 3.1 Accounts, roles and second factor

**M-01 · A platform role without a second factor reads other entities' registration files.**
- **Where:** `apps/api/src/entities/entity-requests.controller.ts:26`; `entity-requests.service.ts:90-109,214`; `apps/api/src/auth/auth.guard.ts:93`.
- **Scenario:** whoever has only the password of a reviewer, operator or regulator gets 403 `mfa_required` on the review queue, but `GET /entity-requests/<id>` is `@SignedIn` and returns the file: applicant, designated people, DPO, comments and the PDF. The id is the entity's, which `/catalog/entities` publishes.
- **Evidence:** PROVEN (`mfa-signed-in-bypass.review.test.ts`, with the real guard and a mocked Prisma).
- **Breaks:** ADR-0021 and SPEC §8.
- **Fix:** let `@SignedIn` routes serve only the applicant and have reviewers read through `@PlatformAccess` routes; at a minimum, require `principal.mfa` in the review branch.

**M-02 · The `data_steward` second factor is bypassed from `entity_admin`, which does not require it.**
- **Where:** `apps/api/src/auth/authz.policy.ts:27-30,182`; `apps/api/src/entities/members.service.ts:63,196`.
- **Scenario:** with the password of an `entity_admin`, the attacker invites an email of their own as `data_steward`, enrolls their own TOTP and approves access requests. `node.write` (node enrollment tokens) follows the same pattern.
- **Evidence:** INFERRED.
- **Breaks:** the intent of ADR-0021; ASVS-L2 lists it as a pending decision without warning about this consequence.
- **Fix:** include `entity_admin` in `MFA_ENTITY_ROLES`, or require MFA on `entity.members.write` and `node.write`.

**M-03 · There is no audited way to grant or revoke platform roles or to disable a user.**
- **Where:** `userPlatformRole` is only written in `auth/bootstrap-admin.ts`, `seed/seed.ts`, `load/scale-seed.ts` and tests.
- **Scenario:** in production only the bootstrap `platform_admin` exists. Creating a regulator or removing a compromised administrator requires direct SQL, outside the audit log. Without a regulator, sensitive versions get stuck in `approved_operator`.
- **Evidence:** INFERRED.
- **Breaks:** golden rule 4; `docs/DEPLOYMENT.md:607` ("the other roles are granted from the console").
- **Fix:** audited `@PlatformAccess` endpoints to grant, revoke and disable, with a last-administrator rule.

### 3.2 State machines and lifecycle

**M-04 · "Reactivar entidad" (Reactivate entity) activates a registration request that is still under review.**
- **Where:** `apps/api/src/entities/entity-status.service.ts:233-251`; `apps/api/src/domain/entity/state-machine.ts:18`.
- **Scenario:** a `platform_admin` calls `POST /admin/entities/:id/reactivate` on a request in `under_review`, even their own. It ends up `active` without the impartiality check, without a membership or invitations (an active entity with no administrator) and with an `entity.reactivated` event that did not happen.
- **Evidence:** PROVEN (`entity-status.review.test.ts`).
- **Breaks:** SPEC §4.1 (separation of duties).
- **Fix:** require `status === 'suspended'` in `reactivate` and pin it in the WHERE. In general, do not use the state machine as the only guard when two actions share a target state.

**M-05 · In subscriptions, `/reactivate` goes from `approved` to `active` without gateway confirmation.**
- **Where:** `apps/api/src/subscriptions/subscriptions.service.ts:1063-1096`.
- **Scenario:** the data steward "reactivates" a subscription that was just approved. The state and the audit log claim an activation that OPA did not confirm. It does not grant extra access.
- **Evidence:** INFERRED.
- **Breaks:** SPEC §4.4 step 4.
- **Fix:** require `status === 'suspended'`.

**M-06 · A pending renewal has no way out when the original expires.**
- **Where:** `subscriptions.service.ts:748-757`, used in `approve` (`:623`) and in `regulator.service.ts`.
- **Scenario:** the consumer requests the renewal on time and the data steward decides after `validUntil`. The original is already `expired` and every approval returns 409 forever. There is a service outage and the consumer has to start over.
- **Evidence:** INFERRED; the existing test covers the suspended case, not the expired one.
- **Breaks:** SPEC §4.4 step 6.
- **Fix:** accept an `active` or `expired` original, or close the renewal on expiry with an audited event.

**M-07 · Retiring a version leaves requests in `info_requested` alive, and they are later approved.**
- **Where:** `apps/api/src/apis/version-lifecycle.service.ts:19` (compare `entity-status.service.ts:15`, which does include it).
- **Scenario:** after the retirement, the applicant answers and the data steward approves, because `approve` does not look at the version's state. The result is an `approved` subscription on a retired version: it gives no access, but it is never activated and it takes the slot of "one live per purpose".
- **Evidence:** PROVEN (`version-lifecycle.review.test.ts`); two reviewers found it separately.
- **Breaks:** SPEC §4.2 step 5 and ADR-0019 point 4.
- **Fix:** add `info_requested` to `PENDING` and check that the version is served in `approve` and `provideInfo`.

### 3.3 APISIX reconciler

**M-08 · The drift comparison is a subset check: what is extra in APISIX is neither corrected nor detected.**
- **Where:** `apps/api/src/reconcilers/apisix/desired-state.ts:790-804`; `apisix.reconciler.ts:704-713`.
- **Scenario 1:** the operator turns off `features.gatewayAssertion`. The metadata is deleted, but the routes keep `den-assertion`, which answers 503 on every call until someone deletes the routes by hand.
- **Scenario 2:** a plugin added by hand to a managed route, or an extra node in an upstream, survives reconciliation and does not count as drift.
- **Scenario 3:** an IP that the provider's DNS no longer publishes keeps receiving traffic.
- **Evidence:** PROVEN for `matches` (`orphans.review.test.ts` and `desired-state.review.test.ts`); two reviewers found it. The 503 is INFERRED from reading `den-assertion.lua:102-106`.
- **Breaks:** ARCHITECTURE §4, ADR-0007 and golden rule 5.
- **Fix:** exact equality on the fields the portal owns (`plugins`, `nodes`, `tls`, `vars`, `methods`), tolerating only APISIX's default values.

**M-09 · The full pass deletes as orphans objects created while it was running.**
- **Where:** `apisix.reconciler.ts:142-145` (snapshot) and `:165-189` (cleanup).
- **Scenario:** the operator publishes a version during a pass. The outbox job creates the route and the pass in progress deletes it. The API answers 404 for up to five minutes with `sync_state = in_sync`. There is no lock between passes or between replicas.
- **Evidence:** PROVEN with the simulated interleaving (`orphans.review.test.ts`); the real frequency is INFERRED.
- **Breaks:** SPEC §4.4 ("< 60 s") and ADR-0007.
- **Fix:** re-read each candidate from the database before deleting it, or serialize with an advisory lock as WireGuard does.

**M-10 · The client certificate of a provider whose only version is `in_review` is deleted.**
- **Where:** `apisix.reconciler.ts:183-186`.
- **Scenario:** a new provider sends its first version with direct mTLS to review. The connectivity validation works or fails depending on where the cycle is.
- **Evidence:** PROVEN (`orphans.review.test.ts`).
- **Fix:** include in `providers` the entities with `in_review` versions that need PKI.

### 3.4 Gateway traffic

**M-11 · The consumer's token reaches the provider (high with `mtls.required: false`).**
- **Where:** `apps/api/src/reconcilers/apisix/desired-state.ts:134-166,525-566`.
- **Scenario:** the provider, or the X-Road Security Server, receives the consumer's `Authorization: Bearer <token>` on every call. Without mandatory mTLS, the token is a pure bearer: the provider reuses it against other APIs the application is subscribed to, and the audit log and transparency blame the application. With mandatory mTLS (`co.yaml`), OPA returns `certificate_mismatch`, but the token still reaches the provider's logs.
- **Evidence:** PROVEN at the configuration level (`desired-state.review.test.ts`). That APISIX does not remove the header is INFERRED from the 3.19.0 source (`openid-connect`, `opa`, `proxy-rewrite` and the nginx template), confirmed by a second agent. No test in the repo asserts what the provider sees.
- **Breaks:** ARCHITECTURE §6 lists what the provider receives and does not mention the token; ASVS L2.
- **Fix:** add `Authorization` to OPA's `send_headers_upstream`, which is the pattern already used to remove after reading, and a case in `header-spoofing.int.test.ts`.

**M-12 · The recorded data subject may not be the queried data subject.**
- **Where:** `packages/policy/den/authz.rego:153-189`; `apps/api/src/transparency/subject-ref.ts:20-27`; `infra/apisix/plugins/apisix/plugins/den-data-subject.lua:61-147`.
- **Scenario a:** `/afiliados/0001000000001` and `/afiliados/1000000001` give different pseudonyms; a provider that stores the number as an integer returns the same person, who never sees the query.
- **Scenario b:** a body with `numeroIdentificacion` and `NumeroIdentificacion` passes the duplicate check; the gateway records the first and a case-insensitive provider uses the second.
- **Evidence:** PROVEN that the pseudonyms differ (`authz_review_test.rego`). The case vector and the provider's behavior are INFERRED.
- **Breaks:** ADR-0017 ("the gateway and the provider must read the same person").
- **Fix:** a canonical form per document type in `config/country/*.yaml`, denying what does not meet it; treat names that match case-insensitively as duplicates; require it in the provider contract.

**M-13 · A literal route next to a parameterized one is unreachable.**
- **Where:** `packages/policy/den/authz.rego:50-54`; `apps/api/src/apis/lint/openapi-lint.ts` does not reject overlaps.
- **Scenario:** a valid OpenAPI with `GET /afiliados/{id}` and `GET /afiliados/buscar`. Every call to the literal fails with 5xx. It fails closed.
- **Evidence:** PROVEN (`authz_review_test.rego`: `eval_conflict_error`).
- **Fix:** let the literal win over the parameterized one, or reject the overlap in the lint.

### 3.5 Transparency and privacy

**M-14 · The accredited TSA cannot be connected; only the development one works.**
- **Where:** `apps/api/src/transparency/evidence/tsa.client.ts:28-46`; `infra/mock-citizen-app/src/config.ts:91`; `infra/tsa/init.sh`.
- **Scenario:** the client hardcodes the sigstore API paths and downloads the trust root from the TSA itself. With a standard RFC 3161 TSA, no batch or anchor is stamped. What is left is the development TSA, an operator container with the key in a volume: the operator holds the signing key, the TSA's key and the database, and can rewrite and re-stamp everything.
- **Evidence:** INFERRED.
- **Breaks:** ADR-0016 §2; ARCHITECTURE §13; `docs/DEPLOYMENT.md:193-196,554`.
- **Fix:** a configurable full URL and roots pinned by configuration; warn or fail in production if the TSA is the development one.

**M-15 · The sealer scans the whole records table every 10 s, with no index.**
- **Where:** `apps/api/src/transparency/evidence/transparency-evidence.service.ts:148-152,456-459`.
- **Scenario:** with 60-month retention the table reaches tens of millions of rows. When the query exceeds its 60 s timeout, sealing fails on every round and everything is left without a receipt.
- **Evidence:** INFERRED; `EXPLAIN` was not run.
- **Fix:** a pending-items queue table, or an index with a watermark.

**M-16 · `X-Request-Id` is free text that ends up stored next to the pseudonym and in analytics.**
- **Where:** `subject-access.service.ts:30,145`; `infra/fluent-bit/allowlist.lua:33,41`.
- **Scenario:** a consumer that uses the document number as a trace id leaves it in clear in `subject_access_record` (60 months) next to the pseudonym. In analytics, `CC-1032456789` matches the `request_id` pattern and `cc1032456789` matches the `purpose` pattern on denied calls, and both reach OpenSearch.
- **Evidence:** PROVEN that the collector stores up to 200 free characters (reading confirmed by a second agent; no code later reads that column). The analytics filter is INFERRED from the patterns.
- **Breaks:** ADR-0015 ("it does not reach logs, buffers or databases"); ARCHITECTURE §8.
- **Fix:** do not store the field or store its hash; discard values with six or more consecutive digits, as `gateway-errors.lua` already does.

### 3.6 Domain endpoints

**M-17 · The "authenticated" catalog is open to anyone who self-registers.**
- **Where:** `apps/api/src/catalog/catalog.controller.ts:23-29`; `catalog.service.ts:33-39`; the portal realm has `registrationAllowed: true`.
- **Scenario:** a person with no membership or role sees all `internal`, `personal` and `sensitive` APIs: exposed fields, contact email, node status and the full OpenAPI.
- **Evidence:** INFERRED; an existing test (`catalog.int.test.ts:193`) fixes it as intentional.
- **Breaks:** ADR-0014 ("they are protected with platform roles").
- **Fix:** require an active membership or a platform role for anything non-public; if it is deliberate, document it in SPEC §2.3.

**M-18 · The revision compatibility check lets incompatible changes through.**
- **Where:** `apps/api/src/domain/api-version/compatibility.ts:58-66,86-92`.
- **Scenario:** an `api_publisher` removes or changes the type of a nested property, of an array's `items`, of a parameter or of the body. The portal accepts it as a minor revision, with no operator review and with the same subscriptions.
- **Evidence:** PROVEN (`compatibility.review.test.ts`, five cases).
- **Breaks:** SPEC §4.2 and ADR-0019.
- **Fix:** recursive comparison; anything that cannot be compared counts as incompatible.

**M-19 · A version returned with corrections only allows changing the OpenAPI.**
- **Where:** `apps/api/src/apis/apis.controller.ts`; `apis.service.ts:366-377`.
- **Scenario:** the reviewer asks to fix the exposed fields, the legal basis or the upstream. There is no endpoint to do it, and another version of that major cannot be created. The only options are to jump to `v2` or to create another API.
- **Evidence:** INFERRED.
- **Breaks:** SPEC §4.2 and §6.
- **Fix:** a `PUT` of the version in editable states with the validation of `createVersion`.

**M-20 · Privacy controls depend on the API's classification, not on the declared fields.**
- **Where:** `apis.service.ts:260-269`; `subscriptions.service.ts:80-85`; `catalog.service.ts:37`.
- **Scenario:** a provider registers the API as `internal` with fields marked `personal: true`. Declaring the data subject is not required (so no transparency), neither is `X-DEN-End-User`, and the maximum validity is 24 months. Everything depends on the reviewer noticing.
- **Evidence:** INFERRED. `domain/approval.ts` already applies the right rule, but only for sensitive fields.
- **Breaks:** SPEC §5 and ADR-0015.
- **Fix:** reject the combination in `createVersion` and `submit`, or derive an effective classification.

### 3.7 Web

**M-21 · After more than five minutes without navigating, the first request calls the API with the expired token.**
- **Where:** `apps/web/src/proxy.ts:11,32`; `apps/web/src/lib/api.ts:22-30`; `apps/web/src/auth.ts:42-51`.
- **Scenario:** the proxy refreshes the token and hands it to the browser, but the render and the server actions of that same request read the old cookie. A data steward reads a request for six minutes and clicks "Aprobar" (Approve): the API answers 401 and she sees a generic error. The second attempt works.
- **Evidence:** PROVEN at the proxy level with real Auth.js and next-intl (`stale-token.review.test.ts`). The 401 and what the pages show are INFERRED.
- **Fix:** propagate the refreshed token to the request, or have `lib/api.ts` refresh and retry once on a 401.

**M-22 · The web shows dates in UTC, not in the country's time zone.**
- **Where:** `apps/web/src/i18n/request.ts:8-14`.
- **Scenario:** with `America/Bogota`, the auditor sees an event at 20:30 on the 14th as 01:30 on the 15th, with no time zone shown. The API's emails do use the country's zone, so portal and email can show different days.
- **Evidence:** INFERRED.
- **Breaks:** CLAUDE.md, Conventions.
- **Fix:** `timeZone: getCountryConfig().country.timezone` in `getRequestConfig`, with a test near midnight.

**M-23 · No e2e test runs in CI.**
- **Where:** `.github/workflows/ci.yml`.
- **Scenario:** a change that breaks the CSP, the cookies or the logout, or introduces axe violations, passes CI green. `tests/infra/*.int.test`, `helm lint` and a `compose config` of the deploy overlay (which would have caught A-1) do not run either.
- **Evidence:** PROVEN by reading the workflows.
- **Breaks:** the definition of done as a continuous guarantee; `playwright.config.ts:23` and `docs/accessibility/WCAG-2.1-AA.md` say it runs on every run.
- **Fix:** a job with the compose stack that runs at least `accessibility`, `security-headers` and `login`.

### 3.8 Deployment and operation

**M-24 · `.dockerignore` does not exclude `backups/` or `infra/edge/certs/`.**
- **Where:** `.dockerignore`; `infra/mock-providers/Dockerfile:5`; `infra/mock-citizen-app/Dockerfile:6`; `install.sh:562-611`.
- **Scenario:** `install.sh update` backs up into `backups/` and then builds. The `COPY . .` puts into the layers of two images the `env` with all the secrets, the dumps, the step-ca data and the portal's private key. `backups/` is never pruned.
- **Evidence:** PROVEN by reading; no build was done.
- **Fix:** exclude `backups/`, `infra/edge/certs/`, `infra/edge/dynamic/` and `_site/`; rotate `backups/`.

**M-25 · Startup does not fail with example secrets.**
- **Where:** `infra/compose/docker-compose.yml:67,69`; `apps/api/src/opa/deployment-secret.ts`; `apps/api/src/transparency/evidence/signing-key.ts`.
- **Scenario:** with a hand-written `.env`, Keycloak imports the demo users with a public password and TOTP. In production only two example values are rejected; the transparency signing private key published in `.env.example`, `DEN_SECRETS_KEY`, `AUTH_SECRET` and the ingestion token are accepted.
- **Evidence:** INFERRED. `install.sh` and `make-deploy-env` do replace all of them (verified).
- **Breaks:** SECURITY.md ("a default that would carry over").
- **Fix:** `:?` in the deploy overlay and a startup validation that rejects any value equal to the one in `.env.example`.

**M-26 · The installer's check on the OPA bundle cannot fail.**
- **Where:** `install.sh:460-462`.
- **Scenario:** it accepts any code other than 200. A 401 from the API (exposed route) or a `000` from curl both give "not exposed". It matters most with a custom Traefik.
- **Evidence:** PROVEN by reading.
- **Breaks:** OPERATIONS §2.1 (asks for 404).
- **Fix:** require an exact 404, also for `/api/v1/internal`.

**M-27 · The API does not know the client's real IP.**
- **Where:** `scripts/make-deploy-env.mjs:124` (`DEN_TRUST_PROXY` empty); `apps/web/src/lib/api.ts:38,104,133,153` (does not forward `X-Forwarded-For`); `apps/api/src/common/rate-limit.ts:69-75`.
- **Scenario:** all anonymous visitors share one bucket of 600 per minute; a single one exhausts it for everyone else. `request_refused` events record the IP of Traefik or of the web container, and the audit log's `ip` field is always null.
- **Evidence:** PROVEN that the generated `.env` leaves it empty; the rest is INFERRED (three reviewers agree).
- **Breaks:** DEPLOYMENT §4.1; ASVS-L2 row 4; SPEC §3 (`ip` field).
- **Fix:** a fixed IP for the edge on the network and `DEN_TRUST_PROXY` written by the installer; have the web forward the IP.

**M-28 · No pilot email leaves the server, and it is not configurable.**
- **Where:** `infra/compose/docker-compose.deploy.yml:202`; `infra/keycloak/den-portal-realm.json:20-25`; `infra/alertmanager/alertmanager.yml`.
- **Scenario:** INSTALL §6 says real entities are registered by self-registration. Their email verifications, invitations and recoveries land in Mailpit. If the operator shares that credential, anyone reads the recovery links of any account. Alerts reach nobody.
- **Evidence:** INFERRED. It is documented as a limitation, but it clashes with the intended use.
- **Fix:** let `.env` govern `DEN_SMTP_URL` and document the realm's SMTP.

**M-29 · A single password for the ten demo users, with `DEN_ALLOW_SEED=true` in the deployment.**
- **Where:** INSTALL §3 step 6; `infra/keycloak/den-portal-realm.json`; `infra/compose/docker-compose.deploy.yml:200-202`.
- **Scenario:** whoever receives the password at the bootcamp has the password of the platform administrators, the regulator and the auditor. The only barrier is a shared TOTP. It was not verified whether, with only the password, Keycloak lets a second authenticator be enrolled.
- **Evidence:** INFERRED.
- **Fix:** a different password for accounts with a critical role, or do not share the common one.

**M-30 · The "server lost" procedure cannot be run as written.**
- **Where:** OPERATIONS §6.1; `install.sh` (`cmd_install`, `cmd_restore`).
- **Scenario:** it asks to restore the volumes before the first start, but there is no step to create them without starting. If it is started, PostgreSQL initializes a new cluster against a repository with a different system-id. Also, `backups/<date>/` keeps the encrypted repository next to the `env` that holds its key.
- **Evidence:** INFERRED.
- **Fix:** a tested `install.sh restore-volumes <dir>`.

### 3.9 Medium-low

**MB-1 · Analytics names the consumer by a slug that is not unique.**
- **Where:** `apps/api/src/analytics/usage.service.ts:102-105`; `indicators.service.ts:152-155`.
- **Scenario:** any user creates a registration draft with the slug of an entity that does not exist yet. When the real one consumes, the provider's dashboard and the regulator's map may attribute the calls to the draft.
- **Evidence:** PROVEN that the query does not filter by state (`usage-slug.review.test.ts`).
- **Fix:** filter by state, or log the entity id.

**MB-2 · The gateway acts as a fuzzer against any public HTTPS host before human review.**
- **Where:** `apis.service.ts:696-768`; `version-validation.service.ts:129-154`.
- **Scenario:** an `api_publisher` declares a third party's URL as the sandbox and repeats `POST …/validations`. Schemathesis fires up to 20 examples per operation from the operator's IP. It does not reach the internal network.
- **Evidence:** INFERRED.
- **Fix:** a strict limit with a per-version cooldown and a host-control proof.

---

## 4. Low findings

| # | Finding | Where | Evidence | Fix |
| :-- | :-- | :-- | :-- | :-- |
| B-01 | The chain verifier accepts rows without a hash with `seq ≤ 0` and backdated events; the hash carries no key | `apps/api/src/audit/chain.ts:91-118` | PROVEN (`chain.review.test.ts`) | CHECK on the table, monotonic `occurredAt`, document the limit in ARCHITECTURE §7 |
| B-02 | The RFC 3161 stamp of the audit anchor is stored and never verified; an anchor with a future day stops anchoring without an alert | `audit-anchor.service.ts:150`; `audit-query.service.ts:63-84` | INFERRED | Verify the token in `/audit/verify`, include it in the email, age metric |
| B-03 | The sanitizer deletes `tokenId` from node enrollment events | `apps/api/src/audit/sanitize.ts:2-3` | PROVEN (`chain.review.test.ts`) | Exception for `*Id` keys |
| B-04 | The chain's global lock turns long transactions (entity deactivation, mass revocation) into 500 errors for the rest | `entity-status.service.ts:253`; `certificate-revocations.service.ts` | INFERRED | Take the lock and write the events at the end of the transaction |
| B-05 | ABA in decisions: `move` and `decide` condition only on `status` | `subscriptions.service.ts` | INFERRED | Add `updatedAt` to the WHERE |
| B-06 | The "one live per purpose" index excludes renewals; two simultaneous requests leave two live | migration `20261124000001_subscription_lifecycle` | INFERRED | Extend the index |
| B-07 | "One version per major" with no constraint in the database | `apis.service.ts:369-377` | INFERRED | Partial unique index |
| B-08 | Auto-approved sandbox with no caps on limits or renewals | `subscriptions.service.ts:233-276` | INFERRED | Cap at the default limit |
| B-09 | Replaced agreements and designation PDFs accumulate without limit | `subscriptions.service.ts:839-879` | INFERRED | Delete or limit replacements |
| B-10 | Third-party text in the subject of official emails | `notifications.service.ts:107-118` | INFERRED | Fixed subject |
| B-11 | `/api/docs` loads Scalar from a CDN with no version or SRI | `apps/api/src/openapi/docs.ts:21-28` | PROVEN by reading the default value | Serve the local bundle |
| B-12 | Two concurrent Keycloak reconciliations can cut a secret's rotation window short | `keycloak.reconciler.ts:161-172` | INFERRED | Advisory lock per application |
| B-13 | Revoking a secret is not immediate: issued tokens are valid for up to five minutes without mTLS | `infra/keycloak/den-gateway-realm.json:8` | INFERRED | Document it, or a per-client `notBefore` in the bundle |
| B-14 | `outbox` is never purged; the Keycloak client has no timeout; `deleted` applications are scanned forever | `keycloak-admin.ts:82-121` | INFERRED | Purge, timeout and filter |
| B-15 | OPA and etcd without authentication on the `gateway` network: any container on that network reads the pseudonym key | `infra/compose/docker-compose.yml:91-95,157-161` | INFERRED | Token on OPA, credentials on etcd |
| B-16 | A single password for the CA and its provisioners; the API knows the one that encrypts the CA's keys | `infra/step-ca/configure.sh:29-43` | INFERRED | Password per provisioner |
| B-17 | Fluent Bit inputs (TCP 5170, HTTP 9880) without authentication: a container on the network injects fake records | `docker-compose.yml:339` | INFERRED | Restrict the network or authenticate |
| B-18 | `GET /transparency/records/:id/receipt` with `audit.read` returns the pseudonym without leaving a trace | `transparency` module | INFERRED | Audit the read |
| B-19 | `/transparency/verify` returns `valid: true` with unstamped batches | `transparency-evidence.service.ts` | INFERRED | Flag it in `valid` or alert |
| B-20 | The citizen app shows "valid" without binding the receipt to the requested query, and loses notices if SMTP fails | `infra/mock-citizen-app/src/server.ts:341-415` | INFERRED | Compare `record.id`; mark the notice after sending it |
| B-21 | Race on first sign-in (500 from a unique index) | `principal.service.ts:58-61,92-121` | INFERRED | Catch P2002 and re-read |
| B-22 | Identity is tied to the `sub` and email of the first login, with no reconciliation path | `principal.service.ts:76-97` | INFERRED | Audited re-linking procedure |
| B-23 | The applicant of a registration keeps read access to the file and the PDF for life | `entity-requests.service.ts:99-109` | INFERRED | Require an active membership after the decision |
| B-24 | No `error.tsx` or `not-found.tsx`: errors in English and outside the axe audit | `apps/web/src/app` | PROVEN by listing | Add them, translated |
| B-25 | The session-end notice can arrive late, and a failed refresh leaves a zombie session for up to ten hours | `session-timeout.tsx:18-41`; `auth.ts:42` | INFERRED | Bind the notice to a real refresh |
| B-26 | Route parameters interpolated without validation in the API URL; routes with a dot bypass the proxy | `catalog/[apiId]/page.tsx:30,55`; `proxy.ts:50` | INFERRED | Validate UUID; exclude only static extensions |
| B-27 | UI languages hardcoded (`['es','en']`) | `apps/web/src/i18n/routing.ts:4` | INFERRED | Take them from the country configuration |
| B-28 | Keycloak admin console public in the pilot, with `start-dev` | `infra/edge/den.yml.template:39-44` | INFERRED | Block `/auth/admin` as the chart does |
| B-29 | CI: third-party actions by tag in `ci.yml` | `.github/workflows/ci.yml` | PROVEN by reading | Pin by commit |
| B-30 | `install.sh`: unverified `curl \| sh`, does not check `curl`, `git` or the Engine version, a demo password with `$` or `#` is written wrong in `.env` | `install.sh:133` | INFERRED | Checks and quoting |
| B-31 | Images by tag and not by digest, no memory limits; APISIX's factory key is still in the keyring | `infra/apisix/config.yaml:27` | INFERRED | Pin the digest; remove the key |
| B-32 | `license:check` covers only npm; images, apk and the Python dependencies of the contract runner are left out | `scripts/license-check.mjs` | INFERRED; the images in use comply, reviewed by hand | Extend it or document the limit |
| B-33 | Leftovers from the author's environment: `lab-router_default` as the default network, "Before Tuesday" in INSTALL §1.2 | `docker-compose.deploy.yml:285`; `make-deploy-env.mjs:26` | PROVEN by reading | Neutral value |
| B-34 | `packages/policy/rid` is an empty untracked directory | — | PROVEN | Delete it |

---

## 5. Discrepancies between documentation and code

In addition to those already listed in each finding:

| Document | Says | Reality |
| :-- | :-- | :-- |
| ARCHITECTURE §4.3 | The Keycloak reconciler configures `tls_client_auth` | The code, §3.2 and ADR-0022 say the opposite: secret plus bound token |
| ARCHITECTURE §3.2 | The gateway's TLS terminates at APISIX | The edge publishes `/gw` to APISIX 9080 over plain HTTP |
| ADR-0016 §1–2 | Leaf = hash of the record's canonical JSON; checkpoint with a range | Format 2 `{v, id, occurredAt, digest}` and a checkpoint without a range; there is no new ADR that specifies it |
| ADR-0025 | "`params` never carries what the user typed" | It carries it in five places in `apis.service.ts` and `subscriptions.service.ts` |
| ADR-0019 | A revision does not change the exposed data | `compatibility.ts` allows new operations and properties that nobody reviewed |
| ADR-0005 | Revocation in less than 60 s | True for subscriptions and certificates; not for secrets, nor with the portal down (OPA keeps the last bundle) |
| SPEC §3 | The audit event carries `ip` | It is always null and is not in the export |
| SPEC §3 | `Application` has `suspended` and `deleted` states | No production code writes them |
| SPEC §4.2 | The provider declares an SLA; lint of response schemas and descriptions in Spanish | The `sla` column is never written; the ruleset does not have those rules |
| SPEC §4.2 | States `approved_regulator` and `changes_requested → draft` | They exist in the enum and are never persisted; the audit log records a state that does not match the row |
| SPEC §11 | Audit retention | `retention.auditYears` exists in the configuration and nobody reads it |
| AUTHZ.md | `/entity-requests/:id` is "own resources only" | It also serves reviewers, operator and regulator (M-01) |
| OPERATIONS §92-94 | There is no way to create the first `platform_admin` | `DEN_BOOTSTRAP_ADMIN_EMAIL` exists, described in DEPLOYMENT |
| OPERATIONS §0 | Alias `dc` | It does not include the edge overlay or the antivirus profile |
| DEPLOYMENT §3.1 | Prometheus, Alertmanager and Grafana "are not in the Compose file yet" | They are |
| DEPLOYMENT §7 | CI table | It omits `pnpm audit`, promtool and the restore job |
| INSTALL §7 | Command list | `install.sh images <tag>` is missing; the `den-*` images do not exist in the registry yet |
| CLAUDE.md | "scopedRepo, never by hand" | `members.service.ts` and `bootcamp.service.ts` filter `entityId` by hand; the value comes from the guard, so there is no IDOR |
| `den-assertion.lua`, `infra/apisix/config.yaml` | "SPIKE S-6, prototype" | It is the implementation of M6-10 |

These match the code: RUNBOOK §2–4 (the endpoints and commands it cites exist), the port, volume and variable tables in DEPLOYMENT, and the `den-*` names throughout the live code after ADR-0028.

---

## 6. What was not reviewed or was only skimmed

**Not run:**

- No `*.int.test.ts` or e2e test: the portal stack was not up.
- `install.sh`, image builds and the Helm charts (`helm` and `shellcheck` are not installed).
- Real traffic through APISIX, OPA or Keycloak. Everything that depends on their runtime behavior is a reading of the pinned version's source.

**Specific points that deserve a test and did not get one:**

- JWT validation in `openid-connect`: tokens with `alg: none`, HS256 or a signature from another realm.
- Upstream `tls.verify` with a network-CA certificate issued for another name.
- Enrollment of a second authenticator in Keycloak with only the password (M-29).
- XSS inside Scalar with a malicious OpenAPI; it was only checked that the CSP backs it up.
- Non-UTF-8 bytes in `X-Request-Id` (suspected to break the whole batch in Fluent Bit).
- Whether the X-Road Security Server forwards `Authorization` to the provider's system.

**Code not read or read only by search:**

- **Web:** most pages (`my-apis`, `my-entity`, almost all of `operator`, `regulator`, `requests`, `audit`, `entity-requests`), the forms and charts, about 35 e2e specs and the contents of the message files.
- **API:** `invitations.service.ts`, `purposes.service.ts`, `notifications/notifying-actions.ts`, `gateway-signing-keys`, `secrets/reseal.ts`, `certificate-lifecycle.service.ts`, `nodes.service.ts` (except token issuance), the seed, and the 37 migrations line by line.
- **Infra:** in Helm only `values.yaml`, `ingress.yaml`, `secrets.yaml` and parts of Keycloak, gateway and API were read; not the NetworkPolicies, etcd, step-ca, PostgreSQL or OpenSearch security. Also not `infra/contract-runner/runner.py`, `infra/mock-node`, Grafana, the Prometheus rules, the firewall of `hub-agent.mjs` or the guides in `docs/guides`.
- **Realms:** `den-gateway` and `den-citizens` only in part; not Keycloak's logs or events.
- **Spanish mirror (`docs/es`):** only checked that the line count matches.
- **Not assessed:** SELinux, arm64, Let's Encrypt issuance and the existence of the image tags in the registries.

---

## 7. What was found solid

- **Global API guard:** it fails closed; a route without a declaration answers 403 and a test over the real routes requires it. The authorization matrix is generated from the discovered routes, not from a hand-written list.
- **Portal JWT verification:** RS256 pinned, issuer, audience, remote JWKS; roles never come from the token.
- **Per-entity isolation:** the `entityId` always comes from the guard; nested resources are loaded with relational filters and answer 404. Bodies are `z.strictObject`, with no mass assignment.
- **Invitations and last administrator:** bound to the verified email, single use, with a `FOR UPDATE` lock and audit in the same transaction.
- **Audit log:** all reviewed state changes emit their event in the transaction. The chain is serialized with an advisory lock, does not allow forking, and `den_app` cannot modify or delete it.
- **Optimistic control:** almost all transitions use `updateMany` with the read state in the WHERE; two approvers do not produce a double decision. Separation of duties is repeated inside the WHERE.
- **Outbox and reconcilers:** insertion in the same transaction, relay with `SKIP LOCKED`, handlers that recompute from the database. No Admin API call outside the reconcilers. The route is created in a single PUT with the whole plugin chain, with no open window.
- **Upstream SSRF:** HTTPS only, addresses resolved and checked as public, IPs pinned with `tls.verify`.
- **Rego policy:** `default allow := false`, incomplete input denies, the certificate is really compared against the token and the application's list, and the 68 tests cover the negative cases well.
- **Lua plugins:** they remove every client `X-DEN-*` header, fail closed and neither store nor log the body.
- **Log privacy:** URI-free format, no bodies, nginx access log off, allowlist in Fluent Bit, strict OpenSearch template, OPA without decision logs, filtered error log.
- **Data-subject pseudonym:** HMAC-SHA-256 with a deployment key, fails closed and rejects the example value; the portal derives it from the verified token, never from a parameter.
- **Receipt verifier:** RFC 9162 tree with domain separation, JWS restricted to EdDSA, the verifier's own trust roots, EKU checked. It withstood six new tampering cases.
- **PKI and WireGuard:** the CSR is validated and the names come from the portal; `AllowedIPs /32`, no injection into the SNI map.
- **Web:** tokens only in an encrypted HttpOnly cookie, PKCE with state and nonce, logout that closes the Keycloak session, CSP with nonce and `strict-dynamic`, no `dangerouslySetInnerHTML`.
- **Country neutrality and i18n:** no country terms in product code, with a dedicated guard; key parity between `es` and `en` enforced by a test.
- **Accessibility:** real axe over the 42 screens in both languages, with a coverage test; its limit is that it does not run in CI.
- **Surface published in the pilot:** only 80, 443 and 51820/udp. Segmented networks.
- **Secret generation:** `make-deploy-env` generates them all with `crypto.randomBytes`, writes with mode 600 and refuses to overwrite.
- **npm licenses:** 999 packages compliant; the SPDX parser and the exceptions have no gaps.

---

## 8. The review's tests (uncommitted)

Since 2026-11-18 the report's findings are tracked as stories R-01 to R-11 in docs/BACKLOG.md; a review test joins the suite under a regular name in the commit that fixes its finding (`receipt.review.test.ts` is now `packages/transparency-verifier/src/receipt-tampering.test.ts`).

They match the vitest and `opa test` patterns. **While they exist, `pnpm test` and `pnpm test:policy` fail**, because most of them assert the expected behavior and fail on purpose.

| File | Finding | Result |
| :-- | :-- | :-- |
| `apps/api/src/reconcilers/apisix/orphans.review.test.ts` | A-5, M-08, M-09, M-10 | 6 fail |
| `apps/api/src/reconcilers/apisix/desired-state.review.test.ts` | M-11, M-08 | 3 fail |
| `apps/api/src/transparency/subject-access.review.test.ts` | A-4 | 2 of 3 fail |
| `apps/api/src/auth/mfa-signed-in-bypass.review.test.ts` | M-01 | 3 pass (they document the current behavior) |
| `apps/api/src/entities/entity-status.review.test.ts` | M-04 | fails |
| `apps/api/src/apis/version-lifecycle.review.test.ts` | M-07 | fails |
| `apps/api/src/domain/api-version/compatibility.review.test.ts` | M-18 | 5 of 6 fail |
| `apps/api/src/analytics/usage-slug.review.test.ts` | MB-1 | fails |
| `apps/api/src/audit/chain.review.test.ts` | B-01, B-03 | 3 fail |
| `packages/policy/den/authz_review_test.rego` | M-12, M-13 | 1 error, 1 fails, 1 passes |
| `packages/transparency-verifier/src/receipt.review.test.ts` | receipt tampering | 6 pass |
| `apps/web/src/lib/stale-token.review.test.ts` | M-21 | passes; skipped in `pnpm test` |
| `vitest.web-review.config.mjs` | configuration for the previous one | — |

Run one: `pnpm --filter @den/api exec vitest run <path relative to apps/api>`. The web one: `pnpm exec vitest run -c vitest.web-review.config.mjs`.

Delete them all:

```bash
git clean -n -- '*.review.test.ts' '*_review_test.rego' vitest.web-review.config.mjs   # see what would be deleted
git clean -f -- '*.review.test.ts' '*_review_test.rego' vitest.web-review.config.mjs
```

The file `subject-access.review.test.ts` was written by two reviewers in succession; the second one's version is what remains.

---

## 9. Integration and e2e run (added after the review)

Run against the local stack (`pnpm infra:up`), with all services healthy.

| Suite | Result |
| :-- | :-- |
| Playwright e2e (`pnpm test:e2e`) | 79 pass, 3 fail out of 82 |
| API integration (`pnpm --filter @den/api test:integration`) | 389 pass out of 389, in 56 files |
| Infrastructure integration (`tests/infra`) | 61 pass, 3 fail out of 64 |

The `accessibility`, `security-headers` and `login` specs pass.

Of the six failures, one is a defect in the repository:

- **`apps/web/e2e/citizen-app.spec.ts:17` (defect, in the test):** it generates the identifier `citizenApp-…`, with a capital letter, and the API registration form rejects it. It broke in commit `9de1423`, which renamed the citizen app. Nobody saw it because the e2e tests do not run in CI (M-23). Fix: lowercase prefix.
- **`subject.spec.ts` and three tests in `tests/infra/src/keycloak.int.test.ts` (local environment):** the local Keycloak kept the `den-citizens` realm from before the rename, with the client `carpeta-ciudadana` instead of `citizen-app`. `--import-realm` does not re-import a realm that already exists. They were not repeated with the realm reset.
- **`indicators.spec.ts` (local environment):** the Playwright process crashed; run alone, its three tests pass.

Two consequences outside the tests:

- **Updating an installation from before the rename breaks the citizen app's login.** The existing realm keeps the old client and nothing migrates it. A fresh installation does not suffer from it.
- **A `.env` from before the rename prevents startup:** Compose requires `DEN_CITIZEN_APP_CLIENT_SECRET` and the old file has `DEN_CARPETA_CLIENT_SECRET`. The error is clear, but neither `install.sh update` nor the documentation mentions the rename.

What these suites do not cover, and therefore stays as inference: A-3 (no test counts records under load), A-4, A-5 (the X-Road test uses `http://`) and M-11 (no test asserts which headers the provider sees).
