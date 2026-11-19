# ADR-0032 — Trust in the time-stamping authority is pinned by configuration

- Status: Accepted
- Date: 2026-11-19
- Story: R-03 (`docs/BACKLOG.md`), finding M-14 of the 2026-11 general review

## Context

ADR-0016 has an **independent** RFC 3161 TSA stamp each checkpoint of the transparency register (and, since M2-09, the daily anchor of the audit trail), so that "not even the operator" can rewrite the evidence and stamp it again: in development the sigstore timestamp-server of `infra/tsa`, in production the country's accredited TSA.

The API's TSA client could only talk to the development one:

- it posted to `DEN_TSA_URL` + `/api/v1/timestamp` and fetched the chain from `DEN_TSA_URL` + `/api/v1/timestamp/certchain`, sigstore's own paths. A standard RFC 3161 TSA has one URL (often at the root of its host, or `/tsr`) and no chain endpoint: no batch or anchor would ever be stamped;
- it trusted whatever chain the TSA served about itself. A TSA that vouches for itself proves nothing: whoever controls the endpoint chooses the root the stamps are checked against.

What was left was the development TSA, an operator container with its key in a volume. The operator then holds the checkpoint signing key, the TSA's key and the database, and can rewrite and re-stamp everything. Nothing said so when that happened in production.

## Decision

1. **Two modes, chosen by whether the roots are pinned.**
   - **Pinned** (`DEN_TSA_ROOTS_FILE` set): `DEN_TSA_URL` is the full URL of the RFC 3161 endpoint and requests are POSTed to it as is (`application/timestamp-query`). A stamp is accepted only if it chains to the PEM certificates in the file (the root, plus any intermediate the TSA's tokens do not carry). Nothing about trust is downloaded from the TSA. This is the accredited TSA.
   - **Development** (no roots file): `DEN_TSA_URL` is the base of the development TSA and the sigstore paths apply, as before. A configuration already in place keeps working unchanged.
   A roots file that is set but holds no certificate is a startup error.
2. **Production says so, or refuses.** With `NODE_ENV=production`, if the trust comes from the TSA itself, or the pinned roots include the development TSA's root (`CN=DEN Dev TSA Root`, `infra/tsa/init.sh`), the API logs a loud error at start naming the guarantee that does not hold. With `DEN_TSA_REQUIRE_INDEPENDENT=true` it refuses to start instead. The Helm chart (production) requires `api.tsa.url` and `api.tsa.trustedRoots` and sets the switch to `true`; the Compose pilot, which ships the development TSA, sets it to `false` and gets the warning.
3. **Verifiers choose their roots too.** The reference citizen app pins them with `CITIZEN_APP_TSA_ROOTS_FILE`, or fetches them from where the accreditation publishes them (`CITIZEN_APP_TSA_ROOT_URL`); only by default does it use the development TSA's own chain, and then it warns in production. `den-verify-receipt` already takes `--tsa-root` from the verifier.

## Alternatives considered

- **Keep downloading the chain, from a configurable URL.** That still lets the TSA's endpoint, or whoever controls the network path to it, choose the root. Pinning is what an RFC 3161 relying party is expected to do, and it is how the API already trusts step-ca (`DEN_STEP_CA_ROOT_FILE`, `DEN_STEP_CA_ROOT_FINGERPRINT`).
- **Pin a fingerprint instead of a file.** A fingerprint checks a root the TSA sends; RFC 3161 TSAs do not serve their root, so a file is needed anyway.
- **Refuse to start by default in production.** It would stop the pilot, which runs the development TSA on purpose until the country's TSA is contracted. The warning is the default for Compose; the chart, meant for production, refuses.
- **Detect the development TSA by its URL.** The pilot can reach it under several names; its root is what identifies it.

## Consequences

- Any RFC 3161 TSA can be connected with two settings, and the stamps are checked against roots the operator chose and published, not against what the TSA says.
- The guarantee of ADR-0016 is visible when it does not hold: at every start in production, and in `/transparency/verify` while batches go unstamped (`DenTransparencyUnstamped`, B-19).
- Deployments that move to an accredited TSA must publish its roots for verifiers (DEPLOYMENT.md §3.7); stamps issued earlier by the development TSA still verify only against its chain, which must be kept (`tsa-data` backup).
- Not addressed here: a TSA that requires authentication (client certificate or credentials). If the country's TSA needs it, the client gets that option in a later change.
