# ADR-0033 — Licenses beyond npm: a reviewed manifest, checked offline

- Status: Accepted
- Date: 2026-11-19
- Story: R-10 (`docs/BACKLOG.md`), finding B-32 of the 2026-11 general review

## Context

Golden rule 1 (CLAUDE.md) and ADR-0002, ADR-0008 and ADR-0012 allow only OSI-approved licenses, with GPL/AGPL only for separate services in their own container. `pnpm license:check` enforced it for npm alone. Three other kinds of dependency were reviewed only by hand:

- the Python packages of the contract runner (`infra/contract-runner`), where only `schemathesis` was pinned and pip resolved the rest at build time, so what an image contained could change from one build to the next;
- the container images of Compose, the Dockerfiles, the Helm chart, the installer, the scripts and the workflows;
- the Helm chart dependencies (OpenSearch, Prometheus, Grafana, CloudNativePG and the other operators).

None of these has a license field that a tool can read offline and reliably: PyPI metadata mixes `License-Expression`, free text and classifiers, and image labels are optional and often wrong.

## Decision

1. **A manifest reviewed by hand, `scripts/third-party-licenses.json`,** records the license of each pinned Python package (with its version), of the software each third-party image ships, and of each Helm chart dependency (what it deploys). Each entry is reviewed when it is added or its version changes.
2. **`pnpm license:check` checks the manifest offline** (`scripts/license-manifest.mjs`): it must cover every package in `infra/contract-runner/requirements.txt`, at the same version; every third-party image named in `infra/compose/*.yml`, the Dockerfiles, `infra/helm/**`, `install.sh`, `scripts/*` and `.github/workflows/*`; and every dependency in `infra/helm/*/Chart.yaml`. Entries nothing uses any more fail too. Our own images (`den/*`, `ghcr.io/centre-for-dpi/*`) are not listed: their contents are what the npm and Python checks cover, plus their base images, which are.
3. **The contract runner installs exactly its pinned closure:** `requirements.txt` lists every package with `==`, and the Dockerfile installs it with `--no-deps` and then runs `pip check`. A missing dependency fails the build instead of being resolved silently.
4. **The policy applied to each entry:**
   - Python packages are linked into a program we ship: they need a license from the npm list (ADR-0008, ADR-0012).
   - Images and charts run as separate services. They may also carry another OSI-approved permissive license, today only `PostgreSQL`. GPL and AGPL are accepted only on entries marked `separateService` (ClamAV, Grafana, k6), as rule 1 says. BSL, SSPL, the Elastic License, Commons Clause and `LicenseRef-*` always fail.
   - An operating system base image (`alpine`) is marked `distribution` and needs a note: its packages carry their own licenses.

## What it does not check

- The operating system packages inside the images (apk, deb), including the `apk add` lines of our Dockerfiles: there is no offline source for them. They are system programs run as separate executables, never linked into our code. An SBOM scan of the built images (Trivy, `images.yml`) is the place to extend this if a policy for them is ever needed.
- The images the Helm chart dependencies pull: they are recorded by chart, and a chart version bump is reviewed together with what it deploys.
- That the recorded license is true. The manifest is a reviewed record; the check makes sure nothing new goes in unreviewed and nothing outside the policy is recorded.

## Alternatives considered

- **Read the licenses at check time** (`pip-licenses` in the image, image labels, the registries). It needs the network or a built image, results change with upstream metadata, and the free-text fields still need a person to map them to SPDX.
- **Document the limit only.** It leaves nothing to stop a new image or Python package from going in unreviewed, which is how B-32 was found.

## Consequences

- Adding or upgrading an image, a chart dependency or a Python package means adding or updating its entry; `pnpm license:check` (and `pnpm test`, through `scripts/license-manifest.test.mjs`) says what is missing.
- Upgrading Schemathesis means regenerating `requirements.txt` from a clean virtual environment, as its header explains.
- `PostgreSQL` is now an allowed license for separate services; for npm the list of ADR-0008 does not change.
