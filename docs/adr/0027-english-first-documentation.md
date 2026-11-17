# ADR-0027 — English-first documentation

- Status: Accepted
- Date: 2026-11-17

## Context

The portal is meant to be reused by any country as a digital public good (ADR-0001), and each operator will fork it, deploy it and maintain it. Documentation only in Spanish narrows that audience. The first deployment, Colombia, still needs it in Spanish.

## Decision

- The official documentation is in English, at the main paths, with English file names. The guides moved from `docs/guias/` to `docs/guides/` (`entities`, `operator`).
- A Spanish version lives under `docs/es/`, mirroring the English paths, and is updated in the same commit as the English one. Each file links to its counterpart in its first lines.
- The generated `docs/AUTHZ.md` is generated in both languages (`docs/es/AUTHZ.md`), and its test checks both.
- ADRs, spikes, performance reports and `docs/BACKLOG.md` written before this decision stay in Spanish as a historical record; new ones are written in English.
- `infra/*/README.md` (developer notes next to the code) are English only.
- The product UI is out of scope: it is already bilingual through `next-intl`, and so is the default language of the country config. The installer (`install.sh`) still prints Spanish.

The provider kit made the same decision for its documentation and also made its messages bilingual (the kit's ADR-0004).

## Alternatives considered

- **Keep Spanish as the primary language, with an English translation.** Every new country would read a translation that might lag behind.
- **Translate everything, ADRs included.** Translating them is a lot of work for a historical record.

## Consequences

- Every documentation change touches two files. The reviewer, not a test, checks that both say the same.
- Links and paths that pointed to `docs/guias/` changed; references in the historical documents stay as they were written.
