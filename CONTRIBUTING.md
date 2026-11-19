# Contributing

> Versión en español: [docs/es/CONTRIBUTING.md](docs/es/CONTRIBUTING.md)

Thank you for your interest in the DEN portal. It is meant to be reused by any country as a digital public good, so contributions that keep it generic, secure and easy to operate are especially welcome.

## Before you start

- **Scope.** This repository is the portal and the gateway only. The instant API kit installed at the entities is a separate product with its own repository (ADR-0011); `infra/mock-providers` and the simulated node are test tooling, not the kit.
- **Read the rules.** [CLAUDE.md](CLAUDE.md) holds the project's rules (written as context for AI coding agents, but they apply to everyone), and [docs/SPEC.md](docs/SPEC.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describe the product and the design. Decisions already taken are in [docs/adr/](docs/adr/).
- **Larger changes.** Open an issue first to agree on the approach. A change of architecture needs a new ADR (`docs/adr/NNNN-title.md`, format in `docs/adr/0000-template.md`); accepted ADRs are not edited, they are superseded.
- **Security issues** are never reported in public issues: see [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Node.js 24, pnpm 11, Docker Engine (or Podman) with Compose v2.

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate && pnpm db:seed
pnpm dev                 # web on 3000, API on 4000
```

## Rules that are checked in review

1. **Open source only, with an OSI-approved license.** Check the license before adding a dependency; the allowed list is in ADR-0002, ADR-0008 and ADR-0012. `pnpm license:check` must pass. It reads npm licenses itself; for container images, Helm chart dependencies and the contract runner's Python packages, record the license in `scripts/third-party-licenses.json` (ADR-0033). The packages inside images (apk, deb) are not checked.
2. **No response content is stored**, in the portal, the gateway or the logs. Paths and query strings are logged masked; data subjects only appear as keyed pseudonyms (ADR-0006, ADR-0015).
3. **Authorization lives in the backend.** Every endpoint checks role and entity membership, with authorization tests: the right role can, other roles get 403, another entity gets 404.
4. **Every domain state change emits an audit event** in the same transaction.
5. **Reconcilers are idempotent.** Nothing writes to APISIX, Keycloak or OPA from an HTTP handler; handlers enqueue a reconciliation job.
6. **Nothing country-specific in the code.** Authorities, document types, sectors, legal framework and agreement texts go in `config/country/<code>.yaml` and in the i18n files. `scripts/country-neutrality.test.mjs` checks it.
7. **UI text through i18n** (`next-intl`), in Spanish and English. Code, identifiers, comments and commits in English.
8. **No secrets in the repository.** `.env.example` documents variables; real values are never committed.
9. **Accessibility:** every screen meets WCAG 2.1 AA and passes the automated axe check in Playwright.

## Checks

Run these before opening a pull request; CI runs the same ones:

```bash
pnpm format:check
pnpm lint && pnpm typecheck
pnpm test                # unit tests, including scripts/
pnpm test:policy         # OPA policies
pnpm license:check
pnpm test:integration    # against the local stack (pnpm infra:up)
pnpm test:e2e            # Playwright against the full stack
```

## Pull requests

- Small, focused changes, in vertical slices (migration → service → endpoint → UI → e2e), with the tests of the acceptance criteria.
- Commits in English with [Conventional Commits](https://www.conventionalcommits.org/): `feat(subscriptions): ...`, `fix(gateway): ...`, `docs: ...`.
- Official documentation is in English with a Spanish mirror under `docs/es/` at the same path, updated in the same pull request (ADR-0027). If you change a service, an environment variable, a volume or a manual step, update `docs/DEPLOYMENT.md` and `docs/OPERATIONS.md`.

## Adapting the portal to a new country

Copy `config/country/example.yaml` to `config/country/<code>.yaml` and fill it in; `co.yaml` (Colombia) is a complete reference. `pnpm example:country` brings the portal up as a country it has never seen and runs the demo end to end, which is the quickest way to check that a configuration is complete. If something your country needs cannot be expressed in the configuration, open an issue: the answer belongs in the configuration schema (`packages/config`), not in the code.

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the license of the project.
