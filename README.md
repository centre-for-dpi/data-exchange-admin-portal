# DEN Portal — Data Exchange Network

> Versión en español: [docs/es/README.md](docs/es/README.md)

Developer portal and governance console for a national data exchange network between public entities, built 100% with open source software.

- Entities publish their APIs (existing ones, or ones created with the instant API kit).
- Other entities consume them under control: a declared purpose, approval from the data owner, their own credentials and traceability of every query.
- Traffic goes through a central API gateway (Apache APISIX) run by the national operator; the data stays at each entity.

Designed to be reused in any country: authorities, document types, sectors, legal framework and agreement texts live in `config/country/<code>.yaml`, never in the code. The repository ships `example.yaml`, a template for a new country, and `co.yaml`, the configuration of the first deployment (Colombia), as a complete reference.

## Getting started

Requirements: Node.js 24, pnpm 11, Docker Engine (or Podman) with Compose v2.

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Open http://localhost:3000. Test users are listed in `docs/DEMO.md`. The reference citizen app ("Who accessed my data?", MT-07) runs at http://localhost:3100, with `ciudadana.demo`.

For the e2e tests (`pnpm test:e2e`, with the stack up), install the browser once: `pnpm --filter @den/web exec playwright install chromium`.

### Local infrastructure

| Command | What it does |
| :-- | :-- |
| `pnpm infra:up` | Starts everything and waits until every service is healthy |
| `pnpm infra:up:core` | Same, without OpenSearch or the analytics Fluent Bit (lighter). Includes the transparency log Fluent Bit and the development TSA (port 3004) |
| `pnpm infra:ps` / `pnpm infra:logs` | Status and logs |
| `pnpm infra:down` | Stops the services (keeps the data) |
| `pnpm infra:reset` | Stops and **deletes** the volumes (database, CA, indexes) |

All ports are published on `127.0.0.1` only. If one is already in use on your machine, change it in `.env` with the matching `*_PORT` variable (see `.env.example`).

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. To report a vulnerability, do not open a public issue; follow [SECURITY.md](SECURITY.md).

## Documentation

- [CLAUDE.md](CLAUDE.md) — rules of the project, as context for AI coding agents (Claude Code); they apply to any contribution
- [docs/SPEC.md](docs/SPEC.md) — functional specification
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — technical architecture
- [docs/BACKLOG.md](docs/BACKLOG.md) — milestones and stories
- [docs/DEMO.md](docs/DEMO.md) — demo script
- [docs/INSTALL.md](docs/INSTALL.md) — **installing on a server** with `sudo ./install.sh`, and VPS requirements
- [docs/guides/operator.md](docs/guides/operator.md) — the platform explained for the operator and the regulator (presentation version: `operator.html`, also on the [guides site](https://centre-for-dpi.github.io/data-exchange-admin-portal/))
- [docs/guides/entities.md](docs/guides/entities.md) — what each participating entity designates, provides and does (presentation version: `entities.html`). The guide for providers (node, installation and publication) is in the kit repository: `docs/guides/providers.md`
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — deployment of each component (development and pilot)
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — go-live, operating routine, backups and common problems
- [docs/AUTHZ.md](docs/AUTHZ.md) — authorization matrix (generated)
- [docs/adr/](docs/adr/) — architecture decisions

## License

Apache-2.0, © 2026 Centre for Digital Public Infrastructure (CDPI). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
