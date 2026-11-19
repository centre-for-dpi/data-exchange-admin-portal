# OPA (development)

`config.yaml` configures OPA to download the `den` bundle from the portal API (`GET /api/v1/opa/bundle.tar.gz`, authenticated with `OPA_BUNDLE_TOKEN`) every 10–20 s. In development the API runs on the host, so OPA reaches it at `host.docker.internal:4000`.

- While the API does not respond (for example, before `pnpm dev`), OPA logs download errors every few seconds and, with no policies, the gateway denies everything. This is expected: it fails closed. `GET http://localhost:8181/health?bundles` responds 200 only with the bundle active.
- OPA reports the active revision to `POST {url}/status`; with that report the portal moves approved subscriptions to `active`.
- OPA's *decision logs* are disabled on purpose: the input of each decision includes the request headers (`Authorization`, `X-DEN-End-User` in clear text). Access metadata goes out through APISIX → Fluent Bit (ARCHITECTURE.md §8).
- Its API requires a token (B-15, ADR-0031): `authz.rego` (`system.authz`, loaded from this directory, outside the bundle) leaves `/health` and `/metrics` open, lets the gateway query only `.../decision` rules with `DEN_OPA_DECISION_TOKEN` in the `den_token` query parameter, and requires `DEN_OPA_ADMIN_TOKEN` as a bearer token for everything else.
- `curl -H "Authorization: Bearer $DEN_OPA_ADMIN_TOKEN" http://localhost:8181/v1/config` shows the active configuration (with the credentials hidden).
