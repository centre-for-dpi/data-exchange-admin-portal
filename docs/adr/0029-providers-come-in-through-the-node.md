# ADR-0029 — Providers come in through the node: upstream types allowed per country

- Status: Accepted
- Date: 2026-11-18
- Story: P-04 (`docs/BACKLOG.md`)

## Context

A version's upstream says where its service lives (`SPEC.md §3.1`). The portal offered three types to every provider: `node` (a service behind the entity's kit node), `xroad` (a service in X-Road, through the operator's Security Server) and `direct` (an HTTPS API of the entity, called by the gateway without a node).

The kit's ADR-0001 and the entities guide say that every provider connects through the node, or through X-Road where it already publishes there. The portal still offered, stored and routed `direct` upstreams, and offered X-Road in deployments without a Security Server, where such a version can never get a route. In the pilot rehearsal the labels misled too: "Existing API of the entity" read as the right choice for any existing API, and "Node of the instant-APIs kit" as if the node only served instant APIs.

The node is the better default channel for a national network:

- **No inbound exposure.** The node opens its tunnel outbound; a `direct` upstream needs the entity to publish its API on the internet, or open its firewall to the gateway, and keep a publicly trusted certificate for it.
- **One way to authenticate both ends.** Gateway and node authenticate each other with certificates of the network CA (M3-03, ADR-0023). A `direct` upstream depends on the provider's own TLS and, at best, on optional mTLS that each entity must configure.
- **Less attack surface for the gateway.** `direct` is the only type where a version names a host. It needs the SSRF guard, DNS resolution on every reconciler pass and network egress filtering (`ARCHITECTURE.md §4.1`). With the node, the gateway only reaches the WireGuard hub.
- **The same operation for everyone.** The operator sees the node's status and heartbeat; the reviewer's healthcheck hints (P-07) and the runbook assume a node.

Some countries may still need `direct`, for example for entities that already publish a hardened public API and cannot run a node yet.

## Decision

The country configuration lists the upstream types new versions may use, in `features.upstreams` (`node`, `xroad`, `direct`). It is validated at startup with the rest of the file: a non-empty list of known types, without repetitions.

- Without the key, the list is `[node, xroad]`. `direct` is opt-in: a country enables it by adding it to the list (`upstreams: [node, xroad, direct]`).
- `xroad` is offered only where the deployment has the operator's Security Server (`DEN_XROAD_SECURITY_SERVER_URL` and `DEN_XROAD_CLIENT`). A list with only `xroad` in a deployment without those settings stops the API at startup.
- The API enforces it (`GET /api/v1/upstream-types` tells the portal what is allowed). Creating a version, revising or editing its OpenAPI, and submitting it with an upstream or sandbox upstream of a type that is not allowed is a 400 (`validation_failed`) with the field error key `upstream_type_not_allowed` on `upstream.type` or `sandboxUpstream.type`, or `xroad_not_configured` for `xroad` without the deployment's settings.
- The version form offers only the allowed types. With a single one (the node, in a deployment without X-Road) it does not ask: it asks for the node and the service path. The labels name the channel, not the product: "Node of the entity (own API or instant API)", "Public API of the entity (HTTPS, no node)", "Service in X-Road".
- Versions that already have a type the country no longer accepts keep their route and keep working. The version sheet says so to the provider and the reviewer, and the sync console lists them for the operator, who decides: keep them, ask the entity for a new version through the node, or enable the type again.

Colombia (`co.yaml`) lists `[node, xroad]`.

## Alternatives considered

- **Remove `direct` from the product.** Simpler, but it would break the versions already registered with it and leave no way for a country that needs it. Keeping it behind a country flag costs little: the reconciler code already exists and is tested.
- **A deployment environment variable instead of the country configuration.** Which channels a network accepts is a policy of the country, like `features.mtls.required`, and belongs in its YAML (CLAUDE.md, rule 6). Only what depends on the infrastructure, the Security Server, comes from the environment.
- **Stop routing versions whose type is no longer allowed.** It would cut the service of a provider because of a configuration change, without a decision. The operator decides instead, with the flag in the sync console.

## Consequences

- New deployments get the node by default, and X-Road only when they configure it. A country that needs `direct` says so explicitly in its configuration.
- A version with a type that is no longer allowed cannot be revised or submitted; the provider registers a new major version through the node, or the country enables the type again.
- The local development environment has no Security Server, so the form only offers the node there; the X-Road e2e test registers a version only when the API runs with `DEN_XROAD_*`.
- The entity onboarding material can say "through the node" without exceptions, unless the country enables others.
