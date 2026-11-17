# Security policy

> Versión en español: [docs/es/SECURITY.md](docs/es/SECURITY.md)

The DEN portal governs the exchange of personal data between public entities, so we take vulnerability reports seriously and handle them privately.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a vulnerability.**

Report it privately through GitHub: in this repository's **Security** tab, choose **Report a vulnerability**. Include, as far as you can:

- the affected component (web, API, gateway configuration, OPA policies, Helm chart, installer, transparency verifier…) and the version or commit;
- the steps to reproduce it, or a proof of concept, and the impact you expect (for example, access to another entity's data, bypassing a subscription or a purpose, recovering a data subject's identity);
- any configuration it depends on (`config/country/*.yaml` flags, environment variables).

Do not include real personal data in the report: the development stack ships synthetic data for that.

We will acknowledge the report, assess it, keep you informed while we prepare a fix, and agree with you on the disclosure date. With your permission, we credit you in the advisory.

## Scope

In scope: the code and configuration in this repository, including the dependencies it pins.

Out of scope here:

- **The instant API kit** installed at the entities: it has its own repository and its own policy.
- **A country's deployment.** Each deployment is run by its national operator. Report problems with a running instance (a misconfiguration, an exposed service) to that operator; if the root cause is in this code, report it here too.
- **Development defaults.** The secrets in `.env.example`, the development Keycloak realms, the demo users, `infra/mock-providers` and `infra/mock-citizen-app` are for local development and testing only. A default that would carry over into a production installation (through `install.sh`, `scripts/make-deploy-env.mjs` or the Helm chart) is in scope.

## Supported versions

Security fixes go to the `main` branch and to the latest release.

## For operators

Keep your deployment on the latest release and follow [docs/RUNBOOK.md](docs/RUNBOOK.md) for incident response, the rotation of the intermediate CA and mass revocation of certificates. The OWASP ASVS level 2 checklist the portal is held to is in [docs/security/ASVS-L2.md](docs/security/ASVS-L2.md).
