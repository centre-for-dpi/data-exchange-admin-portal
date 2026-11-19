# Authorization matrix

> Versión en español: [docs/es/AUTHZ.md](es/AUTHZ.md)

> Generated from `apps/api/src/auth/authz.policy.ts` and the API routes. Do not edit it by hand:
> `DEN_UPDATE_AUTHZ_DOC=1 pnpm --filter @den/api test -- authz.matrix`.

Rules of the global guard (ADR-0014): without a session, 401. On entity routes: someone who is not a member
and has no allowed platform role gets 404; a member without the role, 403. On platform
routes: without the role, 403. A route without an access declaration cannot be called (403).

Second factor (M3-08, ADR-0021): whoever has a platform role or one of `data_steward`, `entity_admin`
in some entity gets 403 `mfa_required` on every entity or platform route if their session
was not opened with the one-time code. Routes for any session (`/me`) stay open.

## Actions on an entity's resources

| Action | `entity_admin` | `api_publisher` | `data_steward` | `app_developer` | `entity_viewer` | `platform_admin` | `platform_reviewer` | `regulator` | `auditor` |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `entity.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `entity.members.read` | ✓ | · | · | · | ✓ | ✓ | · | ✓ | · |
| `entity.members.write` | ✓ | · | · | · | · | · | · | · | · |
| `api.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `api.write` | · | ✓ | · | · | · | · | · | · | · |
| `application.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · |
| `application.write` | · | · | · | ✓ | · | · | · | · | · |
| `subscription.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | ✓ | · |
| `subscription.write` | · | · | · | ✓ | · | · | · | · | · |
| `access_request.read` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · | ✓ | · |
| `access_request.decide` | · | · | ✓ | · | · | · | · | · | · |
| `access_request.suspend` | · | · | ✓ | · | · | ✓ | · | ✓ | · |
| `api.purposes.write` | · | · | ✓ | · | · | · | · | · | · |
| `node.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `node.write` | ✓ | · | · | · | · | ✓ | · | · | · |
| `bootcamp.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `bootcamp.write` | ✓ | · | · | · | · | ✓ | · | · | · |
| `usage.provided.read` | ✓ | ✓ | ✓ | · | ✓ | ✓ | ✓ | ✓ | · |
| `usage.consumed.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `audit.entity.read` | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · |

## Platform actions

| Action | `platform_admin` | `platform_reviewer` | `regulator` | `auditor` |
| :-- | :-: | :-: | :-: | :-: |
| `review.read` | ✓ | ✓ | ✓ | · |
| `review.decide` | ✓ | ✓ | · | · |
| `entity_review.read` | ✓ | ✓ | ✓ | · |
| `entity_review.decide` | ✓ | ✓ | · | · |
| `regulator.read` | · | · | ✓ | · |
| `regulator.decide` | · | · | ✓ | · |
| `entity_admin.read` | ✓ | ✓ | ✓ | · |
| `entity_admin.decide` | ✓ | · | · | · |
| `certificate.mass_revoke` | ✓ | · | · | · |
| `gateway_key.rotate` | ✓ | · | · | · |
| `entity_admin.create` | ✓ | · | · | · |
| `purpose.read` | ✓ | ✓ | ✓ | · |
| `purpose.manage` | ✓ | ✓ | · | · |
| `document.purge` | ✓ | · | · | · |
| `document.list` | ✓ | · | · | · |
| `node.list` | ✓ | ✓ | ✓ | · |
| `bootcamp.list` | ✓ | ✓ | ✓ | · |
| `network.indicators.read` | ✓ | ✓ | ✓ | · |
| `sync.read` | ✓ | ✓ | · | · |
| `sync.retry` | ✓ | · | · | · |
| `network.map.read` | ✓ | ✓ | ✓ | · |
| `kit_release.read` | ✓ | ✓ | · | · |
| `kit_release.manage` | ✓ | · | · | · |
| `platform_role.read` | ✓ | · | · | · |
| `platform_role.manage` | ✓ | · | · | · |
| `audit.read` | ✓ | ✓ | ✓ | ✓ |

## Routes

| Method | Route | Access |
| :-- | :-- | :-- |
| GET | `/api/v1/admin/bootcamp` | platform: `bootcamp.list` |
| POST | `/api/v1/admin/certificate-revocations` | platform: `certificate.mass_revoke` |
| GET | `/api/v1/admin/certificate-revocations/preview` | platform: `certificate.mass_revoke` |
| GET | `/api/v1/admin/entities` | platform: `entity_admin.read` |
| POST | `/api/v1/admin/entities` | platform: `entity_admin.create` |
| POST | `/api/v1/admin/entities/:id/offboard` | platform: `entity_admin.decide` |
| POST | `/api/v1/admin/entities/:id/reactivate` | platform: `entity_admin.decide` |
| POST | `/api/v1/admin/entities/:id/suspend` | platform: `entity_admin.decide` |
| PUT | `/api/v1/admin/entities/:id/xroad-member` | platform: `entity_admin.decide` |
| POST | `/api/v1/admin/gateway-signing-keys/rotate` | platform: `gateway_key.rotate` |
| GET | `/api/v1/admin/kit-releases` | platform: `kit_release.read` |
| PUT | `/api/v1/admin/kit-releases/:version` | platform: `kit_release.manage` |
| PUT | `/api/v1/admin/kit-releases/:version/bundle` | platform: `kit_release.manage` |
| GET | `/api/v1/admin/nodes` | platform: `node.list` |
| GET | `/api/v1/admin/platform-roles` | platform: `platform_role.read` |
| POST | `/api/v1/admin/platform-roles/grant` | platform: `platform_role.manage` |
| POST | `/api/v1/admin/platform-roles/revoke` | platform: `platform_role.manage` |
| GET | `/api/v1/admin/purposes` | platform: `purpose.read` |
| POST | `/api/v1/admin/purposes` | platform: `purpose.manage` |
| PUT | `/api/v1/admin/purposes/:code` | platform: `purpose.manage` |
| POST | `/api/v1/admin/purposes/:code/activate` | platform: `purpose.manage` |
| POST | `/api/v1/admin/purposes/:code/deactivate` | platform: `purpose.manage` |
| GET | `/api/v1/admin/sync` | platform: `sync.read` |
| POST | `/api/v1/admin/sync/retry` | platform: `sync.retry` |
| POST | `/api/v1/admin/users/disable` | platform: `platform_role.manage` |
| POST | `/api/v1/admin/users/enable` | platform: `platform_role.manage` |
| GET | `/api/v1/audit/events` | platform: `audit.read` |
| GET | `/api/v1/audit/export` | platform: `audit.read` |
| GET | `/api/v1/audit/timeline/:kind/:id` | platform: `audit.read` |
| GET | `/api/v1/audit/verify` | platform: `audit.read` |
| GET | `/api/v1/catalog/apis` | optional session (public catalog depending on the country config) |
| GET | `/api/v1/catalog/apis/:apiId` | optional session (public catalog depending on the country config) |
| GET | `/api/v1/catalog/apis/:apiId/versions/:versionId/openapi` | optional session (public catalog depending on the country config) |
| GET | `/api/v1/catalog/entities` | optional session (public catalog depending on the country config) |
| GET | `/api/v1/data-subjects/me/accesses` | citizen (token from the citizens realm) |
| GET | `/api/v1/data-subjects/me/accesses/:id/receipt` | citizen (token from the citizens realm) |
| GET | `/api/v1/data-subjects/me/alerts` | citizen (token from the citizens realm) |
| PUT | `/api/v1/data-subjects/me/alerts` | citizen (token from the citizens realm) |
| GET | `/api/v1/documents` | platform: `document.list` |
| POST | `/api/v1/documents/:documentId/purge` | platform: `document.purge` |
| GET | `/api/v1/entities/:entityId` | entity: `entity.read` |
| GET | `/api/v1/entities/:entityId/access-requests` | entity: `access_request.read` |
| GET | `/api/v1/entities/:entityId/access-requests/:subscriptionId` | entity: `access_request.read` |
| GET | `/api/v1/entities/:entityId/access-requests/:subscriptionId/agreement` | entity: `access_request.read` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/approve` | entity: `access_request.decide` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/reactivate` | entity: `access_request.suspend` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/reject` | entity: `access_request.decide` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/request-info` | entity: `access_request.decide` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/revoke` | entity: `access_request.suspend` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/suspend` | entity: `access_request.suspend` |
| GET | `/api/v1/entities/:entityId/apis` | entity: `api.read` |
| POST | `/api/v1/entities/:entityId/apis` | entity: `api.write` |
| GET | `/api/v1/entities/:entityId/apis/:apiId` | entity: `api.read` |
| POST | `/api/v1/entities/:entityId/apis/:apiId/versions` | entity: `api.write` |
| GET | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId` | entity: `api.read` |
| PUT | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId` | entity: `api.write` |
| POST | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/deprecate` | entity: `api.write` |
| GET | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/host-proof` | entity: `api.read` |
| GET | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/openapi` | entity: `api.read` |
| PUT | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/openapi` | entity: `api.write` |
| PUT | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/purposes` | entity: `api.purposes.write` |
| POST | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/submit` | entity: `api.write` |
| POST | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/validations` | entity: `api.write` |
| GET | `/api/v1/entities/:entityId/applications` | entity: `application.read` |
| POST | `/api/v1/entities/:entityId/applications` | entity: `application.write` |
| GET | `/api/v1/entities/:entityId/applications/:applicationId` | entity: `application.read` |
| POST | `/api/v1/entities/:entityId/applications/:applicationId/certificates` | entity: `application.write` |
| GET | `/api/v1/entities/:entityId/applications/:applicationId/credentials/:credentialId/certificate` | entity: `application.read` |
| POST | `/api/v1/entities/:entityId/applications/:applicationId/credentials/:credentialId/revoke` | entity: `application.write` |
| POST | `/api/v1/entities/:entityId/applications/:applicationId/credentials/secret` | entity: `application.write` |
| GET | `/api/v1/entities/:entityId/audit/timeline/:kind/:id` | entity: `audit.entity.read` |
| GET | `/api/v1/entities/:entityId/bootcamp` | entity: `bootcamp.read` |
| PUT | `/api/v1/entities/:entityId/bootcamp/:item` | entity: `bootcamp.write` |
| GET | `/api/v1/entities/:entityId/invitations` | entity: `entity.members.read` |
| POST | `/api/v1/entities/:entityId/invitations` | entity: `entity.members.write` |
| POST | `/api/v1/entities/:entityId/invitations/:invitationId/revoke` | entity: `entity.members.write` |
| GET | `/api/v1/entities/:entityId/members` | entity: `entity.members.read` |
| POST | `/api/v1/entities/:entityId/members/:membershipId/revoke` | entity: `entity.members.write` |
| PUT | `/api/v1/entities/:entityId/members/:membershipId/roles` | entity: `entity.members.write` |
| GET | `/api/v1/entities/:entityId/nodes` | entity: `node.read` |
| POST | `/api/v1/entities/:entityId/nodes` | entity: `node.write` |
| GET | `/api/v1/entities/:entityId/nodes/:nodeId` | entity: `node.read` |
| POST | `/api/v1/entities/:entityId/nodes/:nodeId/decommission` | entity: `node.write` |
| POST | `/api/v1/entities/:entityId/nodes/:nodeId/enrollment-tokens` | entity: `node.write` |
| POST | `/api/v1/entities/:entityId/nodes/:nodeId/enrollment-tokens/:tokenId/revoke` | entity: `node.write` |
| GET | `/api/v1/entities/:entityId/subscriptions` | entity: `subscription.read` |
| POST | `/api/v1/entities/:entityId/subscriptions` | entity: `subscription.write` |
| GET | `/api/v1/entities/:entityId/subscriptions/:subscriptionId` | entity: `subscription.read` |
| GET | `/api/v1/entities/:entityId/subscriptions/:subscriptionId/agreement` | entity: `subscription.read` |
| PUT | `/api/v1/entities/:entityId/subscriptions/:subscriptionId/agreement` | entity: `subscription.write` |
| POST | `/api/v1/entities/:entityId/subscriptions/:subscriptionId/provide-info` | entity: `subscription.write` |
| POST | `/api/v1/entities/:entityId/subscriptions/:subscriptionId/withdraw` | entity: `subscription.write` |
| GET | `/api/v1/entities/:entityId/usage/consumed` | entity: `usage.consumed.read` |
| GET | `/api/v1/entities/:entityId/usage/provided` | entity: `usage.provided.read` |
| GET | `/api/v1/entity-requests` | any session; own resources only |
| POST | `/api/v1/entity-requests` | any session; own resources only |
| GET | `/api/v1/entity-requests/:requestId` | any session; own resources only |
| PUT | `/api/v1/entity-requests/:requestId` | any session; own resources only |
| GET | `/api/v1/entity-requests/:requestId/designation-document` | any session; own resources only |
| PUT | `/api/v1/entity-requests/:requestId/designation-document` | any session; own resources only |
| POST | `/api/v1/entity-requests/:requestId/submit` | any session; own resources only |
| GET | `/api/v1/gateway/jwks` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/health` | public (no session; internal routes require their own service token) |
| POST | `/api/v1/internal/subject-access` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/kit/current` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/kit/releases/:version/:file` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/me` | any session; own resources only |
| GET | `/api/v1/me/invitations` | any session; own resources only |
| POST | `/api/v1/me/invitations/:invitationId/accept` | any session; own resources only |
| POST | `/api/v1/me/invitations/:invitationId/decline` | any session; own resources only |
| GET | `/api/v1/me/notification-preferences` | any session; own resources only |
| PUT | `/api/v1/me/notification-preferences` | any session; own resources only |
| GET | `/api/v1/me/notifications` | any session; own resources only |
| POST | `/api/v1/me/notifications/:notificationId/read` | any session; own resources only |
| POST | `/api/v1/me/notifications/read-all` | any session; own resources only |
| GET | `/api/v1/network/exchanges` | platform: `network.map.read` |
| GET | `/api/v1/network/indicators` | platform: `network.indicators.read` |
| GET | `/api/v1/nodes/:nodeId/config` | kit node (mTLS with its certificate, through the gateway control route) |
| POST | `/api/v1/nodes/:nodeId/heartbeat` | kit node (mTLS with its certificate, through the gateway control route) |
| POST | `/api/v1/nodes/:nodeId/renew` | kit node (mTLS with its certificate, through the gateway control route) |
| POST | `/api/v1/nodes/enroll` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/opa/bundle.tar.gz` | public (no session; internal routes require their own service token) |
| POST | `/api/v1/opa/status` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/pki/ca` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/purposes` | any session; own resources only |
| POST | `/api/v1/regulator/api-versions/:versionId/approve` | platform: `regulator.decide` |
| POST | `/api/v1/regulator/api-versions/:versionId/request-changes` | platform: `regulator.decide` |
| GET | `/api/v1/regulator/approvals` | platform: `regulator.read` |
| POST | `/api/v1/regulator/subscriptions/:subscriptionId/approve` | platform: `regulator.decide` |
| POST | `/api/v1/regulator/subscriptions/:subscriptionId/reject` | platform: `regulator.decide` |
| GET | `/api/v1/review/api-versions` | platform: `review.read` |
| GET | `/api/v1/review/api-versions/:versionId` | platform: `review.read` |
| POST | `/api/v1/review/api-versions/:versionId/approve` | platform: `review.decide` |
| POST | `/api/v1/review/api-versions/:versionId/request-changes` | platform: `review.decide` |
| GET | `/api/v1/review/entities` | platform: `entity_review.read` |
| GET | `/api/v1/review/entities/:requestId` | platform: `entity_review.read` |
| POST | `/api/v1/review/entities/:requestId/approve` | platform: `entity_review.decide` |
| GET | `/api/v1/review/entities/:requestId/designation-document` | platform: `entity_review.read` |
| POST | `/api/v1/review/entities/:requestId/reject` | platform: `entity_review.decide` |
| POST | `/api/v1/review/entities/:requestId/request-changes` | platform: `entity_review.decide` |
| GET | `/api/v1/transparency/checkpoints` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/transparency/checkpoints/:seq` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/transparency/jwks` | public (no session; internal routes require their own service token) |
| GET | `/api/v1/transparency/records/:id/receipt` | platform: `audit.read` |
| GET | `/api/v1/transparency/verify` | platform: `audit.read` |
| GET | `/api/v1/upstream-types` | any session; own resources only |
