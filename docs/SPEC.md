# Functional specification — DEN Portal

> Versión en español: [docs/es/SPEC.md](es/SPEC.md)

Version 0.1 · November 2026 · Status: draft for construction

## 1. Purpose and scope

The DEN Portal governs a data exchange network between public entities. It lets one entity publish an API, lets another consume it for an authorized purpose, and lets the operator and the regulator see and control the whole lifecycle. Traffic goes through a central gateway (APISIX); the data stays in each entity and the gateway stores no content.

**In scope for the MVP**

- Registration and governance of entities, users and roles.
- Registration, review, publication, versioning and retirement of APIs.
- Catalog with interactive documentation.
- Consumer applications with OAuth2 credentials and mTLS certificates.
- Access requests with purpose, legal basis and agreement; approval by the data owner.
- Automatic propagation to the gateway (routes, policies, limits) and near-immediate revocation.
- Chained audit log, usage analytics per entity and network indicators.
- Registry of nodes of the onboarding kit (contract with the kit; the kit itself is a separate project).
- Per-country configuration.

**Out of scope for the MVP**

- The citizen's record (it will be built on top of the APIs already in use).
- Online citizen consent (the extension point is designed, see §9).
- Verifiable credentials.
- Billing or charging between entities.
- The instant API kit and its installer (sibling project; only its contract with the portal is defined here).

## 2. Actors and roles

### 2.1 Platform roles (not tied to an entity)

| Role | Who (typically) | Can |
| :-- | :-- | :-- |
| `platform_admin` | Operator's technical team (the national digital agency or equivalent) | Everything operational: approve entities, review and publish APIs, manage nodes, suspend anything, see all analytics |
| `platform_reviewer` | Operator's analysts | Review publications and entity registrations; does not manage infrastructure |
| `regulator` | The authority that governs the network (for example, the ministry in charge of digital government) | See everything read-only; approve publications and subscriptions when policy requires it (sensitive data); see indicators; export the audit log |
| `auditor` | Oversight bodies, external auditor | Read-only access to audit and analytics; no access to configuration |

### 2.2 Roles within an entity

| Role | Can |
| :-- | :-- |
| `entity_admin` | Manage the members and roles of their entity, the entity's data, accept framework agreements |
| `api_publisher` | Register APIs and versions for their entity, submit them for review |
| `data_steward` | Approve, reject, suspend and revoke subscriptions to their entity's APIs; define allowed purposes |
| `app_developer` | Create applications for their entity, manage credentials, request access to APIs |
| `entity_viewer` | See everything in their entity read-only |

A user can belong to several entities with different roles. A user cannot approve a subscription they requested themselves (separation of duties).

### 2.3 Anonymous user

Can see the public catalog page **only** if `features.publicCatalog: true` in the country configuration, and only APIs classified as `public`. They do not see the API owner's contact (it may be a person's email address) or the status of the entity's nodes (M6-08).

### 2.4 Data subject (citizen)

Does not use the portal. Sees **who queried their data**, when, which data, for what purpose and through which official (as a reference), from the country's citizen app (in Colombia, the Carpeta Ciudadana Digital), authenticated with the national digital identity. They can also turn on alerts and download a verifiable receipt for each query. In this version they only see the queries that go through the gateway (ADR-0015).

## 3. Domain model

The names are the ones used in the code. Every record has `id` (UUIDv7), `createdAt`, `updatedAt`, `createdBy`.

### Entity
`legalName`, `shortName`, `slug`, `taxId` (e.g. NIT), `kind` (`national` | `territorial` | `autonomous` | `private_authorized`), `sector` (from the country config), `parentEntityId?`, `status` (§4.1), `contactEmail`, `website?`, `dataProtectionOfficer` (name, email).

### User
`keycloakSub`, `email`, `fullName`, `idDocumentType?`, `idDocumentNumberHash?` (hash only, never the number in clear text), `status` (`active` | `disabled`).

### Membership
`userId`, `entityId`, `roles[]`, `status` (`invited` | `active` | `revoked`), `invitedBy`.

### Api
`entityId` (provider), `slug` (unique per entity), `name`, `summary`, `description` (markdown), `sector`, `tags[]`, `classification` (`public` | `internal` | `personal` | `sensitive`), `status` (derived from its versions: `draft` | `published` | `deprecated` | `retired`), `ownerContact`.

### ApiVersion
`apiId`, `version` (semver major.minor), `status` (§4.2), `openapiSpec` (stored JSON + hash), `lintReport`, `upstream` (§3.1), `basePath` (computed: `/{entitySlug}/{apiSlug}/v{major}`), `exposedFields[]` (data attributes flagged `personal: bool`, `sensitive: bool`), `legalBasis` (text + legal references), `allowedPurposes[]` (codes from the purpose catalog), `sla` (`availabilityTarget`, `maxLatencyMs`, `supportHours`), `defaultRateLimit` (requests/minute), `deprecatedAt?`, `sunsetAt?`, `serviceSheet` (the "service sheet": owner, description, schema, service level — generated from these fields).

### 3.1 Upstream (where the service lives)
One of:

- `node`: a service exposed by a kit node (`nodeId`, `servicePath`). This is the path for instant APIs. The node must belong to the publishing entity; the gateway calls it through its tunnel and stops doing so if the node is decommissioned. The API detail page shows the node's status to the provider, the reviewer and the consumer.
- `xroad`: a service consumed through X-Road (`serviceId` with instance/class/member/subsystem/service, and an optional path). The gateway acts as a client member, through the operator's Security Server, which pins the deployment's configuration and not the version (SPIKE S-5). The service's member must be the entity's X-Road member, which the operator registers.
- `direct`: public HTTPS API of the entity, called by the gateway without a node (`url`, `mtls: bool`).

The node is the default channel (ADR-0029): the country lists the types new versions may use in `features.upstreams`, `[node, xroad]` if omitted. `direct` is opt-in, and `xroad` is offered only where the deployment has the operator's Security Server. The API refuses another type, as upstream or sandbox, when a version is created, revised, edited or submitted (400, `upstream_type_not_allowed` or `xroad_not_configured`). The version form offers only the allowed types, and with a single one it does not ask. A version that already has a type the country no longer accepts keeps working; its sheet and the operator's sync console flag it, and the operator decides.

### Application (consumer application)
`entityId` (consumer), `name`, `description`, `environment` (`sandbox` | `production`), `keycloakClientId` (deterministic), `status` (`active` | `suspended` | `deleted`), `technicalContact`.

### Credential
`applicationId`, `kind` (`client_secret` | `mtls_certificate`), `status` (`active` | `rotating` | `revoked` | `expired`), `fingerprint` / `serial`, `notAfter`, `lastUsedAt?`. The secret is shown only once, when it is created; it is never stored in clear text in the portal.

### Purpose (purpose catalog)
`code`, `name`, `description`, `legalReference?`. A per-country catalog in the config, which the operator can extend. Examples: `eligibility_check` (verify the requirements of a procedure), `benefit_targeting` (program targeting), `identity_validation`, `statistics_anonymized`, `oversight` (oversight and audit).

### Subscription (request and access)
`applicationId`, `apiVersionId`, `purposeCode`, `purposeDetail` (text), `legalBasis` (text + reference), `agreementDocumentId?`, `requestedOperations[]` (subset of the OpenAPI `operationId`s; empty = all read-only ones), `requestedRateLimit?`, `validFrom`, `validUntil` (maximum per config, 12 months by default), `status` (§4.4), `decisions[]` (who decided, when, comment), `endUserIdentificationRequired: bool`.

### Node (kit node)
`entityId`, `name`, `status` (§4.6), `tunnelAddress`, `wireguardPublicKey`, `certificateSerial`, `kitVersion`, `lastHeartbeatAt`, `services[]` (what the node declares it exposes).

### Document
Attached files (agreements, minutes). `ownerEntityId`, `kind` (`agreement` | `annex` | `other`), `sha256`, `size`, `mimeType`, `storageKey`. PDF only in the MVP.

### AuditEvent
`seq` (sequential), `occurredAt`, `actor` (user, system or application), `actorEntityId?`, `action` (e.g. `subscription.approved`), `targetType`, `targetId`, `before?`, `after?` (domain fields only, never secrets), `ip?`, `prevHash`, `hash`. Immutable.

### Notification
`userId`, `kind`, `payload`, `readAt?`, `emailSentAt?`.

## 4. Flows and states

### 4.1 Entity registration

```
requested → under_review → active
                ↘ rejected
active ⇄ suspended
active → offboarded
```

1. An official starts the registration request (or the operator creates it directly): entity data, data steward, technical lead, designation document (PDF).
2. `platform_reviewer` reviews it; they can ask for corrections (it goes back to `requested` with a comment) or approve it.
3. On approval: the entity becomes `active`, the requester becomes `entity_admin` and invitations are sent to the designated officers.
- **Detail (M2-01).** Anyone with an account (self-registration with a verified email, ADR-0018) can request a registration. They can have up to 3 open requests at a time. In `requested` it is the requester's turn: they correct the data, attach the designation document and submit it (it moves to `under_review`). Asking for corrections or rejecting requires a comment that the requester reads. The identifier and the tax ID are reserved only from the moment the request is submitted. A draft reserves nothing, and between drafts the first one submitted wins. Rejection is final, but it frees both values for a new request. This way a fake request cannot block the real entity forever.
- **Separation of duties:** nobody decides on a request they submitted or in which they appear as a designated officer.
- **Direct registration.** `platform_admin` registers the entity without a request when an act or a decision has already brought it into the network. They state that basis, which is recorded in the audit log, and the entity's administrator. The entity is active immediately; the administrator and the officers receive an invitation by email. The operator cannot be the administrator or one of the officers.
- **Designated officers.** The data steward receives `data_steward`. The technical lead receives `api_publisher` and `app_developer`. If the requester designates themselves, the roles are added to their membership without an invitation. Each invitation expires after `DEN_INVITATION_TTL_DAYS` days (14 by default).
4. `suspended` blocks any new publication and suspends in the gateway all of the entity's subscriptions as a consumer (not as a provider, unless explicitly decided). The `platform_admin` decides it, with a reason; reactivating returns each subscription to its previous state. `offboarded` is final: it closes the entity's subscriptions on both sides, retires its versions and revokes its memberships (M2-11).

### 4.2 Publishing an API version

```
draft → in_review → approved_operator → [approved_regulator] → published
          ↘ changes_requested → draft
published → deprecated → retired
```

1. `api_publisher` creates the API and the version: uploads OpenAPI 3.x, chooses the upstream among the types the country accepts (§3.1), fills in the exposed fields, legal basis, allowed purposes and SLA.
2. Automatic validations when submitting for review (blocking):
   - OpenAPI lint with the DEN ruleset (Spectral): `operationId` on every operation, response schemas, no identification parameters in the query if `features.lint.noIdInQuery` (they are recommended in the path or in a POST body), descriptions in Spanish.
   - Connectivity: the portal asks the node/URL for a `healthcheck` through the gateway in test mode (GET to the service root; it passes with any response that is not a 5xx).
   - Contract test (Schemathesis) against the sandbox, with a time limit. The sandbox is the test service with synthetic data that the version declares; without a sandbox, the test is skipped and does not block.

   Both run in the background when the version is submitted for review, and their results go with the review. The operator only approves if they passed; the provider can rerun them after fixing their service. From the contract test, only the codes of the failed checks and the HTTP status are stored, per operation, never a body.
3. `platform_reviewer` reviews the service sheet, the classification and minimization. If `classification ∈ {sensitive}` and `features.approval.regulatorForSensitive`, it also goes through `regulator`. The regulator approves it (it is published) or sends it back to the provider with a reason (`changes_requested`). Nobody who has already taken part in the version, or who belongs to the provider entity, can decide.
4. On publication: the route is created in the gateway in "closed" mode (without subscriptions nobody gets in) and the API appears in the catalog.
5. A new major version coexists with the previous one. `deprecated` shows a notice and the retirement date; `retired` removes the route and revokes the subscriptions (with configurable advance notice, 90 days by default).

Changes to a published version: only compatible changes are allowed (descriptions, SLA, new optional operations). An incompatible change requires a new major version. The lint compares against the published version and blocks incompatibilities.

### 4.3 Applications and credentials

1. `app_developer` creates an application in their entity (sandbox or production).
2. The portal creates a confidential client in Keycloak (`client_credentials`) and shows the secret only once.
3. If `features.mtls.required`, the developer generates a CSR (the portal offers instructions and a command) and uploads it; the portal signs it through step-ca with the `client_id` in the CN/SAN. Certificates last 90 days by default, with a notice 15 days before expiry.
4. Rotation: a second credential can be created before revoking the first (rotation window). When the secret is rotated or a new certificate is requested, the previous one becomes `rotating` and keeps working for `lifecycle.credentialRotationDays` (7 by default); after that it becomes `expired`. Revoking cuts the credential off immediately. The current secret is not revoked: it is rotated first. One rotation at a time per credential type.
5. An application without approved subscriptions can obtain a token, but the gateway rejects all its calls.

### 4.4 Subscription (access request)

```
pending_provider → [pending_regulator] → approved → active
        ↘ rejected                ↘ rejected
active ⇄ suspended
active → revoked
active → expired (when validUntil passes)
pending_* → withdrawn (the requester withdraws)
pending_provider → info_requested → pending_provider (question from the steward and answer)
```

1. The consumer entity's `app_developer` chooses the API and version, the application, the purpose (from the catalog allowed by that API), the purpose detail, the legal basis, the required operations and the validity period, and attaches the data exchange agreement or a reference to an agreement in force.
2. The provider entity's `data_steward`s are notified. The steward can approve (optionally reducing operations, limit or validity), reject with a reason, or ask for information (a comment; it goes back to the requester).
3. If the API is `sensitive` and policy requires it, it also goes through `regulator`.
4. `approved → active` happens when the reconcilers confirm that the gateway already has the policy data. The portal shows "activating" in the meantime. Target: under 60 seconds.
5. Suspending or revoking (by the provider, the operator or the regulator) is reflected in the gateway in under 60 seconds.
6. Renewal: 30 days before `validUntil` the consumer is notified; renewal is a new, prefilled request.

**Rules**
- An application has at most one active subscription per API version and purpose.
- Sandbox (M4-08): subscriptions of sandbox applications are approved automatically if `features.sandbox.autoApprove`, and they only point to the test upstream. A sandbox application can only request access to versions that declare a sandbox, and it calls `/sandbox{basePath}`. The gateway never lets it reach the real service, nor lets a production application reach the sandbox (`environment_mismatch`). The automatic approval is decided by the system and recorded in the audit log.
- Separation of duties: the requester cannot approve, even if they hold both roles in different entities. This does not apply to revoking or suspending: those actions only remove access, and a data steward must be able to cut off access for one of their own applications that has been compromised.

### 4.5 Calling an API (what the portal makes possible)

The consumer system obtains a token from Keycloak with its credentials and calls the gateway with:
- `Authorization: Bearer <token>`
- `X-DEN-Purpose: <purpose code>` (required)
- `X-DEN-End-User: <official's identifier>`: required for APIs with personal or sensitive data. It is an identifier of 1 to 128 visible characters, with no spaces, such as the username or the institutional email. It is only recorded as a hash with the deployment's salt.
- `X-Request-Id` (optional; if it is missing, the gateway generates it)

The gateway allows the call only if there is an `active` subscription for that client, that version, that operation and that purpose. The provider receives traceability headers (see `ARCHITECTURE.md §6`).

### 4.6 Kit nodes

```
enrollment_issued → enrolled → online ⇄ offline
                                 ↘ decommissioned
```

1. `platform_admin` or `entity_admin` registers the node (name unique within the entity) and receives a single-use enrollment token (valid for 72 h), which is shown only once. It is used at the bootcamp. While the node has not enrolled, the token can be voided or a new one issued, which voids the current one: a node has at most one usable token. The portal stores only the token's hash.
2. When the kit is installed, it calls `POST /api/v1/nodes/enroll` with the token, its CSR and its WireGuard public key. It receives a certificate, the tunnel configuration and the node ID. The token stops working.
3. The node sends a heartbeat every 60 s with its version and exposed services. No heartbeat for 5 min → `offline` and an alert to the entity's administrators and to the operator. The next heartbeat brings it back to `online`.
4. The node renews its certificate before it expires. `entity_admin` or `platform_admin` can decommission a node (`decommissioned`): it stops working for good.
5. APIs with a `node` upstream show the node's status.

**Bootcamp preparation (M4-07).** Before the bootcamp, each entity confirms five requirements: a server for the node, a read-only database user, outbound internet access on 443, the designated officers (computed: members with `api_publisher` and `data_steward`) and the use case. The `entity_admin` (or the operator) checks them off, and the operator sees the progress of every entity.

### 4.7 Transparency for the data subject (ADR-0015, ADR-0016)

1. When a version of a `personal` or `sensitive` API is published, each operation declares where the data subject is (`x-den-data-subject`) or that it has no data subject (`none`).
2. On each authorized call, the gateway computes a pseudonym for the data subject and records the query: the entity and application that queried, the provider entity, the API and the exposed data, the operation, the purpose, the official (hash), the date and the result. It never records the content or the document number.
3. Queries are grouped into sealed batches (operator signature and a timestamp from an independent TSA). Each query has a receipt that anyone can verify.
4. Citizens see their queries in the country's citizen app. The portal only answers that app with the citizen's token, and alerts the citizen about new queries if the citizen asked for it.

## 5. Cross-cutting business rules

- **Minimization:** the reviewer sees the `exposedFields` and must confirm that they match the allowed purposes. The catalog shows which personal data each API exposes.
- **Classification:** `public` (open data), `internal` (non-personal, internal use), `personal` (personal data), `sensitive` (special categories: health, etc.). The classification determines additional approvals, maximum validity and whether `X-DEN-End-User` is required.
- **Maximum subscription validity** per classification, configurable (by default: public 24 months, internal 24 months, personal 12 months, sensitive 6 months).
- **Nothing is deleted** in the domain: entities, APIs and subscriptions change state. The only physical deletion is of attached documents by legal order, and it is recorded in the audit log.

## 6. Screens

**Portal (all entities)**
- Home: catalog search, quick links by role, pending items (inbox).
- Catalog: filters by sector, entity, classification, status; cards showing the personal data exposed.
- API detail: description, service sheet, interactive documentation (Scalar) with "try in sandbox", versions, allowed purposes, node status, "Request access" button.
- My entity: data, members and invitations, nodes, agreements.
- My APIs (provider): list, create/edit a version, submit for review, requests received, active consumers, usage.
- My applications (consumer): credentials, certificates, subscriptions and their status, usage, integration guide (programs in curl, Python, Node.js, Java and C#).
- Request inbox (data steward): pending, history, approve/reject/suspend/revoke actions.

**Operator console**
- Entity registrations, API reviews, nodes (status, version, last heartbeat), gateway sync status (last reconcile, differences), all subscriptions, purposes, configuration.

**Regulator view**
- Network indicators (§8), pending approvals that fall to the regulator, exchange map (which entity consumes from which), audit and export.

**Audit** (regulator, auditor, operator; each entity sees its own)
- Filterable timeline, chain integrity verification, signed CSV/JSON export.

## 7. Notifications

In the portal and by email. Minimum events: invitation to an entity, registration approved/rejected, API submitted for review / changes requested / published, new access request, request approved/rejected/with questions, subscription suspended/revoked/about to expire, certificate about to expire, certificate revoked by the operator (mass revocation, M6-07), node offline, API version being deprecated. Each user chooses what they receive by email (security notices cannot be turned off).

## 8. Indicators (taken from the network proposal)

| Indicator | Calculation |
| :-- | :-- |
| Time to first API in use | Days between the entity's registration (or the node's enrollment) and the first successful call from a production consumer |
| Entities connected per month | Entities with at least one published API, by month of publication |
| APIs with real usage | Published APIs with ≥ 1 successful production call in the month |
| Successful queries | % of 2xx responses over the total (excludes authorization 401/403s, which are reported separately) |
| Gateway availability | % of time with health OK (Prometheus) |
| Approval time | Median hours between request and the provider's decision |
| Manual steps avoided | Manual field per use case: captured with the use case from the entity's bootcamp (M4-07) |

## 9. Planned extension points

- **Consent:** the subscription model supports `consentRequired: bool`. When it is enabled, OPA will query a consent service before allowing. It is not implemented in the MVP; the policy interface already receives the `X-DEN-Consent-Ref` header if present.
- **Territorial instances** (e.g. a capital city): a gateway instance with its own subset of routes, governed from the same portal (`Gateway` as a first-class entity in a future version).
- **Verifiable credentials:** a provider entity will be able to mark an API as an "issuance source" for a credential issuer; out of the MVP.

## 10. Per-country configuration (abridged example: `co.yaml`)

```yaml
country:
  code: CO
  name: Colombia
  locale: es-CO
  timezone: America/Bogota
authorities:
  operator: { name: "Agencia Nacional Digital", shortName: "AND" }
  regulator: { name: "Ministerio de Tecnologías de la Información y las Comunicaciones", shortName: "MinTIC" }
legal:
  dataProtectionLaw: "Ley 1581 de 2012"
  dataProtectionAuthority: "Superintendencia de Industria y Comercio"
identifiers:
  person: [CC, CE, TI, PEP, PPT, PA]
  organization: [NIT]
sectors: [identidad, vulnerabilidad, vivienda, salud, trabajo, educacion, movilidad]
purposes:
  - { code: eligibility_check, name: "Verificación de requisitos de un trámite" }
  - { code: benefit_targeting, name: "Focalización de programas sociales" }
  - { code: identity_validation, name: "Validación de identidad" }
features:
  publicCatalog: false
  mtls: { required: true }
  sandbox: { autoApprove: true }
  approval: { regulatorForSensitive: true }
  lint: { noIdInQuery: true }
  upstreams: [node, xroad]   # ADR-0029: direct is opt-in
subscriptionMaxValidityMonths: { public: 24, internal: 24, personal: 12, sensitive: 6 }
branding: { productName: "Red de Intercambio de Datos", logo: "./branding/co/logo.svg", primaryColor: "#6564DB" }
```

## 11. Non-functional requirements

- **Availability:** the portal can go down without affecting traffic; the gateway keeps operating with the last configuration and the last OPA bundle.
- **Latency added by the gateway:** p95 < 50 ms (not counting the upstream) with a local OPA.
- **Propagation:** approval or revocation reflected in the gateway in < 60 s.
- **Initial scale:** 200 entities, 1,000 APIs, 5,000 subscriptions, 500 sustained requests/s at the gateway.
- **Security:** OWASP ASVS L2; mandatory MFA for platform roles and `data_steward` (Keycloak asks for the code; the API requires it on every request, ADR-0021).
- **Privacy:** no bodies in logs; identifiers in paths masked; `X-DEN-End-User` stored as a hash with a per-deployment salt.
- **Retention:** audit log 5 years (configurable); access logs 1 year (configurable).
- **Accessibility:** WCAG 2.1 AA.
- **Languages:** Spanish (default) and English.
- **Deployment:** Docker Compose for development and pilots; Helm/Kubernetes for production (milestone M6).
