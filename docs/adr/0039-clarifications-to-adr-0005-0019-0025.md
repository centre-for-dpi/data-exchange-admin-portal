# ADR-0039 — What ADR-0005, ADR-0019 and ADR-0025 do and do not promise

- Status: Accepted (clarifies ADR-0005, ADR-0019 and ADR-0025; does not replace them)
- Date: 2026-11-19
- Story: R-11 (`docs/BACKLOG.md`), rows ADR-0005, ADR-0019 and ADR-0025 of §5 of the 2026-11 general review, and B-13

## Context

Three accepted ADRs (in Spanish, not edited) state something broader than the code does. The review found each gap, and the stories that followed (R-02, R-06, R-07) changed some of the details. This ADR records what holds today, so that a reader does not take the ADRs' sentences as guarantees they are not.

## Decision

### ADR-0005: how fast a revocation takes effect

"Revocation in less than 60 seconds" holds for what OPA reads from the bundle, and for nothing else:

1. **Subscriptions and certificates: yes.** A revoked, suspended or expired subscription, or a revoked certificate (its fingerprint leaves `data.clients[id].certificates`), changes the bundle; OPA polls every 10–20 s and the e2e test requires less than 60 s.
2. **Secrets: no, without mTLS.** Keycloak stops issuing tokens for a revoked secret as soon as the Keycloak reconciler has run, but a token already issued stays valid until it expires: `accessTokenLifespan` is 300 s in `den-gateway`. With `features.mtls.required` (on in `co.yaml`) the leaked secret is not enough: the token is bound to the certificate (`cnf.x5t#S256`) and OPA checks that certificate, so revoking the certificate is the immediate action (case 1). Without mTLS a stolen token works for up to five minutes after revocation (finding B-13). A `notBefore` per client in the bundle was considered and **not** built: it adds a bundle field, a rule and a reconciler for a window of five minutes that mandatory mTLS already closes. The operator can shorten the window by lowering the token lifespan in the realm.
3. **Not with the portal down.** The portal publishes the bundle; if it is down or unreachable, OPA keeps the last activated one (persisted on disk) and revocations decided meanwhile do not propagate. The alerts `DenOpaBundleBehind` and `DenOpaBundleFetchFailing` report it. Keeping the last bundle is deliberate (the data plane must not depend on the governance plane); the way out is to restart the API (`RUNBOOK.md`, "Portal down"), after which the reconcilers catch up with the database.

### ADR-0019: a revision does not change the exposed data

The sentence is true of the declaration and of the grants, and not of the OpenAPI document:

1. A revision replaces only the OpenAPI document and moves the minor. The exposed fields, the legal basis, the allowed purposes, the classification and every subscription's `approvedOperations` are not touched, so what was approved stays as it was.
2. The compatibility check (recursive since ADR-0036) allows what ADR-0019 listed as compatible: new operations, new optional parameters, new response properties, text changes. The operator does not review these. Bounds: no existing subscription receives a new operation (it needs an access request, which the provider's data steward decides while seeing the operation); on a `personal` or `sensitive` API the lint requires each operation, new ones included, to declare its data subject (`x-den-data-subject`), and the check refuses to change that declaration; the privacy controls follow the declared fields and the classification, not the document.
3. What it cannot bound: a provider can document a new response property that carries data the declared fields do not mention. The portal never sees response bodies (golden rule 2), so it cannot check what a service returns either way. If a country needs a reviewer on every revision, ADR-0019 already names the option (a configuration flag); it is not built.

### ADR-0025: `params` and what the user typed

"`params` never carries what the user typed" is too strong. It holds for personal data, and the code relies on this narrower rule:

1. `params` may carry **catalogue identifiers the user typed and the API rejected**, because the message needs them to say what to fix: a purpose code (`unknown_purpose`, `inactive_purpose`), operation identifiers (`unknown_operations`, `operations_not_requested`) and the description of an incompatible change, which names paths and properties of the user's own OpenAPI document (`incompatible_change`). The X-Road instance, the maximum, the number of days and similar are the configuration's, not the user's. These fields are bounded by their schemas (a purpose code up to 80 characters, an operation identifier up to 200).
2. `params` never carries a data subject, a document number or a free-text field. The `zod` keys omit the received value (`code`, `expected`, `minimum`, the received *type*).
3. The reason behind the rule is the logs, and it holds: the response goes only to the caller who sent the value, and neither the API's request log nor the audit log stores error bodies (golden rule 2).

A new `FieldErrorKey` that would echo a free-text field or anything that can be a person's data must not put it in `params`.

## Alternatives considered

- **Build the `notBefore` per client** (B-13). Rejected for now, as above; it stays an option if a country allows mTLS to be off for production traffic.
- **Review every revision with the operator.** Contradicts the point of ADR-0019 (compatible changes do not wait for a review); available as a configuration option if a country asks for it.
- **Remove the identifiers from `params` and show the generic message.** The form could no longer say which purpose or operation is wrong, the reason ADR-0025 exists.

## Consequences

- SPEC and ARCHITECTURE say "revocation within 60 s" only for what the bundle carries and list the exceptions.
- The residual risks (a five-minute window without mTLS, an unreviewed operation or property in a revision) are known and written down, not discovered.
