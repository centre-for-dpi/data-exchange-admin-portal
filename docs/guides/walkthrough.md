# Full walkthrough: from the first account to the first lookup

> Versión en español: [docs/es/guides/walkthrough.md](../es/guides/walkthrough.md)

This guide goes, step by step and in order, through everything real people do so that one entity publishes an API on the network and another one consults it: creating the accounts, onboarding the entities, installing the node, publishing, approving, requesting access and making the first lookup. It comes from a complete rehearsal done by hand on a test network, with accounts created from scratch (2026-11-18). The portal's screens are in Spanish by default; their names are given in English here (switch the language at the top of the portal).

Example values; replace them with yours:

| What | Example |
| :-- | :-- |
| Portal | `https://portal.example.org` |
| Gateway (its own name, for mTLS) | `https://gateway.example.org` |
| Provider entity | *Civil Registry*, identifier `civil-registry`, NIT `900000100` |
| Consumer entity | *Ministry of Welfare of Wakanda*, identifier `bienestar-wakanda`, NIT `900000200` |
| API | *Affiliation certificate*, identifier `certificados-afiliacion` |

## Who does what

| Role | Who | What they do in this walkthrough |
| :-- | :-- | :-- |
| **Network operator** | The team that runs the network (for example, the country's digital agency) | Approves entity onboarding and API publications; holds the platform roles |
| **Portal server administration** | Whoever has access to the server where the portal runs | Grants the platform roles with a command |
| **Entity administrator** | Whoever requests the entity's onboarding | Registers the entity's node and hands over its token |
| **Data steward** of the provider | Designated in the onboarding | Approves or rejects each access request to its APIs |
| **Technical lead** of the provider | Designated in the onboarding | Publishes the entity's APIs |
| **Infrastructure** of the provider | The team that runs its servers | Installs the node and connects the API |
| **Development** of the consumer | Whoever builds the application that consults | Creates the application, its certificate and requests access |

One person can hold several roles in their entity (in this example's consumer, one person is administrator, data steward and technical lead). What the portal never allows is approving what you yourself requested.

## Before you start

- **An authenticator app** on a phone (Google Authenticator, Microsoft Authenticator or any TOTP app). Critical roles need it: the platform roles and the data steward.
- **Password:** at least 12 characters, different from the username and the email, not one of the last 5.
- **The verification link lasts 60 minutes** (5 before P-08; `sudo ./install.sh update` applies it to an existing installation). Have the mailbox open before registering. On a test network the portal's emails go to the test mailbox (`/mail`), not to the internet: made-up addresses work there.
- **Use one private window per person** when playing several roles from the same computer, so sessions do not mix.

## 1. The operator's team

No screen grants the platform roles yet (`platform_admin`, `platform_reviewer`, `regulator`, `auditor`): they are granted on the portal's server.

1. **Each person of the operator** opens the portal, clicks **Sign in → Register**, fills in username, email, name and password, **verifies the email** and **signs in once**. The portal says they have no roles yet: expected. Signing in once is what creates them in the portal.
2. **Whoever administers the portal's server** grants the role:

   ```bash
   sudo ./install.sh platform-role grant <email> platform_reviewer --reason "Review team"
   sudo ./install.sh platform-role grant <email> platform_admin --reason "Technical team"
   sudo ./install.sh platform-role list
   ```

   Roles: `platform_admin` (technical team: everything operational), `platform_reviewer` (reviews and approves onboarding and APIs), `regulator` (oversees and approves what is sensitive), `auditor` (reads the audit log). The change is recorded in the audit log with its reason. To take it away: `revoke`. The command never leaves the network without a `platform_admin`. If your installation does not have the command, update the portal to a version that includes it.
3. **The person signs in again.** Keycloak shows a **QR code**: they scan it with the authenticator app and type the 6-digit code. From then on they see the **Operator console**.
4. **Once the operator's own team has its roles**, whoever runs the server disables the demo accounts the pilot ships with (they hold platform roles and the demo password):

   ```bash
   sudo ./install.sh demo-users list
   sudo ./install.sh demo-users disable --reason "Operator team has its roles"
   ```

   The installer cannot undo it, and the rehearsal with the demo personas stops working. It refuses while there is no active `platform_admin` of the operator's own.

## 2. The provider entity requests its onboarding

**Who:** the person who will be the entity's administrator.

1. Registers as in step 1.1 (register, verify, first sign-in). They see "You have no roles in an entity yet".
2. Goes to **Entity onboarding** and creates a request:

   | Field | Example |
   | :-- | :-- |
   | Legal name / Short name | `Civil Registry` |
   | Identifier | `civil-registry` (the first segment of the gateway's routes: it does not change later) |
   | Identifier type and number | `NIT` · `900000100` |
   | Kind / Sector | National entity · Identity |
   | Contact email, website | The institutional ones |
   | Data protection officer | Name and email |
   | Data steward | Name and the person's **exact** email |
   | Technical lead | Name and the person's **exact** email |

3. **Save changes**, upload the **Designation document (PDF)**, up to 10 MB, and **Send for review**. Once submitted it cannot be edited, unless the operator asks for changes.

**About the document:** the portal does not read it; it stores the file and its SHA-256 in the audit log. A person of the operator reviews it: it must be the act or the letter that designates the officers, with the same names and emails as the form, signed by someone with the authority to do so.

## 3. The operator approves the onboarding

**Who:** a person with `platform_reviewer` or `platform_admin` who did not request it.

1. **Operator console → Entity onboarding to review →** the request.
2. Check the data, the document and that the emails are institutional.
3. **Operator decision:** **Approve the onboarding**, **Request corrections** (the requester reads the comment) or **Reject** (final; frees the identifier).

On approval, the requester becomes the **administrator** and each officer receives an **invitation** by email, which expires after 14 days.

## 4. The officers accept their invitation

**Who:** the data steward and the technical lead.

1. Each one registers with **exactly** the email in the request, verifies it and signs in.
2. **Invitations →** the entity's invitation, with its roles and expiry date **→ Accept**.
3. The **data steward** sets up the second factor (QR) the first time they work in the entity.

If **Invitations** is empty: the registered email is not identical to the request's, or it is not verified.

## 5. The entity's node

The node is the secure channel between the network's gateway and the entity: it opens a tunnel **outward**, with no inbound ports, and accepts only the gateway. Every provider comes in through its node, whether it has its own API (**canal** mode) or uses instant APIs over its database (**completo** mode).

### 5.1 Register the node (entity administrator)

**My entity → Kit nodes → Register a node:** a name unique in the entity (for example `main-node`) **→ Register and issue token**. **Copy the token right away:** it is shown once, works for one node and expires after 72 hours. Hand it to whoever installs.

### 5.2 Install the node (the entity's infrastructure)

Server: Ubuntu Server 22.04 or 24.04, amd64 or arm64, with outbound **UDP 51820** (the tunnel) and **TCP 443** (the portal), and the time synchronized.

The commands for the current version, with its checksum and the portal's address filled in, are in **My entity → Kit nodes → Kit to install** (and on the portal's public page `/kit`). If the server cannot reach GitHub, that same section offers the copy the portal serves, when the operator has uploaded it. For version 0.2.0:

```bash
curl -fLO https://github.com/centre-for-dpi/data-exchange-provider/releases/download/v0.2.0/den-node-kit-0.2.0.tar.gz
curl -fLO https://github.com/centre-for-dpi/data-exchange-provider/releases/download/v0.2.0/den-node-kit-0.2.0.tar.gz.sha256
sha256sum -c den-node-kit-0.2.0.tar.gz.sha256      # must say: OK
tar -xzf den-node-kit-0.2.0.tar.gz && cd den-node-kit-0.2.0
sudo ./install.sh                                  # sudo DEN_LANG=es ./install.sh for Spanish
```

**Compare the checksum** with the one the operator publishes through its own channel before opening the bundle: it is what shows the bundle was not tampered with.

| Installer question | Answer |
| :-- | :-- |
| Mode | `canal` if the entity has its own API; `completo` for instant APIs over its database |
| Corporate proxy | `n`, or the proxy's address |
| Portal URL | `https://portal.example.org` |
| Token | The one from 5.1 (not shown while pasted) |

The installer checks the system, installs Docker if missing and ends with **"The node is online"**. In the portal the node shows **Online** and its token **Used**.

### 5.3 Connect the API to the node

**Own API (canal mode):**

```bash
sudo /opt/den-node/install.sh service
```

| Question | Example |
| :-- | :-- |
| Type | `proxy` |
| Service name | `afiliacion` |
| Path on the node | `/afiliacion` (the portal asks for it in 6.2) |
| Internal URL of the API | `http://api-afiliacion:8000` (`https://` if the API has it; `http` only inside the entity's network) |
| Credential the internal API requires | `none`, `header`, `basic` or `certificate`; the node adds it and it never leaves the entity |
| The API's OpenAPI | The path of the **same file** that will be uploaded to the portal |

**Always give the OpenAPI**, although it is optional: with it the node logs which operation was called (without it every lookup is logged as `(unknown)`), and it sends the portal the checksum of the contract it serves.

**Instant API (completo mode):** the same command with type `instant` asks for the engine, the server, the database, the **read-only** user, the **view** to publish, the key column and, if the key identifies a person, their document type. The installer generates the OpenAPI in `/opt/den-node/config/services/<service>.openapi.json`: that is the file uploaded to the portal. Details in the kit's guide (`INSTANT-APIS.md`).

To finish: `sudo /opt/den-node/install.sh doctor`. Everything ✔; the only acceptable warning is plain `http` inside the entity's network.

## 6. The technical lead publishes the API

### 6.1 Register the API

**My APIs → Register API:**

| Field | Example |
| :-- | :-- |
| Identifier in the URL | `certificados-afiliacion` (builds the public route `/civil-registry/certificados-afiliacion/v1`) |
| Name, summary, description | What consumers see in the catalog |
| Sector, tags | To find it in the catalog |
| Classification | `Public`, `Internal`, `Personal data` or `Sensitive data` (sensitive data also needs the regulator) |
| Owner's email | The institutional one |

### 6.2 Create the version

**New version:**

| Field | Example |
| :-- | :-- |
| Version | `1.0` |
| OpenAPI file | The same one configured on the node |
| Service type | If the country only allows the node (the pilot, without an X-Road Security Server), the form does not ask: it says the service comes in through the entity's node. If it also allows X-Road, choose **Node of the entity (own API or instant API)** |
| Kit node / Service path on the node | The node from 5.1 · `/afiliacion` |
| Test service (sandbox) | None, or one with synthetic data |
| Allowed purposes | The country's catalog, for example *Eligibility check for a procedure* |
| Data it exposes | Every field of the response, marking the personal and the sensitive ones |
| Legal basis / Legal references | The rule that allows sharing the data |

**Create version:** the portal lints the contract on upload. Common errors: an identification number in the query (`?document=`) instead of the path, repeated `operationId`s, external references, and not declaring whose data it is in personal APIs (`x-den-data-subject`). The version sheet shows each operation and where its data subject is.

### 6.3 Send for review

**Send for review:** the portal runs the **automatic validations**, which call the service through the gateway, the tunnel and the node. If they fail, the sheet says which and why; fix it and click **Automatic validations → Run validations again**.

## 7. The operator approves the API

**Operator console → Versions in review →** the version: review the contract, the exposed data, the purposes and the validation result **→ Approve**. With failed validations the portal does not allow approving. Sensitive APIs also go to the regulator. On approval the route goes live on the gateway.

## 8. The consumer entity

### 8.1 Onboarding

Same as steps 2 to 4. If one person will hold every role, they put their own email as data steward and as technical lead: on approval they get all the roles in their account, with no invitations to accept.

### 8.2 Create the application

**My applications → Create application:** name, what the entity will use it for, environment, technical contact's email **→ Create application**. **"Save the secret now"** shows the **Client ID** and the **Client secret**: **the secret is shown once.** Keep it in the application server's secret store.

### 8.3 The application's certificate (mTLS)

The private key is generated **on the server where the application will run** and never leaves it; only the request (CSR) goes to the portal. The application's page, under **Client certificate (mTLS)**, has the commands ready with the Client ID, in tabs: **Linux or macOS**, **Windows: Git Bash** and **Windows: PowerShell** (which finds Git for Windows' OpenSSL by itself). Copy them and run them on the application's server. Another option is the `entity-check.sh` script, downloaded from that same page (or at `https://<portal>/files/entity-check.sh`):

```bash
bash entity-check.sh csr <CLIENT_ID>   # makes <CLIENT_ID>.key (readable only by its owner) and <CLIENT_ID>.csr
cat <CLIENT_ID>.csr
```

Commands and script do the same: the key is readable only by its owner, an existing key is never overwritten and, if OpenSSL fails, nothing half-made is left. Before pasting, the last line must show `subject=CN=<CLIENT_ID>` (OpenSSL 3.0 writes `CN = <CLIENT_ID>`): the `CN` must be **exactly** the Client ID. With a copy of `entity-check.sh` from before 18 November, `csr` rejected every CSR on Debian 12 and Ubuntu (OpenSSL 3.0): download the one on the page.

In the application, **Client certificate (mTLS)**: paste the whole CSR (from `-----BEGIN CERTIFICATE REQUEST-----` to `-----END CERTIFICATE REQUEST-----`) **→ Request certificate → Download**. It downloads as `<CLIENT_ID>.pem`: keep it with that name next to the key.

### 8.4 Request access

**Catalogue →** the API **→ Request access:**

| Field | What to enter |
| :-- | :-- |
| Application that will make the calls | The one from 8.2 |
| Purpose | One the API allows |
| What you will use the data for | The specific procedure or program: the provider reviews it |
| Legal basis | The rule or agreement that allows processing this data |
| Operations you need | None ticked = every read operation |
| Validity in months | Up to the classification's maximum (12 for personal data) |

**Send request.**

## 9. The provider decides

**Who:** the provider's data steward (with the second factor).

**Requests →** the request: who asks, with which application, for what, on which legal basis and which personal data they will receive **→ Approve** (operations, validity or limit can be reduced, never widened) or reject with a reason. On approval the agreement is in the audit log and the gateway enables the access within a minute.

## 10. The first lookup

From the application's server, in the folder with `<CLIENT_ID>.key` and `<CLIENT_ID>.pem`. On Windows, in **Git Bash** (not PowerShell):

```bash
./entity-check.sh check portal.example.org gateway.example.org        # reaches the network and saves its root
./entity-check.sh call portal.example.org gateway.example.org <CLIENT_ID> \
  /civil-registry/certificados-afiliacion/v1/certificados/1000000001 eligibility_check official-123
```

The script asks for the secret without showing it (or reads `CLIENT_SECRET`), requests the token with the certificate, makes the lookup with the purpose and the official, and explains the answer. The secret and the token never go on the command line. The `curl` of Git for Windows (and the `curl.exe` of Windows) uses Schannel, which cannot use a PEM certificate and key: there the script makes the request with OpenSSL, which Git for Windows also brings.

The same with `curl`, step by step (Linux or macOS; on Windows use the script):

```bash
curl -fsS https://portal.example.org/api/v1/pki/ca -o network-ca.pem   # the network's root
read -rs CLIENT_SECRET                                                 # paste it: it stays out of the history
TOKEN=$(curl -fsS --cacert network-ca.pem --cert <CLIENT_ID>.pem --key <CLIENT_ID>.key \
  -u "<CLIENT_ID>:$CLIENT_SECRET" -d grant_type=client_credentials \
  https://gateway.example.org/oauth/token | sed -E 's/.*"access_token":"([^"]+)".*/\1/')

curl -sS --cacert network-ca.pem --cert <CLIENT_ID>.pem --key <CLIENT_ID>.key \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-DEN-Purpose: eligibility_check" \
  -H "X-DEN-End-User: official-123" \
  https://gateway.example.org/civil-registry/certificados-afiliacion/v1/certificados/1000000001
```

- **Every lookup declares its purpose** (`X-DEN-Purpose`, one of the approved ones) and **who makes it** in the entity (`X-DEN-End-User`; the network keeps only a pseudonym).
- The token lasts a few minutes and is bound to the certificate: request another when it expires.
- Answers: **200** with the data; **403** with an `X-DEN-Deny-Reason` header when something is missing (`no_subscription`: no approved access; `end_user_required`: who consults is missing); **404** as `problem+json` when the record does not exist.

## When something fails

| Symptom | Cause | What to do |
| :-- | :-- | :-- |
| The verification link expired | It lasts 60 minutes (5 on installations not yet updated) | Sign in with that account: the verification screen offers to send it again. Or use "Forgot password?" |
| "Email already exists" when registering | The account was created; only the verification is missing | The same: sign in and resend the verification |
| Invitations is empty | The email is not identical to the request's, or not verified | Register the account with the exact email |
| "We could not complete the operation" uploading the onboarding document | (Operator, installations before P-06) the API cannot write to its documents folder | `sudo ./install.sh update` fixes it. By hand: in the portal's `.env`, `DEN_DOCUMENTS_DIR=/var/lib/den/documents`, and recreate the API container (`docker compose ... up -d --no-build --no-deps api`) |
| A platform role does not show | The person never signed in | Have them sign in once and run `platform-role grant` again |
| **Approve** is disabled, or "The version was not approved" | The automatic validations have not passed (still running, or failed) | The version sheet says what each failure means and what to try; fix it and **Run validations again** |
| Validation with **504** (timeout) | The gateway does not reach the node through the tunnel | On the node: `sudo /opt/den-node/install.sh status` (the tunnel must have a recent handshake). If the server's network changed address and the tunnel does not recover: `sudo /opt/den-node/install.sh stop` and `start` |
| `subject name is expected to be in the format /type0=value0…` | Git Bash turned `/CN=…` into a path (a command typed by hand) | Use the **Windows: Git Bash** tab on the application's page, or `bash entity-check.sh csr` |
| `schannel: Failed to import cert file` | Windows' `curl` (Schannel) cannot use the PEM certificate and key | Use `./entity-check.sh call` in Git Bash, which goes through OpenSSL there |
| `bash` is not recognized (PowerShell) | Windows has no bash of its own | Open **Git Bash** and run the commands there |
| The portal rejects the CSR | The `CN` is not the Client ID, or the key is not ECDSA P-256/P-384 or RSA 2048–4096 | Make another one with the exact Client ID |
| The node's logs say `(unknown)` | The service has no OpenAPI on the node | `install.sh service remove <service>` and add it again with the OpenAPI |

## What the product still lacks

Found in the rehearsal and recorded in the portal's backlog (section P):

- **P-01** ✔ Platform roles from the server's command line (a console screen is still missing).
- **P-02** ✔ A warning when the node serves a contract other than the published one.
- **P-03** ✔ The kit bundle, its checksum and the commands on the portal's nodes page.
- **P-04** ✔ Offering only the service types the country allows (the node and X-Road), with clear names.
- **P-05** ✔ The application page showing a CSR command that works on Linux, Git Bash and PowerShell (or pointing to `entity-check.sh`).
- **P-06** ✔ The deployment's `.env` sent documents to a folder the API cannot write.
- **P-07** ✔ Not letting a version be approved with failed validations, and explaining what to do with each failure.
- **P-08** ✔ Disabling the pilot's demo accounts and making the verification link last longer.
