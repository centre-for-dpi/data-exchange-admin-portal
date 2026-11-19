# Keycloak (development)

At startup, Keycloak imports (`--import-realm`) the `*-realm.json` files in this folder. The secrets are not in the files: they are `${VARIABLE}` placeholders that Keycloak resolves from the container's environment variables (see `.env.example`).

> The import uses the `IGNORE_EXISTING` strategy: if you change a realm file, apply the change with `pnpm infra:reset && pnpm infra:up` (this deletes the local data).

## Realm `den-portal` (people)

- Client `den-portal-web`: confidential, Authorization Code + PKCE S256, no password grant. The access token carries `aud = den-portal-api` and lasts 5 minutes.
- Self-registration with mandatory email verification (ADR-0018): you cannot sign in without confirming your email. A new account has no roles; it can only request onboarding for an entity and accept invitations addressed to its email. Brute-force protection; verification and recovery emails through Mailpit.
  - On a Keycloak that has already imported the realm, apply the change without deleting data: `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update realms/den-portal -s registrationAllowed=true -s verifyEmail=true` (after `kcadm.sh config credentials`).
- The verification and password reset links last 60 minutes (`actionTokenGeneratedByUserLifespan`; Keycloak's default is 5, P-08). On a Keycloak that has already imported the realm: `node scripts/keycloak-portal-mfa.mjs`.
- Seed users with fixed IDs (the database seed links them by `keycloakSub`). Password: `DEN_DEMO_USER_PASSWORD` (`den-demo-password` by default, development only); those with a critical role (an OTP credential) have `DEN_DEMO_CRITICAL_PASSWORD`, the same one in development and a password of their own in a pilot (M-29). The realm's SMTP server comes from `DEN_KEYCLOAK_SMTP_*` (Mailpit by default, M-28). **Roles do not live here**: the seed assigns them in PostgreSQL (ADR-0004).

| User | ID (`sub`) | Role planned in the seed |
| :-- | :-- | :-- |
| `ana.operadora` | `0193a6c0-0000-7000-8000-000000000001` | `platform_reviewer` |
| `pedro.publicador` | `0193a6c0-0000-7000-8000-000000000002` | `api_publisher` (health entity) |
| `lucia.datos` | `0193a6c0-0000-7000-8000-000000000003` | `data_steward` (health entity) |
| `carlos.dev` | `0193a6c0-0000-7000-8000-000000000004` | `app_developer` (social programs entity) |
| `marta.regulador` | `0193a6c0-0000-7000-8000-000000000005` | `regulator` |
| `pablo.plataforma` | `0193a6c0-0000-7000-8000-000000000006` | `platform_admin` |
| `sofia.auditora` | `0193a6c0-0000-7000-8000-000000000007` | `auditor` |
| `elena.admin` | `0193a6c0-0000-7000-8000-000000000008` | `entity_admin` (health entity) |

- **Second factor (M3-08, ADR-0021).** The `den-browser` browser flow has two levels: password (`acr=password`) and TOTP code (`acr=mfa`, `acr.loa.map` mapping). Keycloak asks for the code only when the web requests `acr_values=mfa`, and the API requires it for the platform roles, for `data_steward` and for `entity_admin` (ADR-0035). Anyone without a configured code goes through `CONFIGURE_TOTP`. A code works only once.
  - The seed users with those roles (`ana`, `lucia`, `marta`, `pablo`, `sofia`, `elena`) come with an OTP credential using the key `DEN_DEMO_TOTP_SECRET`. The key is used as is, as UTF-8 bytes, not base32. `pnpm demo:otp` gives the current code and the key in base32 for an authenticator app.
  - Every time a credential (password or second factor) is set or removed, Keycloak writes to the account owner and keeps the event for 90 days. The `email` listener is limited to those events with the startup option `--spi-events-listener--email--include-events` (compose), so a failed login does not generate an email. This is the mitigation for enrollment on first use (`ARCHITECTURE.md §3.1`).
  - On a Keycloak that has already imported the realm, apply it without deleting data: `node scripts/keycloak-portal-mfa.mjs --demo-otp`.
- **In a pilot (P-08)**, once the operator's people have their platform roles, `sudo ./install.sh demo-users disable` disables these users in Keycloak and in the portal and revokes their platform roles; the seed and `--demo-otp` leave them disabled afterwards.

## Realm `den-gateway` (consumer applications)

- No applications: the `den-app-<uuid>` clients are created by the portal's reconciler.
- Only three client scopes: `basic` (`sub`), `service_account` (`client_id`) and `den-gateway-audience` (`aud = den-gateway`). Application tokens carry no profile, email, roles or client IP. They last 5 minutes.
- Client `den-portal-provisioner` with a service account: only `realm-management/manage-clients` in this realm. It cannot see users or roles, or touch other realms.
- **Certificate-bound tokens (M3-10, ADR-0022).** With `features.mtls.required`, the reconciler sets `tls.client.certificate.bound.access.tokens = true` on each `den-app-<uuid>` client. The application authenticates with its secret and requests the token from the gateway (`POST <gateway>/oauth/token`). APISIX verified its certificate during the handshake and passes it to Keycloak in `SSL_CLIENT_CERT`, which Keycloak reads with the `nginx` x509 provider (startup options in the compose file). Requested directly from Keycloak, without a certificate, the token is denied (`400 invalid_request`).
- Client policy `den-secret-rotation` (M3-04): on clients with the attribute `den.managed = true` (the ones the portal creates), regenerating the secret keeps the previous one as a rotated secret, valid for at most 30 days. The portal uses it for the rotation window and closes it early on revocation.
  - On a Keycloak that has already imported the realm, apply it without deleting data: `node scripts/keycloak-client-policies.mjs` (it uses `KEYCLOAK_URL` and the `master` administrator from `.env`).

## Realm `den-citizens` (citizens, MT-05)

Simulates the national digital identity, which in production is the country's own (`DEN_CITIZEN_ISSUER`).

- Client `citizen-app`: the reference citizen app (MT-07, `DEN_CITIZEN_APP_URL`). It is confidential, uses Authorization Code + PKCE S256 and has no password grant. The access token carries `aud = den-transparency-api`, `sub` and the verified document (`document_type`, `document_number`); no name or email. It lasts 5 minutes.
  - A realm imported before the rename (commit `9de1423`) has `carpeta-ciudadana` instead: `node scripts/keycloak-citizen-app.mjs` creates `citizen-app` from this file and deletes the old client, without deleting data (`install.sh realms` runs it; `docs/DEPLOYMENT.md` §5.4).
- The document is set by the identity provider: the user profile only lets the administrator edit it.
- Seed citizens, with password `DEN_DEMO_USER_PASSWORD`:

| User | ID (`sub`) | Document |
| :-- | :-- | :-- |
| `ciudadana.demo` | `0193a6c0-0000-7000-8000-000000000101` | CC 1000000001 |
| `ciudadano.otro` | `0193a6c0-0000-7000-8000-000000000102` | CC 1000000002 |

These are the numbers the e2e tests and the demo use: `ciudadana.demo` sees, in the data subject API, the queries the gateway recorded with their number.

## Tests

- `pnpm test` includes static checks of these files (`tests/infra`).
- `pnpm test:integration` (with the stack up) does a real login with each seed user, tests step-up to the second factor (and the rejection of a wrong or reused code) and the provisioner's permissions.
