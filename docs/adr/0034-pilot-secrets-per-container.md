# ADR-0034 — The pilot's secrets: each container its own, no example values, nothing public by default

- Status: Accepted
- Date: 2026-11-19
- Story: R-04 (`docs/BACKLOG.md`), findings A-2, M-24 to M-30, B-16, B-28, B-30, B-31 and B-33 of the 2026-11 general review

## Context

The single-server pilot (`docker-compose.deploy.yml`, `install.sh`) is what operators install for go-live and workshops, and the review found that it was much weaker than the Helm chart:

- `api`, `web` and the reference citizen app loaded the whole `.env` (`env_file`). An environment read or code execution in the web, or in a demo prop published on the internet, handed over the database owner's password, the Keycloak administrator, the CA's password, the signing and pseudonym keys and the backup key. The API kept the schema owner's credential, a cluster superuser that can disable the audit log's insert-only triggers, because its image ran `prisma migrate deploy` on start.
- Nothing stopped a `.env` copied from `.env.example` from running with keys that anyone can read in the repository.
- The API could not tell visitors apart: the web called it from its own address, and the installer left `DEN_TRUST_PROXY` empty.
- Keycloak's administration was published with the portal; one password protected the CA and every provisioner, and the API knew it.
- `install.sh backup` put `.env`, which holds the backup repository's key, next to the encrypted repository.

## Decision

1. **Each container gets only the variables it reads.** The deploy overlay lists them under `environment:` per service; no service uses `env_file`. A static test (`tests/infra/src/deploy-overlay.test.ts`) fails when the code reads a variable its service does not list, or when the web or the citizen app list a platform secret. Variables are passed by name (`VAR:`), so an unset one stays unset and the code's default applies.
2. **Migrations run in a one-shot `migrate` container** with the schema owner's URL (`DATABASE_MIGRATION_URL`), before the API, as the Helm chart's init container does. The API runs as `den_app` only; its image no longer migrates on start.
3. **Example values are refused.** In production the API (NODE_ENV=production), the web and the citizen app (on an address other than loopback) compare their secrets with `.env.example`, which the images carry, and exit when one matches, or when `.env.example` is missing. `install.sh` refuses the same for every secret of the stack, and the deploy overlay requires every secret (`${VAR:?}`).
4. **Proxies are trusted by name.** `DEN_TRUST_PROXY` also takes host names, which the API resolves on the Compose network every 30 seconds: `edge,web` with the bundled proxy, the proxy's container and `web` with one already on the server. The web forwards the visitor's address (the last `X-Forwarded-For` entry, the one the proxy appended) only on requests that carry the proxy's token: Next.js does not expose the web's direct peer, so the proxy proves the hop by setting `X-DEN-Proxy-Token` to `DEN_WEB_PROXY_TOKEN`, overwriting what a client sent; without it the web forwards nothing. The audit log records it for people and applications, never for background jobs.
5. **Nothing administrative is public by default.** The bundled proxy answers 403 on `/auth/admin` and `/auth/realms/master` except from `DEN_KEYCLOAK_ADMIN_ALLOW`; the API calls Keycloak's Admin API inside the network (`DEN_KEYCLOAK_ADMIN_URL`). Each step-ca provisioner has its own password, none of them the CA's. APISIX's public factory key leaves the keyring: the reconciler writes every object with a private key once after each start, so APISIX re-encrypts it with the deployment's key.
6. **Backups keep data and keys apart.** `install.sh backup` no longer copies `.env` and keeps the newest `DEN_BACKUP_KEEP` (5); the build context excludes backups, certificates and generated routes. `install.sh restore-volumes` is the executable "server lost" procedure: it creates the volumes without starting anything, fills them, restores the database into the empty data volume and only then starts.

## Alternatives considered

- **Docker secrets (files under `/run/secrets`) instead of environment variables.** Stronger against an environment dump, but every component would have to read files, Keycloak's realm import and APISIX's configuration only take variables, and the Helm chart already maps Secrets to variables. The per-container lists close the finding (a compromised web no longer sees the database) without that rewrite.
- **Fixed addresses for the proxy and the web** (a subnet per network and `ipv4_address`). It changes the IPAM of networks that existing pilots already have, and pools collide with the host's other networks; resolving names needs none of that.
- **Keeping the factory key until the next certificate renewal.** It leaves a public key in the keyring for up to 90 days on every pilot; rewriting a handful of objects on start costs nothing.
- **Encrypting the backup's copy of `.env` with a passphrase.** One more secret to keep and type during `update`; not copying it at all is simpler and the operator already keeps `.env` off the server.

## Consequences

- An existing pilot upgrades with `sudo ./install.sh update`, which adds the new variables (`DEPLOYMENT.md §5.4`, R-04). The first start replaces the provisioners' key pairs and the critical demo accounts' password; the gateway answers 503 until the API has rewritten its objects.
- A variable added to the code must be added to its service in the overlay; the test says which.
- The pilot's demo users with a critical role have their own password (`install.sh credentials`); the shared one can be handed out at a workshop.
- Not done here: the Helm chart still decrypts the intermediate CA key and the provisioners with one password, and pins its images by tag; the logical dumps in a backup are not encrypted.
