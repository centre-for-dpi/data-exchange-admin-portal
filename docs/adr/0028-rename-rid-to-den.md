# ADR-0028 — The network is called DEN, not RID

- Status: Accepted
- Date: 2026-11-17
- Changes: the names used by ADR-0001 to ADR-0027 and by the node contract v1

## Context

The network was called RID, from the Spanish "Red de Intercambio de Datos". The portal is meant to be reused in any country (ADR-0001), and the acronym only makes sense in Spanish. The documentation already spells the name out in English as Data Exchange Network (DEN). The provider kit (its ADR-0005) makes the same change at the same time.

Only a test release (v0.1.0) existed and no entity had installed the kit, so the contract could change without a compatibility period.

## Decision

Every identifier that carried `rid` carries `den` instead:

- the contract headers `X-RID-*` are `X-DEN-*` (`X-DEN-Assertion`, `X-DEN-Purpose`, `X-DEN-End-User`, `X-DEN-Subject-Ref`…), and the OpenAPI extensions `x-rid-*` are `x-den-*`;
- the workspace packages `@rid/*` are `@den/*`;
- the environment variables `RID_*` are `DEN_*`;
- the gateway plugins `rid-*` are `den-*` (`den-assertion`, `den-client-cert`, `den-data-subject`, `den-header-guard`, `den-rate-limited`);
- the Helm charts `rid` and `rid-platform` are `den` and `den-platform`, with their value keys, Keycloak realms and clients, step-ca provisioners, database roles and names, Compose project, images and Grafana dashboards;
- the names the portal derives for a node (`den-node-<id>`) and for the gateway's client certificate;
- the default identifiers that carried the old name as text, such as the transparency log id and the audience `den-transparency-api`;
- the prose: "RID" is "DEN" in every document, in English and in Spanish.

The version of the node contract does not change. The records of what was decided and measured before this change keep the names they used: the accepted ADRs, the spikes, the performance reports and the plans. Reading them, `rid` means `den`.

## Alternatives considered

- **Rename only the prose.** The code would keep `X-RID-*` and `rid-node` under a network called DEN.
- **Contract v2 with the old names accepted for a while.** It is the right call once entities depend on the contract, and unneeded before that.

## Consequences

- Anything created with the old names is useless: sealed secrets, the transparency log, issued certificates, and the data of the development stack. The VPS is wiped and deployed again from scratch with the installer.
- Local development: rename the variables of `.env` (`RID_*` to `DEN_*`), run `pnpm install` (the workspace links change) and `pnpm infra:reset`.
- The generated `docs/AUTHZ.md`, its Spanish copy and the contract file changed with the names.
- The v0.1.0 images are withdrawn; the next release is built with the new names.
