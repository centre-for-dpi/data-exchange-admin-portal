# ADR-0035 — The second factor reaches entity administrators, and sessions without it read only their own resources

- Status: Accepted (extends ADR-0021; does not replace it)
- Date: 2026-11-19
- Story: R-05 (`docs/BACKLOG.md`), findings M-01, M-02 and M-03 of the 2026-11 general review

## Context

ADR-0021 makes the API demand the second factor (Keycloak's `acr=mfa`) from every person who holds a platform role or `data_steward`, on every entity or platform route. Two gaps defeated its intent:

- **`@SignedIn` routes skip the factor** because they only reach the caller's own resources (`/me`, one's own onboarding request). `GET /entity-requests/:id` and its designation document also served the platform roles that review (operator, regulator), so a reviewer's password alone read every applicant's file: designated people, DPO, comments and the PDF (M-01).
- **`entity_admin` does not require the factor, yet decides who becomes `data_steward`.** With an administrator's password, an attacker invites an address of their own as steward, enrolls their own TOTP and approves access requests, so the steward's factor protects nothing. `node.write` (node enrollment tokens) follows the same pattern (M-02).

Separately, nothing audited who gets the platform roles: only the seed and the bootstrap wrote them, and recovering from a lost administrator meant SQL (M-03).

## Decision

1. **`entity_admin` is a role that requires the second factor**, with `data_steward` and every platform role (`MFA_ENTITY_ROLES`). The requirement stays "of the person": any membership with one of those roles makes every entity or platform route demand `acr=mfa`.
   - Onboarding keeps working: the applicant becomes `entity_admin` when the operator approves; at their next page the web sends them to Keycloak with `acr_values=mfa`, which asks them to enroll an authenticator app (`CONFIGURE_TOTP`), exactly as for a designated steward. Routes for any session (`/me`) stay reachable so the web can tell.
   - The demo administrator `elena.admin` gets the same demo one-time code as the other critical demo users (and the critical demo password).
2. **`@SignedIn` routes serve only the caller's own resources.** Reviewers read an onboarding file through `GET /review/entities/:requestId` and `.../designation-document`, `@PlatformAccess('entity_review.read')`, which demand the factor. On `/entity-requests/:id` a reviewer who is not the applicant gets 404, and the web falls back to the review route.
3. **After the decision the applicant keeps reading their file only while they hold an active membership in the entity** (B-23). A rejected applicant keeps reading the reasons (nothing was granted); an approved one who loses the membership gets 404 and the request disappears from their list. Operators read it through the review routes.
4. **Platform roles and account status have an audited console path**: `POST /admin/platform-roles/grant|revoke` and `POST /admin/users/disable|enable`, `@PlatformAccess` for `platform_admin` (so with the factor), reason required, audited in the same transaction with the administrator as actor. The last active `platform_admin` can neither lose the role nor be disabled. The command line (`install.sh platform-role`) stays for the first administrator and for recovery, and shares the code.

## Alternatives considered

- **Require the factor only on `entity.members.write` and `node.write`.** Smaller blast radius, but the web would meet `mfa_required` in the middle of a form submission and lose what the person typed; the administrator would also act the first time without the factor having ever been asked. The person-level rule is simpler and is the one ADR-0021 chose.
- **Keep `@SignedIn` for reviewers and add `principal.mfa` to the review branch.** It closes the hole but keeps two meanings in one route; the guard would no longer be the single place that decides.
- **Time-limit the applicant's read access instead of tying it to the membership.** Arbitrary; the membership is the existing statement of "this person belongs to the entity".
- **Disable users in Keycloak from the console.** The portal has no administrator rights in `den-portal` (ADR-0021); disabling in the portal denies every API request at once, and the Keycloak user is left to the operator.

## Consequences

- Every entity administrator enrolls a TOTP app at their first sign-in after approval. The operator guides and the SPEC say so.
- A person who was `entity_admin` and signed in before this change gets the step-up on their next page.
- Entity administrators who lose their device are recovered like any other critical role: the Keycloak administrator deletes the OTP credential.
- The review routes and the console are the only readers of other people's onboarding files.
