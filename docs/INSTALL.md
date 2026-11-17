# Installing on a server — DEN Portal (portal + gateway)

> Versión en español: [docs/es/INSTALL.md](es/INSTALL.md)

Version 1.1 · November 2026 · code as of M5 closed and M6 in progress

This guide installs **the whole central platform** (portal, gateway, identity, CA, timestamping, logs) on **a single Linux server** with an interactive script: `sudo ./install.sh`. This is the **pilot** topology (`DEPLOYMENT.md §1`). It is meant for the go-live with the operator, the entity bootcamp and demos. Production, with high availability, is a separate exercise: that is the Helm charts of M6-05.

> **What it does NOT install.** The instant API kit that runs at the entities is a separate product, with its own repository (ADR-0011). What each entity must have is in [`guides/entities.md`](guides/entities.md), and what providers need is in the providers guide in the kit repository.

## 1. Server requirements (VPS)

### 1.1 Size

| | Minimum (without observability) | **Recommended (bootcamp, with observability)** |
| :-- | :-- | :-- |
| vCPU | 4 | **4–8** |
| RAM | 8 GB | **16 GB** |
| Disk | 60 GB SSD | **100 GB SSD** |
| System | 64-bit Linux x86_64 or arm64 with kernel ≥ 5.6: Ubuntu 22.04/24.04 LTS, Debian 12 or RHEL/Rocky 9 | Ubuntu 24.04 LTS |

Where the numbers come from (measured on the demo pilot, November 2026):

- **At rest**, the full stack uses about **2.3 GB of RAM**: Keycloak ~650 MB, OpenSearch ~670 MB, APISIX ~190 MB, API ~150 MB, web ~120 MB, and the rest under 70 MB each.
- **The real peak is the build** of the portal and API images during installation and on every update: 3–4 GB more for 10–20 minutes. It works with 8 GB; 16 GB leaves headroom for the bootcamp, with many people connected at once.
- **Disk:** the images take ~15 GB and the build cache grows with every update (it reached 17 GB on the pilot). The data is small at first (the database ~100 MB), but analytics and the audit log grow with traffic.
- Kernel ≥ 5.6 ships WireGuard. Without it, the hub uses `wireguard-go`, which works but performs worse.

### 1.2 Network and DNS

| What | Details |
| :-- | :-- |
| **Fixed public IP** | The server must be reachable from the internet (the entities and their systems connect to it) |
| **Two DNS names** (A record) pointing to that IP | **Portal**, e.g. `portal.den.example`: people, web portal, portal API and sign-in. **Gateway**, e.g. `gw.den.example`: system-to-system traffic, with mTLS |
| **Inbound** | `443/tcp`: portal and gateway, on a single port, told apart by name (SNI). `80/tcp`: only for Let's Encrypt and the redirect to HTTPS. `51820/udp`: WireGuard tunnels from the kit nodes |
| **Outbound during installation** | HTTPS to Docker Hub, quay.io, ghcr.io, the npm registry and PyPI (images and build dependencies) |
| **Portal certificate** | Let's Encrypt, automatic, or the entity's own certificate (PEM with the full chain and the private key) |
| **Gateway certificate** | No need to request one: the network CA (step-ca) issues it. Systems trust it through the network root |

No other service may be on 80 or 443. If the server already runs Traefik, the installer can join it (§3, step 4).

**Before Tuesday:**

- [ ] VPS created, with `root` or `sudo` access over SSH.
- [ ] Both DNS records created and propagated: `getent hosts <name>` must return the server's IP.
- [ ] Ports 80/tcp, 443/tcp and 51820/udp open in the cloud provider's firewall.
- [ ] `git` installed and the repository cloned on the server.

### 1.3 Software

The installer checks everything, and if Docker is missing it offers to install it with the official script (`get.docker.com`).

- Docker Engine with the Compose plugin ≥ 2.26.
- `git`, `curl`, and `openssl` for the checks.
- Node.js is **not** needed on the server: the helper scripts run in a `node` container.

## 2. Installation

```bash
git clone <repository-url> den && cd den
sudo ./install.sh
```

The script asks its questions one at a time, shows a summary and asks for confirmation before touching anything. Then it builds and starts everything (10–20 minutes the first time) and checks that it works.

## 3. The questions, one by one

| Step | Question | What to answer |
| :-- | :-- | :-- |
| 1 | — | Server check: system, CPU, RAM, disk, Docker, `/dev/net/tun`. It stops if something essential is missing |
| 2 | **Country** | The code of `config/country/<code>.yaml`. For example, `co` (Colombia) |
| 3 | **Portal name** | Just the name, without `https://` (e.g. `portal.den.example`) |
| 3 | **Gateway name** | Defaults to `gw.<portal>`. It must differ from the portal |
| 4 | **Inbound proxy** | `1` Bundled (recommended): the installer puts Traefik on 80/443. `2` I already have Traefik: it joins its Docker network and writes the routes of the portal and the gateway for it (file provider). It asks for the HTTPS entryPoint (`websecure`), the certResolver for the portal's certificate (`-`: your Traefik already has it) and Traefik's dynamic folder on this server (`-`: it only writes `infra/edge/den-external.yml`, for you to copy) |
| 4 | **Portal certificate** | `1` Let's Encrypt (contact email optional; port 80 must be reachable). `2` Your own: paths to the certificate (full chain) and to the private key, in PEM. It must come from a recognized public CA: the API and the web also call the portal by its name and verify the certificate |
| 5 | **Observability** (OpenSearch, Prometheus, Alertmanager, Grafana) | Yes, if the server has 16 GB: it provides the usage indicators, email alerts and the operator dashboard at `/grafana`. You can do without it: it does not affect traffic, audit or transparency |
| 5 | **Document antivirus** (ClamAV) | Yes, if the server has 8 GB: it scans every uploaded document before storing it. Adds ~1.2 GB of RAM and downloads its signatures from the internet |
| 6 | **Password for the demo users** | Enter generates a random one. Choose one if you are going to share it at the bootcamp |

Then, with no more questions:

- **Step 7.** Writes `.env` (mode 600) with all the secrets generated at random: database passwords, signing keys, the pseudonym key, the WireGuard hub key and the internal tokens.
- **Step 8.** Creates the Docker network, sets `vm.max_map_count` for OpenSearch and, if it detects `ufw` or `firewalld`, offers to open the ports.
- **Step 9.** Builds and starts everything, and waits until every service is healthy.
- **Step 10.** Checks five things:
  - that the API responds;
  - that the OPA bundle is **not** exposed to the public;
  - that Keycloak responds;
  - that OPA already has a policy;
  - that the gateway presents the network certificate.

> **Keep `.env` off the server**, encrypted. Without it, the data cannot be recovered and receipts already issued cannot be verified (`DEPLOYMENT.md §4.1`). Running `./install.sh` again **never** regenerates it: it reuses its secrets and answers.

## 4. What ends up installed

| URL | What it is | Who uses it |
| :-- | :-- | :-- |
| `https://<portal>` | Portal: catalog, consoles for the operator, the regulator and the entities | People |
| `https://<portal>/api/v1` | Portal API | The web, integrations |
| `https://<portal>/auth` | Keycloak: sign-in, second factor, admin console at `/auth/admin/` | People, operator |
| `https://<gateway>` | **Gateway**: traffic between entities with mTLS, tokens at `/oauth/token`, control channel for the nodes | Entity systems |
| `<gateway>:51820/udp` | WireGuard hub: tunnels from the kit nodes | Nodes |
| `https://<portal>/mail` | Test mailbox (Mailpit): all the pilot's email arrives here, behind a user and password | Operator |
| `https://<portal>/citizen-app` | Reference citizen app (transparency demo) | Demos |
| `https://<portal>/grafana/` | Operator dashboard (with observability enabled), with its own `admin` user | Operator |

The other services (PostgreSQL, etcd, OPA, step-ca, TSA, Fluent Bit, OpenSearch, the contract runner, the test providers) are not published. Each one is explained in [`guides/operator.md`](guides/operator.md).

## 5. End-to-end check

1. `sudo ./install.sh status`: all services `healthy` (`tsa-init` finishes, with `exited (0)`).
2. `sudo ./install.sh credentials`: sign in to the portal as `ana.operadora`. It asks for a second-factor code, which `sudo ./install.sh otp` gives you.
3. The gateway requires a client certificate. Without one, the TLS handshake fails:
   ```bash
   curl -v https://<gateway>/      # → TLS error: "certificate required"
   ```
4. **Full walkthrough:** the script in [`DEMO.md`](DEMO.md) (publish, review, request, approve, call) with the demo users. The automated rehearsal is in `OPERATIONS.md §2.2`.

## 6. Demo data and first administrator

The pilot **always** loads the seed: three fictitious entities (the operator, a health entity, a social programs entity) and the demo users with their roles. That is how the first `platform_admin` (`pablo.plataforma`) exists: today there is no other way to create it (`DEPLOYMENT.md §8`). For the bootcamp:

- real entities are onboarded from the portal (self-registration and an onboarding request, or direct registration by the `platform_admin`);
- the fictitious entities are for practice;
- before real use, the operator creates the accounts for its people and assigns them roles. In production there are no seed users.

## 7. Day-to-day commands

| Command | What it does |
| :-- | :-- |
| `sudo ./install.sh status` | Container status and the step 10 checks |
| `sudo ./install.sh credentials` | Demo users, Keycloak administrator, test mailbox user and Grafana user |
| `sudo ./install.sh otp` | Current second-factor code for the demo users with a critical role |
| `sudo ./install.sh logs [service]` | Logs (e.g. `logs api`) |
| `sudo ./install.sh backup` | Full pgBackRest backup and a copy in `backups/<date>/`: dumps of `den` and `keycloak`, the backup repository (encrypted), the CA, TSA, documents and citizen app volumes, and `.env`. Daily backups already run on their own (`OPERATIONS.md §6`) |
| `sudo ./install.sh restore [instant]` | Restores the database to the last archived state, or to the given instant (`"2026-11-20 14:30:00-05"`). Stops and starts everything |
| `sudo ./install.sh update` | Backup, `git pull --ff-only`, rebuild and restart |
| `sudo ./install.sh stop` / `start` | Stops or starts everything, without losing data |

The Compose equivalent, for the commands in `OPERATIONS.md`, with the bundled proxy:

```bash
alias dc='docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml \
  -f infra/compose/docker-compose.edge.yml --env-file .env --profile observability'
```

Without observability, remove `--profile observability`; with the antivirus, add `--profile antivirus`; with your own Traefik, remove `-f infra/compose/docker-compose.edge.yml`.

An `.env` written by hand or by `make-deploy-env.mjs` (like the one on the demo pilot) does not have the installer's answers. Add `DEN_PORTAL_HOST`, `DEN_GATEWAY_HOST`, `DEN_INSTALL_PROXY` (`bundled` or `external`), `DEN_INSTALL_TLS`, `DEN_INSTALL_OBSERVABILITY` and `DEN_INSTALL_ANTIVIRUS` (`true` or `false`; with the antivirus, also `DEN_CLAMAV_URL=tcp://clamav:3310`), or keep using Compose directly.

## 8. Common installation problems

| Symptom | What to do |
| :-- | :-- |
| "Puertos ocupados" (ports in use) | Another service is using 80/443 (`ss -ltnp`). Stop it or choose option 2 in step 4 |
| The portal shows an invalid certificate | Let's Encrypt could not validate: the portal's DNS does not point here or port 80 is closed. Fix it and wait, because Traefik retries on its own. `sudo ./install.sh logs edge` |
| A service does not become healthy and the installation stops | `sudo ./install.sh logs <service>`. Keycloak can take up to 5 minutes on a small machine. Run `sudo ./install.sh` again |
| OpenSearch keeps restarting | Not enough memory, or `vm.max_map_count`. Reinstall without analytics or add RAM |
| Sign-in loops | The portal name does not match the one in `.env` (`DEN_PUBLIC_URL`). `OPERATIONS.md §7` |
| The nodes do not connect | 51820/udp closed in the cloud firewall, or the gateway's DNS does not point here (`DEN_WG_HUB_ENDPOINT`) |
| `.env` was lost | Without a copy, there is no recovery: reinstall from scratch, deleting the `den_*` volumes |

More diagnostics in `OPERATIONS.md §4` and §7.

## 9. Uninstalling

```bash
sudo ./install.sh stop
# Deletes containers AND DATA (databases, CA, audit log). Irreversible: back up first.
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml \
  -f infra/compose/docker-compose.edge.yml --env-file .env --profile observability down --volumes
docker network rm den-edge
```
