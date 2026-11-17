# OWASP ASVS 5.0 level 2 review (M6-01)

> Versión en español: [docs/es/security/ASVS-L2.md](../es/security/ASVS-L2.md)

- Date: 2026-11-16 · Scope: portal (`apps/web`, `apps/api`), gateway (APISIX, OPA, `den-*` plugins), Keycloak, Compose infrastructure (development and pilot).
- Method: review against the code and the configuration, not against the documentation, chapter by chapter of ASVS 5.0 (V17 WebRTC does not apply). Each finding was verified in the code before it was recorded.
- Statuses: **Meets** · **Fixed** (in this story) · **Partial** · **Pending** (with a target) · **Not applicable**.

## Summary

The core meets the standard: authorization in the backend with per-entity isolation, token validation, SSRF defense, document storage, nonce-based CSP and a chained audit log.

M6-01 fixed what could be fixed without changing the topology: request limits, API headers, security events, password policy, exact OIDC URIs, network segmentation, APISIX's own keyring, a minimal plugin list, dependency scanning and the operator's paginated queue.

What required a different topology (TLS and authentication between internal components, Keycloak in production mode, a secrets vault), the SBOM, and the API logs in the central pipeline went into the M6-05 Helm chart (fixes 14 to 19), which has yet to be installed. Antivirus for documents was added in M6-08 (fix 20).

## M6-01 fixes

| # | Finding | Fix | Test |
| :-- | :-- | :-- | :-- |
| 1 | No request limit (2.4.1) | `@fastify/rate-limit` in the API, before reading the body:<br>• quota per verified user, or per address if the token is not valid: forging tokens does not grant new quotas (`DEN_RATE_LIMIT_PER_MINUTE`, 600);<br>• strict quota on expensive routes (uploads, new versions, onboarding requests, invitations, node enrollment; `DEN_RATE_LIMIT_STRICT_PER_MINUTE`, 30);<br>• no limit only on the control routes of the platform services, each with its own credential, recognized by route template;<br>• `X-Forwarded-For` only from the proxy's address (`DEN_TRUST_PROXY`);<br>• 429 in RFC 9457.<br>The proxy adds per-address limits on `/api/v1` and `/auth` (`infra/edge/den.yml.template`). | `common/rate-limit.int.test.ts`, `trust-proxy.test.ts` |
| 2 | An upload with a forged token was read (10 MiB) before the 401 | The upload hook actually verifies the JWT before reading the body | `common/rate-limit.int.test.ts` |
| 3 | API responses without security headers (3.4.x, 4.1.x) | `nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, HSTS and `Cache-Control: no-store` (unless the endpoint declares otherwise) | `health/health.controller.test.ts` |
| 4 | Rejections without an attributable record (16.3.1-16.3.3) | One JSON line for each 400/401/403/404/409/429: who (`sub`), from where (IP with `DEN_TRUST_PROXY`, user agent), what (route template, path without query) and why. Never the query, the token or the body | `common/security-event.test.ts` |
| 5 | Keycloak recorded only login errors and credential changes | LOGIN, LOGOUT, REGISTER, CODE_TO_TOKEN_ERROR, REFRESH_TOKEN_ERROR, RESET_PASSWORD and VERIFY_EMAIL events, plus admin events | Realm `den-portal` |
| 6 | No password policy with open registration (6.2.x) | `length(12) and maxLength(128) and notUsername and notEmail and passwordHistory(5)` | Realm `den-portal` |
| 7 | Redirect URIs with wildcards (10.4.1) | Exact URIs: the Auth.js callback, the per-language home pages and the citizen folder's callback | Realms `den-portal` and `den-citizens` |
| 8 | etcd and OPA without authentication, reachable from any container (13.2.1); gateway egress to the platform networks (pending from M1-08) | Segmentation into three networks:<br>• `gateway`: gateway control, with etcd and OPA only there;<br>• `providers`: upstreams and the contract runner;<br>• `default`: the platform.<br>The gateway cannot reach the database, the CA, OpenSearch or mail. Upstreams cannot reach etcd, OPA, the platform or the API (in the pilot the API shares a `runner` network with the contract runner, for the two of them only) | `tests/infra/src/networks.int.test.ts` (development and pilot) |
| 9 | APISIX's factory keyring, which is public (S-6) | A keyring of its own per deployment (`DEN_APISIX_KEYRING`). The factory key remains only to read what was written before, until it is rewritten (certificate renewal, ≤ 90 days) | `tests/infra/src/gateway.int.test.ts` |
| 10 | All APISIX plugins enabled, including serverless functions (15.2.3) | Only the fifteen that the portal's routes use; `serverless-*`, `inspect`, `echo` and the `ai-*` plugins are left out | `tests/infra/src/gateway.int.test.ts` |
| 11 | No vulnerability scanning (15.2.1) | `pnpm audit --audit-level high` in CI and a remediation policy (below) | `.github/workflows/ci.yml` |
| 12 | Truncated GCM tag accepted (to be confirmed) | `authTagLength: 16` when opening sealed secrets | `common/secrets.test.ts` |
| 13 | The operator's onboarding queue showed only the 200 oldest | Cursor pagination in the API and the console | `entities/entity-requests.int.test.ts` |

## M6-05 (Helm chart) and M6-08 fixes

The M6-05 fixes (14 to 19) are in `infra/helm/den` and were validated only statically (`helm template` and kubeconform). The chart has not been installed on any cluster (`DEPLOYMENT.md §9`). Fix 20 (M6-08) also runs in the pilot.

| # | Pending item | Fix | Test |
| :-- | :-- | :-- | :-- |
| 14 | Internal components without TLS or authentication of their own (12.3.x, 13.2.1) | Internal PKI with cert-manager:<br>• etcd with mTLS and its own CA, which signs only its members and the gateway;<br>• OpenSearch with TLS and its security plugin, with one user per client and only the permissions it uses;<br>• Postgres with `sslmode=verify-full`;<br>• the OPA API only on the loopback of the gateway pod, with the diagnostics listener separate | `helm template` + kubeconform |
| 15 | Keycloak in `start-dev` and realms with test users (13.4.2) | `start` with production realms: `pnpm helm:sync` removes the personas and sets the deployment's SMTP | `tests/infra/src/helm-files.test.ts` |
| 16 | Secrets in `.env` (13.3.x) | One Secret per component with only its keys, from OpenBao through External Secrets | `helm template` |
| 17 | Unrestricted network egress | Ingress and egress NetworkPolicies per component. Outbound, only public addresses on the ports each one uses | `helm template` + kubeconform |
| 18 | No SBOM or image scanning (15.1.2, 15.2.1) | CycloneDX SBOM and Trivy in CI: a high or critical vulnerability with a fix available stops the release. API and web images without development dependencies or a package manager | `.github/workflows/images.yml` |
| 19 | API logs outside the central pipeline, unmasked (16.4.3, 14.x) | Every line masked (queries, numbers of 6 digits or more, email addresses, credentials in URLs). In the chart, JSON for the cluster's log collector | `common/logger.test.ts` |
| 20 | Documents without antivirus (5.4.3) | ClamAV (`clamd`, M6-08) scans each document before storing it; an infected one is rejected and, if ClamAV does not respond, the upload fails. Enabled in the chart; optional in the pilot (`--profile antivirus`) | `documents/antivirus.test.ts`, `documents/antivirus.int.test.ts` |
| 21 | A single `DEN_SECRETS_KEY`, with no identifier or rotation (11.1) | Each sealed value names its key (`v2.<kid>`); `DEN_SECRETS_KEYS_PREVIOUS` opens older values (including the `v1` format) and `secrets:reseal` seals them again with the current key, idempotently and with an audit record | `common/secrets.test.ts`, `secrets/reseal.int.test.ts` |

## Status by chapter

| Chapter | Status | Notes |
| :-- | :-- | :-- |
| V1 Encoding and Sanitization | Meets | React escapes output and there is no HTML in markdown. Prisma everywhere (the only raw query is a constant). `subprocess` without a shell. SSRF defense with pinned DNS. YAML with an alias limit. Sanitized file names. Plain-text email |
| V2 Validation and Business Logic | Meets · Fixed | zod with strict objects on every `@Body`/`@Query`; guarded transitions. **Fixed:** anti-automation (1, 2). **Partial:** every re-upload of the designation document is stored (rate limit yes; per-request cap pending) |
| V3 Web Frontend Security | Meets · Fixed | CSP with nonce and `strict-dynamic`, HSTS, `__Host-`/`__Secure-` HttpOnly SameSite cookies, CSRF (bearer-only API). **Fixed:** API headers (3). **Partial (low):** opening a notification via GET marks it as read |
| V4 API and Web Service | Meets | JSON and PDF only, body limits, `X-DEN-*` headers that the client cannot set, RFC 9457 errors |
| V5 File Handling | Meets · Fixed | Size, magic bytes, random names outside the web root, download with `attachment`. **Fixed:** antivirus with ClamAV before storing, failing closed (20) |
| V6 Authentication | Fixed · **Decision** | **Fixed:** password policy (6). Keycloak brute-force protection, TOTP, notification of credential changes. **Pending decision (6.3.3):** today the second factor is required for platform roles and for `data_steward`. L2 asks for it on all access; extending it to `entity_admin` and `api_publisher` changes how entities and demo users sign in |
| V7 Session Management | Meets | Roles and status from the database on every request, inactivity and absolute expiration, RP-initiated logout. To be confirmed: Keycloak's account console for ending other sessions |
| V8 Authorization | Meets | Central policy, fails closed without an access declaration, per-entity isolation (404 outside it), roles that take effect immediately. Traffic is authorized by OPA, which fails closed |
| V9 Self-contained Tokens | Meets | RS256 against the issuer's JWKS, `exp`/`iss`/`aud`; the gateway validates before OPA |
| V10 OAuth and OIDC | Meets · Fixed | Authorization code with PKCE S256, no implicit or password grant, confidential clients with certificate-bound tokens. **Fixed:** exact URIs (7) |
| V11 Cryptography | Meets · Fixed | AES-256-GCM with a random IV and AAD, system randomness, constant-time comparisons. **Fixed:** GCM tag (12). **Fixed:** key identifier and rotation for `DEN_SECRETS_KEY` (21) |
| V12 Secure Communication | Meets · Fixed in the chart | External TLS, certificate verification towards providers, mTLS for applications and nodes. **Fixed in the Helm chart (M6-05, 14):** etcd with mTLS and its own CA, OpenSearch with TLS, Postgres with `verify-full`, OPA only on the pod's loopback. The Compose pilot still relies on the internal network as its only barrier |
| V13 Configuration | Fixed · Fixed in the chart | **Fixed:** segmentation (8), keyring (9), plugins (10). Least-privilege database role. **Fixed in the chart (14 to 17):**<br>• etcd with mTLS and OpenSearch with its security plugin;<br>• Keycloak in `start` (production mode) with realms without test users;<br>• Fluent Bit image without `-debug`;<br>• secrets from OpenBao through External Secrets;<br>• ingress and egress NetworkPolicies per component |
| V14 Data Protection | Meets · Fixed | No sensitive data in URLs or logs; no bodies; field allowlist; keyed pseudonyms. **Fixed:** the pseudonym key in OPA's data can no longer be reached from the upstreams (8). In the chart, the OPA API listens only on the gateway pod's loopback (14) |
| V15 Secure Coding and Architecture | Fixed | Non-root containers, explicit `select`, concurrency locks. **Fixed:** dependency scanning (11); SBOM and image scanning with Trivy in CI, and production images without development dependencies or a package manager (18) |
| V16 Security Logging and Error Handling | Fixed · Partial | Log inventory (§8), protected and anchored audit log, generic errors. **Fixed:** API and Keycloak security events (4, 5). **Fixed:** API lines are masked and, in the chart, emitted as JSON for the cluster's log collector, which forwards them to the operator's central system (19) |

## Pending items and their target

| Pending item | ASVS | Target |
| :-- | :-- | :-- |
| Second factor for `entity_admin` and `api_publisher` | 6.3.3 | Operator decision. If adopted, it is configuration plus a guide for the entities |
| Verify on a cluster what was fixed in the chart (14 to 19): it has not been installed | 12.3.x, 13.x, 16.4.3 | M6-05 (installation) |
| Cap on re-uploads of the designation document | 2.3.2 | Minor improvement (rate-limited today) |
| Remove the factory key from APISIX's keyring | 11.x | Operations: after the deployment's first certificate renewal |

## Vulnerability remediation policy

| Severity (CVSS / vendor advisory) | Deadline to fix or mitigate in production |
| :-- | :-- |
| Critical | 7 days |
| High | 30 days |
| Medium | 90 days |
| Low | In the next planned release |

CI fails on high or critical vulnerabilities in the dependencies (`pnpm audit --audit-level high`). A temporary exception is documented in the PR with its mitigation and its review date.
