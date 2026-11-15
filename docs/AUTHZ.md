# Matriz de autorización

> Generado desde `apps/api/src/auth/authz.policy.ts` y las rutas del API. No lo edites a mano:
> `RID_UPDATE_AUTHZ_DOC=1 pnpm --filter @rid/api test -- authz.matrix`.

Reglas del guard global (ADR-0014): sin sesión, 401. En rutas de una entidad: quien no es miembro
ni tiene un rol de plataforma permitido recibe 404; un miembro sin el rol, 403. En rutas de
plataforma: sin el rol, 403. Una ruta sin declaración de acceso no se puede llamar (403).

Segundo factor (M3-08, ADR-0021): quien tiene un rol de plataforma o `data_steward`
en alguna entidad recibe 403 `mfa_required` en toda ruta de entidad o de plataforma si su sesión
no se abrió con el código de un solo uso. Las rutas de cualquier sesión (`/me`) siguen abiertas.

## Acciones sobre recursos de una entidad

| Acción | `entity_admin` | `api_publisher` | `data_steward` | `app_developer` | `entity_viewer` | `platform_admin` | `platform_reviewer` | `regulator` | `auditor` |
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
| `audit.entity.read` | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · |

## Acciones de plataforma

| Acción | `platform_admin` | `platform_reviewer` | `regulator` | `auditor` |
| :-- | :-: | :-: | :-: | :-: |
| `review.read` | ✓ | ✓ | ✓ | · |
| `review.decide` | ✓ | ✓ | · | · |
| `entity_review.read` | ✓ | ✓ | ✓ | · |
| `entity_review.decide` | ✓ | ✓ | · | · |
| `regulator.read` | · | · | ✓ | · |
| `regulator.decide` | · | · | ✓ | · |
| `entity_admin.read` | ✓ | ✓ | ✓ | · |
| `entity_admin.decide` | ✓ | · | · | · |
| `entity_admin.create` | ✓ | · | · | · |
| `purpose.read` | ✓ | ✓ | ✓ | · |
| `purpose.manage` | ✓ | ✓ | · | · |
| `document.purge` | ✓ | · | · | · |
| `document.list` | ✓ | · | · | · |
| `node.list` | ✓ | ✓ | ✓ | · |
| `bootcamp.list` | ✓ | ✓ | ✓ | · |
| `audit.read` | ✓ | ✓ | ✓ | ✓ |

## Rutas

| Método | Ruta | Acceso |
| :-- | :-- | :-- |
| GET | `/api/v1/admin/bootcamp` | plataforma: `bootcamp.list` |
| GET | `/api/v1/admin/entities` | plataforma: `entity_admin.read` |
| POST | `/api/v1/admin/entities` | plataforma: `entity_admin.create` |
| POST | `/api/v1/admin/entities/:id/offboard` | plataforma: `entity_admin.decide` |
| POST | `/api/v1/admin/entities/:id/reactivate` | plataforma: `entity_admin.decide` |
| POST | `/api/v1/admin/entities/:id/suspend` | plataforma: `entity_admin.decide` |
| PUT | `/api/v1/admin/entities/:id/xroad-member` | plataforma: `entity_admin.decide` |
| GET | `/api/v1/admin/nodes` | plataforma: `node.list` |
| GET | `/api/v1/admin/purposes` | plataforma: `purpose.read` |
| POST | `/api/v1/admin/purposes` | plataforma: `purpose.manage` |
| PUT | `/api/v1/admin/purposes/:code` | plataforma: `purpose.manage` |
| POST | `/api/v1/admin/purposes/:code/activate` | plataforma: `purpose.manage` |
| POST | `/api/v1/admin/purposes/:code/deactivate` | plataforma: `purpose.manage` |
| GET | `/api/v1/audit/events` | plataforma: `audit.read` |
| GET | `/api/v1/audit/export` | plataforma: `audit.read` |
| GET | `/api/v1/audit/timeline/:kind/:id` | plataforma: `audit.read` |
| GET | `/api/v1/audit/verify` | plataforma: `audit.read` |
| GET | `/api/v1/catalog/apis` | sesión opcional (catálogo público según la config del país) |
| GET | `/api/v1/catalog/apis/:apiId` | sesión opcional (catálogo público según la config del país) |
| GET | `/api/v1/catalog/apis/:apiId/versions/:versionId/openapi` | sesión opcional (catálogo público según la config del país) |
| GET | `/api/v1/catalog/entities` | sesión opcional (catálogo público según la config del país) |
| GET | `/api/v1/data-subjects/me/accesses` | ciudadano (token del realm de ciudadanos) |
| GET | `/api/v1/data-subjects/me/accesses/:id/receipt` | ciudadano (token del realm de ciudadanos) |
| GET | `/api/v1/data-subjects/me/alerts` | ciudadano (token del realm de ciudadanos) |
| PUT | `/api/v1/data-subjects/me/alerts` | ciudadano (token del realm de ciudadanos) |
| GET | `/api/v1/documents` | plataforma: `document.list` |
| POST | `/api/v1/documents/:documentId/purge` | plataforma: `document.purge` |
| GET | `/api/v1/entities/:entityId` | entidad: `entity.read` |
| GET | `/api/v1/entities/:entityId/access-requests` | entidad: `access_request.read` |
| GET | `/api/v1/entities/:entityId/access-requests/:subscriptionId` | entidad: `access_request.read` |
| GET | `/api/v1/entities/:entityId/access-requests/:subscriptionId/agreement` | entidad: `access_request.read` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/approve` | entidad: `access_request.decide` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/reactivate` | entidad: `access_request.suspend` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/reject` | entidad: `access_request.decide` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/request-info` | entidad: `access_request.decide` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/revoke` | entidad: `access_request.suspend` |
| POST | `/api/v1/entities/:entityId/access-requests/:subscriptionId/suspend` | entidad: `access_request.suspend` |
| GET | `/api/v1/entities/:entityId/apis` | entidad: `api.read` |
| POST | `/api/v1/entities/:entityId/apis` | entidad: `api.write` |
| GET | `/api/v1/entities/:entityId/apis/:apiId` | entidad: `api.read` |
| POST | `/api/v1/entities/:entityId/apis/:apiId/versions` | entidad: `api.write` |
| GET | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId` | entidad: `api.read` |
| POST | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/deprecate` | entidad: `api.write` |
| GET | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/openapi` | entidad: `api.read` |
| PUT | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/openapi` | entidad: `api.write` |
| PUT | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/purposes` | entidad: `api.purposes.write` |
| POST | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/submit` | entidad: `api.write` |
| POST | `/api/v1/entities/:entityId/apis/:apiId/versions/:versionId/validations` | entidad: `api.write` |
| GET | `/api/v1/entities/:entityId/applications` | entidad: `application.read` |
| POST | `/api/v1/entities/:entityId/applications` | entidad: `application.write` |
| GET | `/api/v1/entities/:entityId/applications/:applicationId` | entidad: `application.read` |
| POST | `/api/v1/entities/:entityId/applications/:applicationId/certificates` | entidad: `application.write` |
| GET | `/api/v1/entities/:entityId/applications/:applicationId/credentials/:credentialId/certificate` | entidad: `application.read` |
| POST | `/api/v1/entities/:entityId/applications/:applicationId/credentials/:credentialId/revoke` | entidad: `application.write` |
| POST | `/api/v1/entities/:entityId/applications/:applicationId/credentials/secret` | entidad: `application.write` |
| GET | `/api/v1/entities/:entityId/audit/timeline/:kind/:id` | entidad: `audit.entity.read` |
| GET | `/api/v1/entities/:entityId/bootcamp` | entidad: `bootcamp.read` |
| PUT | `/api/v1/entities/:entityId/bootcamp/:item` | entidad: `bootcamp.write` |
| GET | `/api/v1/entities/:entityId/invitations` | entidad: `entity.members.read` |
| POST | `/api/v1/entities/:entityId/invitations` | entidad: `entity.members.write` |
| POST | `/api/v1/entities/:entityId/invitations/:invitationId/revoke` | entidad: `entity.members.write` |
| GET | `/api/v1/entities/:entityId/members` | entidad: `entity.members.read` |
| POST | `/api/v1/entities/:entityId/members/:membershipId/revoke` | entidad: `entity.members.write` |
| PUT | `/api/v1/entities/:entityId/members/:membershipId/roles` | entidad: `entity.members.write` |
| GET | `/api/v1/entities/:entityId/nodes` | entidad: `node.read` |
| POST | `/api/v1/entities/:entityId/nodes` | entidad: `node.write` |
| GET | `/api/v1/entities/:entityId/nodes/:nodeId` | entidad: `node.read` |
| POST | `/api/v1/entities/:entityId/nodes/:nodeId/decommission` | entidad: `node.write` |
| POST | `/api/v1/entities/:entityId/nodes/:nodeId/enrollment-tokens` | entidad: `node.write` |
| POST | `/api/v1/entities/:entityId/nodes/:nodeId/enrollment-tokens/:tokenId/revoke` | entidad: `node.write` |
| GET | `/api/v1/entities/:entityId/subscriptions` | entidad: `subscription.read` |
| POST | `/api/v1/entities/:entityId/subscriptions` | entidad: `subscription.write` |
| GET | `/api/v1/entities/:entityId/subscriptions/:subscriptionId` | entidad: `subscription.read` |
| GET | `/api/v1/entities/:entityId/subscriptions/:subscriptionId/agreement` | entidad: `subscription.read` |
| PUT | `/api/v1/entities/:entityId/subscriptions/:subscriptionId/agreement` | entidad: `subscription.write` |
| POST | `/api/v1/entities/:entityId/subscriptions/:subscriptionId/provide-info` | entidad: `subscription.write` |
| POST | `/api/v1/entities/:entityId/subscriptions/:subscriptionId/withdraw` | entidad: `subscription.write` |
| GET | `/api/v1/entity-requests` | cualquier sesión; solo recursos propios |
| POST | `/api/v1/entity-requests` | cualquier sesión; solo recursos propios |
| GET | `/api/v1/entity-requests/:requestId` | cualquier sesión; solo recursos propios |
| PUT | `/api/v1/entity-requests/:requestId` | cualquier sesión; solo recursos propios |
| GET | `/api/v1/entity-requests/:requestId/designation-document` | cualquier sesión; solo recursos propios |
| PUT | `/api/v1/entity-requests/:requestId/designation-document` | cualquier sesión; solo recursos propios |
| POST | `/api/v1/entity-requests/:requestId/submit` | cualquier sesión; solo recursos propios |
| GET | `/api/v1/health` | pública (sin sesión; las internas exigen su propio token de servicio) |
| POST | `/api/v1/internal/subject-access` | pública (sin sesión; las internas exigen su propio token de servicio) |
| GET | `/api/v1/me` | cualquier sesión; solo recursos propios |
| GET | `/api/v1/me/invitations` | cualquier sesión; solo recursos propios |
| POST | `/api/v1/me/invitations/:invitationId/accept` | cualquier sesión; solo recursos propios |
| POST | `/api/v1/me/invitations/:invitationId/decline` | cualquier sesión; solo recursos propios |
| GET | `/api/v1/me/notification-preferences` | cualquier sesión; solo recursos propios |
| PUT | `/api/v1/me/notification-preferences` | cualquier sesión; solo recursos propios |
| GET | `/api/v1/me/notifications` | cualquier sesión; solo recursos propios |
| POST | `/api/v1/me/notifications/:notificationId/read` | cualquier sesión; solo recursos propios |
| POST | `/api/v1/me/notifications/read-all` | cualquier sesión; solo recursos propios |
| GET | `/api/v1/nodes/:nodeId/config` | nodo del kit (mTLS con su certificado, a través de la ruta de control del gateway) |
| POST | `/api/v1/nodes/:nodeId/heartbeat` | nodo del kit (mTLS con su certificado, a través de la ruta de control del gateway) |
| POST | `/api/v1/nodes/:nodeId/renew` | nodo del kit (mTLS con su certificado, a través de la ruta de control del gateway) |
| POST | `/api/v1/nodes/enroll` | pública (sin sesión; las internas exigen su propio token de servicio) |
| GET | `/api/v1/opa/bundle.tar.gz` | pública (sin sesión; las internas exigen su propio token de servicio) |
| POST | `/api/v1/opa/status` | pública (sin sesión; las internas exigen su propio token de servicio) |
| GET | `/api/v1/pki/ca` | pública (sin sesión; las internas exigen su propio token de servicio) |
| GET | `/api/v1/purposes` | cualquier sesión; solo recursos propios |
| POST | `/api/v1/regulator/api-versions/:versionId/approve` | plataforma: `regulator.decide` |
| POST | `/api/v1/regulator/api-versions/:versionId/request-changes` | plataforma: `regulator.decide` |
| GET | `/api/v1/regulator/approvals` | plataforma: `regulator.read` |
| POST | `/api/v1/regulator/subscriptions/:subscriptionId/approve` | plataforma: `regulator.decide` |
| POST | `/api/v1/regulator/subscriptions/:subscriptionId/reject` | plataforma: `regulator.decide` |
| GET | `/api/v1/review/api-versions` | plataforma: `review.read` |
| GET | `/api/v1/review/api-versions/:versionId` | plataforma: `review.read` |
| POST | `/api/v1/review/api-versions/:versionId/approve` | plataforma: `review.decide` |
| POST | `/api/v1/review/api-versions/:versionId/request-changes` | plataforma: `review.decide` |
| GET | `/api/v1/review/entities` | plataforma: `entity_review.read` |
| POST | `/api/v1/review/entities/:requestId/approve` | plataforma: `entity_review.decide` |
| POST | `/api/v1/review/entities/:requestId/reject` | plataforma: `entity_review.decide` |
| POST | `/api/v1/review/entities/:requestId/request-changes` | plataforma: `entity_review.decide` |
| GET | `/api/v1/transparency/checkpoints` | pública (sin sesión; las internas exigen su propio token de servicio) |
| GET | `/api/v1/transparency/checkpoints/:seq` | pública (sin sesión; las internas exigen su propio token de servicio) |
| GET | `/api/v1/transparency/jwks` | pública (sin sesión; las internas exigen su propio token de servicio) |
| GET | `/api/v1/transparency/records/:id/receipt` | plataforma: `audit.read` |
| GET | `/api/v1/transparency/verify` | plataforma: `audit.read` |
