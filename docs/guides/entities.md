# Guide for participating entities

> Versión en español: [docs/es/guides/entities.md](../es/guides/entities.md)

Version 1.2 · November 2026 · for the onboarding day (bootcamp) with the entities

This guide explains what each entity has to **appoint, provide and do** to connect to the Data Exchange Network (RID), as a data **provider**, as a **consumer**, or as both. The national operator runs the central platform (portal and gateway): the entity installs none of it.

**Providers have their own guide,** in the kit repository (`docs/guides/providers.md`, with its presentation version `providers.html`): how the service connects through the node, which server and network it needs, how to install the node, how to publish an API, and what the service receives with each request. This guide covers what is common to all entities, plus what applies to consumers.

## 1. What it means for an entity

- **As a provider**, the entity publishes an API over its data. Through its **data steward**, it decides who gets access, for what purpose, to which operations and for how long. For every request, it knows who made it and why. The data is never copied to the platform.
- **As a consumer**, the entity finds APIs in the catalog, creates an application with its credentials and requests access by declaring a **purpose**. Once the provider approves, its systems send requests through the gateway.
- **Citizens** see which entity queried their data and why. Every request must serve a legitimate, declared purpose.

## 2. People the entity must appoint

| Role in the portal | Usually | What they do | Second factor |
| :-- | :-- | :-- | :-- |
| `entity_admin` | Head of IT or of the data office | Requests the entity's registration, invites its people and assigns roles, manages the kit's nodes | — |
| `data_steward` | The person accountable for the data (formal appointment) | Approves, rejects, suspends and revokes access to the entity's APIs | **Required** |
| `api_publisher` | Technical lead | Registers the APIs and submits them for review | — |
| `app_developer` | Developer of the consumer system | Creates applications, manages credentials and requests access | — |

Each person needs their **own institutional email address**: the account is verified by email, and invitations are sent to that address. The second factor is set up with an authenticator app (FreeOTP, Aegis, Google Authenticator or any other TOTP app) on the person's phone.

**Document:** the act appointing the data steward and the technical lead, as a PDF. It is attached to the registration request.

## 3. What the entity must provide

### 3.1 As a consumer

| What | Details |
| :-- | :-- |
| A consumer system | The server or application that will send the requests. It must be able to make HTTPS calls with a **client certificate** (mTLS): any modern language can (curl, Java, .NET, Python, Node) |
| Outbound internet access | `443/tcp` to the **gateway name** and the **portal name** |
| A safe place for secrets | The certificate's private key and the application secret: never in code or in a repository |
| `openssl` | To generate the private key and the certificate signing request (CSR). The private key **never leaves** the entity's server |
| Official's identifier | APIs with personal data require `X-RID-End-User`: the username or institutional email of the person making the request. It is only recorded as a hash |

### 3.2 As a provider

Every provider connects through the **node**, which is installed inside its network and opens an encrypted tunnel **outbound** (outbound `UDP 51820` and `443/tcp`; no inbound ports). Behind the node sits either the entity's own API (`canal` mode) or instant APIs over views in its database (`completo` mode: SQL Server, PostgreSQL, MySQL or Oracle). Entities that already publish on X-Road come in through the operator's Security Server.

The server and network requirements, the installation and the publication steps are in the **provider guide** in the kit repository.

#### Verifying the gateway assertion

If the country has it enabled (`features.gatewayAssertion`), every request arrives with the `X-RID-Assertion` header (ADR-0024). It is an ES256 JWS signed by the gateway with what it authorized:
- who is making the request: entity, application and subscription;
- what for: the purpose;
- which operation;
- the official and the data subject, as pseudonyms;
- which request it belongs to: the method and the SHA-256 of the path with its query string; when there is a body, also the SHA-256 of the body.

The entity can keep it as proof that the network authorized that request. To accept it, the service checks:
1. that the signature verifies against a key in the network's JWKS (`https://<portal>/api/v1/gateway/jwks`, by `kid`; if an unknown `kid` arrives, download it again);
2. that `aud` is the entity's identifier (its slug in the portal), that `iss` is the gateway's public URL, and that `exp` has not passed;
3. that `req.method` and `req.uri_sha256` match the request received (the method, and the path with its query string exactly as they arrived);
4. that `req.body_sha256` is the SHA-256 of the bytes received, whatever their content type (the hash of nothing, if no body arrived). This applies to POST, PUT and PATCH, to any request that carried a body (a GET or a DELETE too), and whenever the assertion includes it. The service has to hash the body exactly as it arrived, before parsing it;
5. that its `jti` has not been seen before while the assertion is valid, so that a captured assertion cannot be replayed. Remembering each `jti` until its `exp` is enough.

The token carries no identification numbers: the number goes in the path, and the assertion only carries its hash. It can be archived without any personal data in clear text. `jti` is the request's identifier in the gateway (`X-Request-Id`), the same one used in the data subject's transparency log.

Node.js, with no libraries:

```js
import { createHash, createPublicKey, verify } from 'node:crypto';
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const jwks = await (await fetch('https://<portal>/api/v1/gateway/jwks')).json();

const seen = new Map(); // jti -> exp; periodically delete the expired ones

// body: the raw bytes received (Buffer), or undefined if there was no body.
function checkAssertion(token, { method, url, body, audience, issuer }) {
  const [h, c, s] = token.split('.');
  const { kid, alg } = JSON.parse(Buffer.from(h, 'base64url'));
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk || alg !== 'ES256') return false;
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  if (!verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) return false;
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  if (claims.aud !== audience || claims.iss !== issuer || claims.exp * 1000 <= Date.now()) return false;
  if (claims.req.method !== method || claims.req.uri_sha256 !== sha256(url)) return false;
  if (['POST', 'PUT', 'PATCH'].includes(method) || claims.req.body_sha256 !== undefined || body?.length) {
    if (claims.req.body_sha256 !== sha256(body ?? '')) return false;
  }
  if (seen.has(claims.jti)) return false; // replayed
  seen.set(claims.jti, claims.exp);
  return true;
}
```

Python, with PyJWT (MIT) and `cryptography`:

```python
import hashlib, jwt
jwks = jwt.PyJWKClient("https://<portal>/api/v1/gateway/jwks")

seen = {}  # jti -> exp; periodically delete the expired ones

def check_assertion(token, method, url, body, audience, issuer):
    """body: the raw bytes received (b"" if there was no body)."""
    key = jwks.get_signing_key_from_jwt(token).key
    # signature, aud, iss and exp
    claims = jwt.decode(token, key, algorithms=["ES256"], audience=audience, issuer=issuer)
    req = claims["req"]
    if req["method"] != method or req["uri_sha256"] != hashlib.sha256(url.encode()).hexdigest():
        return False
    if method in ("POST", "PUT", "PATCH") or "body_sha256" in req or body:
        if req.get("body_sha256") != hashlib.sha256(body).hexdigest():
            return False
    if claims["jti"] in seen:  # replayed
        return False
    seen[claims["jti"]] = claims["exp"]
    return True
```

In Java you can use Nimbus JOSE + JWT (Apache-2.0), and in .NET `System.IdentityModel.Tokens.Jwt` (MIT), with the same list of checks. The portal's test provider (`infra/mock-providers/src/assertion.ts`) is a complete reference.

### 3.3 Readiness checklist

The portal keeps this checklist for each entity (My entity → Bootcamp readiness), and the operator sees the progress of all of them:

- [ ] **Server** available (the consumer system, or the node's server).
- [ ] **Read-only user** in the database (only providers using the node's `completo` mode).
- [ ] **Outbound 443** to the gateway (and UDP 51820 for a provider's node).
- [ ] **Appointed leads:** the portal ticks this on its own once there is an active `api_publisher` and an active `data_steward`.
- [ ] **Use case** defined: which data, for what purpose, on what legal basis and between which entities.

## 4. Step by step on the day

Before starting, the operator gives the entities the platform's two names: the **portal**'s (`https://<portal>`) and the **gateway**'s (`<gateway>`).

### 4.1 Check the network from the entity's server

From the server that will send the requests (or the node's server), using the repository's `scripts/entity-check.sh` script, which the operator hands out on the day:

```bash
chmod +x entity-check.sh
./entity-check.sh check <portal> <gateway>
```

It checks DNS, outbound HTTPS to the portal and to the gateway, and that the gateway's certificate verifies against the network's root. It saves the root to `./rid-network-ca.pem`. It only needs `bash`, `curl` and `openssl`.

### 4.2 Registering the entity and its people

1. The future `entity_admin` goes to `https://<portal>`, creates an account and confirms the email address.
2. They request the entity's registration: its details, the appointed leads and the appointment document. The operator reviews and approves it. If the entity has already been onboarded by a formal act, the operator registers it directly.
3. The `entity_admin` invites each person by email and assigns roles. Each invitee creates an account with **that same email address** and accepts the invitation.
4. The `data_steward` sets up the second factor the first time the portal asks for it.

### 4.3 Provider entity: install the node and publish an API

This is covered in the **provider guide** in the kit repository: the enrollment token, installing the node, publishing the API with its sandbox, the review, and what the service receives with each request.

### 4.4 Consumer entity: first request

1. **Try the sandbox first.** The `app_developer` creates an application of type **sandbox**. Its requests for access to APIs that have a sandbox are approved instantly, and it calls `/sandbox/...`, with synthetic data.
2. **Save the secret** shown when the application is created: it is shown only once.
3. **Application certificate** (mTLS), on the entity's server:
   ```bash
   ./entity-check.sh csr <client_id>      # creates <client_id>.key (600) and <client_id>.csr
   ```
   Paste the CSR into the application's page → Client certificate (mTLS), download the certificate and save it as `<client_id>.crt` next to the private key.
4. **Request access:** in the catalog, open the API → Request access. Choose the application, the purpose, the details, the legal basis, the operations, the validity period and the data exchange agreement. In production, the provider's `data_steward` approves it (and the regulator too, if the data is sensitive).
5. **Call:**
   ```bash
   CLIENT_SECRET=... ./entity-check.sh call <portal> <gateway> <client_id> \
     /sandbox/<entity>/<api>/v1/<resource> <purpose> <official>
   ```
   The script requests the token from the gateway (`/oauth/token`, bound to the certificate), sends the request with `X-RID-Purpose` and `X-RID-End-User`, and explains the response. The exact URLs are on the API's page and on the subscription's page.
6. With the **production** application, repeat steps 2 to 5 with the real path (without `/sandbox`), once the request is approved.

## 5. Why the gateway rejects a call

The gateway responds with `403`, `application/problem+json` and a stable `code`:

| `code` | What it means | What to do |
| :-- | :-- | :-- |
| `no_subscription` | The application has no active access to that version | Request access, or wait for approval ("Approved (activating)" takes a few seconds) |
| `purpose_not_allowed` | `X-RID-Purpose` is missing or is not the approved purpose | Send the subscription's purpose code |
| `operation_not_allowed` | The subscription does not cover that operation | Request access to that operation |
| `end_user_required` / `end_user_invalid` | `X-RID-End-User` is missing or invalid (1 to 128 visible characters, no spaces) | Send the official's institutional username |
| `client_certificate_required` / `certificate_mismatch` / `certificate_revoked` | No certificate, another application's certificate, or a revoked one | Use the current certificate of **that** application |
| `token_not_bound` | The token is not bound to the certificate | Request the token from `https://<gateway>/oauth/token` with the certificate |
| `environment_mismatch` | A sandbox application on a real path, or the other way round | Use the path that matches the application type |
| `subscription_expired` / `app_suspended` | The validity period ended or the application is suspended | Renew the request or talk to the operator |

Other codes: `401` (token expired or invalid; it lasts 5 minutes), `404` (no API published at that path), `429` (the subscription's limit was reached).

## 6. The entity's commitments

- **A real purpose.** Only send requests for the declared and approved purpose. Every request is recorded in the log, and the citizen sees it.
- **An identified official.** Send in `X-RID-End-User` the person who is actually making the request.
- **Protected credentials.** The private key and the secret are not shared or pushed to repositories. If you suspect a leak, **revoke** them from the application's page. Before a certificate expires (90 days, with a warning at 15), issue a new one: the previous one keeps working during the rotation window.
- **Don't keep more than needed.** Keep only what the purpose requires.
- **Announce changes.** An incompatible change to a published API requires a new major version. The previous one is deprecated with a retirement date.

## 7. Contacts and support

- **Operator (AND):** entity registrations, API reviews, connection problems with the gateway.
- **Regulator (MinTIC):** approvals for sensitive data, regulatory framework.
- **Within the entity:** the `entity_admin` manages its people and its nodes; the `data_steward` decides on access.
