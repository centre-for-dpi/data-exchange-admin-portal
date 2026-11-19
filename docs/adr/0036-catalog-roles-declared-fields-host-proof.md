# ADR-0036 — Catalogue by role, classification that covers the declared fields, proof of host control for the contract test

- Status: Accepted (extends ADR-0014, ADR-0015 and ADR-0019; does not replace them)
- Date: 2026-11-19
- Story: R-07 (`docs/BACKLOG.md`), findings M-17, M-18, M-19, M-20, MB-1, MB-2 and B-10 of the 2026-11 general review

## Context

Several domain endpoints trusted something a stranger can choose:

- The portal realm allows self-registration, yet the "authenticated" catalogue (`internal`, `personal` and `sensitive` APIs with their fields, contact and full OpenAPI) was open to any signed-in person (M-17). ADR-0014 says global resources are protected with roles.
- The privacy controls (data subject, `X-DEN-End-User`, maximum validity) follow the API's classification, but a provider could register an `internal` API whose fields are marked `personal` (M-20).
- The contract test fires up to 20 examples per operation, from the operator's network, at a public host the provider names, before any human has reviewed it (MB-2).
- The compatibility check of ADR-0019 only looked at the top level of schemas (M-18), and a version sent back for changes could only change its OpenAPI (M-19).

## Decision

1. **Catalogue.** Beyond public APIs the catalogue needs an active membership in an entity or a platform role. A signed-in person with neither is an anonymous visitor: public APIs only, no contact, no node state, and 403 when the country has no public catalogue.
2. **Classification covers the fields.** A field marked `personal` or `sensitive` needs an API classified `personal` or `sensitive`. It is checked when a version is created or edited and again when it is submitted (rows from before the rule). `domain/approval.ts` keeps deciding the regulator step from the fields, so both rules read the same declaration.
3. **Compatibility.** The revision is compared recursively (nested properties, array `items`, `additionalProperties`, parameters, request body, responses, required properties). What cannot be compared (composed schemas that differ, nesting beyond a limit, a work budget shared by the whole comparison) is incompatible. Reference pairs are decided once, so an untrusted document cannot make the comparison exponential.
4. **Editing a returned version.** `PUT /entities/{entityId}/apis/{apiId}/versions/{versionId}` replaces the declaration (fields, legal basis, purposes, upstreams, optionally the OpenAPI) of a version in `draft` or `changes_requested`, with the validation of creation (upstream types of P-04 included), guarded against concurrent changes, audited as `api_version.updated`.
5. **Consumer in analytics.** The consumer's slug is resolved only among entities that can hold it (not `requested` or `rejected`), the same set the unique index covers.
6. **Host control for the contract test.** A `direct` sandbox must serve, over HTTPS at `/.well-known/den-validation`, `HMAC-SHA256(DEN_VALIDATION_TOKEN, "den-host-control:<entityId>:<host>")` (base64url). The portal shows it (`GET .../versions/{versionId}/host-proof`) and fetches it before the contract test: the name is resolved once, every address must be public, and the connection goes to exactly that vetted address (Host and SNI keep the name), so a DNS answer that changes in between cannot reach an internal address; no redirects, 10 s in all, at most 256 bytes read. Without it the contract test fails with "host control not proven" and the operator cannot approve. `node` and `xroad` sandboxes are the entity's own by construction. Asking for the validations again has a cooldown per version (`DEN_VALIDATION_COOLDOWN_SECONDS`, 300) and a cap per entity and hour (`DEN_VALIDATION_MAX_PER_HOUR`, 10), both a 429 with a translated reason, and the route is in the strict rate-limit class. The checks and the audit event that counts for the next request happen in one transaction under a per-entity advisory lock, and a run still queued is not asked for again, so concurrent requests cannot all pass.
7. **E-mail subjects are fixed text** per notification kind and language. The sentence with names and comments stays in the body.

## Alternatives considered

- **Keep the authenticated catalogue and document it.** Rejected: self-registration makes "authenticated" mean nothing, and the catalogue shows personal-data field names and contacts.
- **Derive an effective classification from the fields** instead of rejecting. It would silently change the maximum validity and approvals of an API the reviewer saw under another classification; rejecting makes the provider say it.
- **Restrict the sandbox to hosts of the entity's node.** It would close the abuse but remove the `direct` sandbox that providers with existing APIs use. The proof keeps it.
- **Log the entity id in the gateway instead of filtering by status** (MB-1). Changes the access-log format and the Fluent Bit allowlist for a collision the status filter already rules out.

## Consequences

- Newly registered people see an empty catalogue (or a 403) until they belong to an entity: the portal's catalogue pages show that error.
- Providers with a `direct` sandbox publish one text file; the contract test no longer runs against hosts nobody proved.
- The proof is fetched by the API process, so it needs outbound HTTPS. The gateway's own call to the sandbox resolves the name by itself (its upstream checks are unchanged).
- Validations cannot be spammed; right after a submission the provider waits the cooldown before asking again.
