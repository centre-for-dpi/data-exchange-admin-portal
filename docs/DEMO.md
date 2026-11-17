# Demo script — Milestone M1 (end of November)

> Versión en español: [docs/es/DEMO.md](es/DEMO.md)

Duration: 15 minutes. Everything runs locally with `pnpm infra:up && pnpm dev`. All data is fictitious.

**Automated rehearsal:** `pnpm demo` runs the 10 steps against the local stack with the same characters. Each one signs in to Keycloak the way they would on the web. The script narrates each step and exits with code 1 if anything does not behave as this script says. So that it can be repeated, it uses its own API on each run (`/salud/afiliacion-<run>/v1`). The full walkthrough through the UI is in `apps/web/e2e/demo.spec.ts`.

## Characters (seed users in Keycloak, password `rid-demo-password` in development only, or the one in `RID_DEMO_USER_PASSWORD`)

| User | Entity | Role |
| :-- | :-- | :-- |
| `ana.operadora` | Operator (AND) | `platform_reviewer` |
| `pedro.publicador` | Health entity (fictitious) | `api_publisher` |
| `lucia.datos` | Health entity (fictitious) | `data_steward` |
| `carlos.dev` | Social Programs entity (fictitious) | `app_developer` |
| `marta.regulador` | Regulator (MinTIC) | `regulator` |
| `ciudadana.demo` | Data subject (CC 1000000001), in the reference citizen folder; realm `rid-citizens` | — |

**Second factor (M3-08).** `ana.operadora`, `lucia.datos` and `marta.regulador`, like every platform role and `data_steward`, sign in with the password and then with a one-time code. `pnpm demo:otp` prints the current code. To show it on a phone, add the key that the same command prints to an authenticator app (TOTP, SHA-1, 6 digits, 30 s). Each code works only once; if it has already been used, wait for the next one.

## Steps

1. **Publish** (pedro.publicador): create the API "Consulta de afiliación", URL identifier `afiliacion`, upload `infra/mock-providers/salud/openapi.yaml`, upstream = test node with service path `/salud` (in development, the health mock per `RID_DEV_NODES`), classification `personal`, allowed purpose `eligibility_check`. Submit for review.
2. **Review** (ana.operadora): look at the API page and the exposed fields, approve. Show that the route appears in APISIX within seconds, with no manual intervention: a call without a token to the local gateway's HTTP port (`http://localhost:9080/salud/afiliacion/v1/afiliados/1000000001`) returns `401`.
3. **Discover** (carlos.dev): search the catalog, look at the interactive documentation.
4. **Credentials** (carlos.dev): create the application "Validador de subsidios" and copy the secret (it is shown only once). Wait until the application page says "Ready".
   - The network requires mTLS (M3-10). Under "Client certificate (mTLS)", generate the private key and the CSR with the command the page shows. The private key never leaves carlos's server. Paste the CSR and download the certificate.
   - Also download the network root from the integration guide (`rid-network-ca.pem`).
   - With a token but no subscription, the call returns `403 no_subscription`.
5. **Request** (carlos.dev): request access with purpose `eligibility_check` and the detail "Verificar afiliación al asignar el subsidio X".
6. **Approve** (lucia.datos): see the request in her inbox, approve it with a 6-month validity. carlos's page goes from "Approved (activating)" to "Active" when OPA downloads the bundle (seconds).
7. **Call** (terminal):
   ```bash
   TLS="--cert $CLIENT_ID.pem --key $CLIENT_ID.key --cacert rid-network-ca.pem"
   TOKEN=$(curl -s $TLS -d grant_type=client_credentials -u "$CLIENT_ID:$CLIENT_SECRET" \
     https://localhost:9443/oauth/token | jq -r .access_token)
   curl -s $TLS https://localhost:9443/salud/afiliacion/v1/afiliados/1000000001 \
     -H "Authorization: Bearer $TOKEN" -H "X-RID-Purpose: eligibility_check" \
     -H "X-RID-End-User: funcionario-42"
   ```
   The token is requested from the gateway and is bound to the certificate (`cnf.x5t#S256` in the token: you can see it on jwt.io or with `cut -d. -f2 <<<"$TOKEN" | base64 -d`). Without `--cert` there is no TLS session with the gateway. With the token and another application's certificate, the response is `403 certificate_mismatch`.

   Response 200. The API carries personal data, so the gateway requires the official to be identified (`X-RID-End-User`); without that header it responds `403 end_user_required`. Show the `X-RID-*` headers received in the provider mock: `docker logs rid-mock-salud-1 --since 1m`. The subscription, the operation, the entity and the application set by the gateway arrive, and only the hash of the official, never their identification in clear text.
8. **Wrong purpose**: repeat with `X-RID-Purpose: benefit_targeting` → `403 purpose_not_allowed`. The response is problem+json and carries the reason in `X-RID-Deny-Reason`.
9. **Revoke** (lucia.datos): revoke the subscription with a reason; repeat the call in a loop and watch it change to `403 no_subscription` in under 60 s (locally, about 10–20 s):
   ```bash
   while true; do curl -s $TLS -o /dev/null -w "%{http_code} " https://localhost:9443/salud/afiliacion/v1/afiliados/1000000001      -H "Authorization: Bearer $TOKEN" -H "X-RID-Purpose: eligibility_check" -H "X-RID-End-User: funcionario-42"; sleep 1; done
   ```
   **Revoke the certificate** (carlos.dev, M3-10): on the application page, "Revoke the certificate" with a reason. With the same loop, the response changes to `403 certificate_revoked` in under 60 s. The certificate is still from the CA, so the handshake succeeds, but it is no longer valid for the application.
10. **Audit** (marta.regulador): in "Audit", open the subscription from the recent events and show its timeline: requested, approved, active on the gateway, revoked, by whom and why. Then click "Verify integrity" to show that the hash chain is intact.
11. **Who accessed my data?** (ciudadana.demo, in the reference citizen folder, `http://localhost:3100`). To show the notice, do the first part before step 7.
    - Sign in with the simulated digital identity (`ciudadana.demo`, document CC 1000000001, the same one queried in step 7).
    - Under "Notices", check "Personal data" and enter an email address. The portal does not know that address: it only stores the choice and an opaque identifier.
    - After step 7, Mailpit (`http://localhost:8025`) shows the notice "An entity accessed your data", with no data about the person or the query.
    - The query appears under "Who accessed my data?": Social Programs, which API and which data, for "Verificación de requisitos de un trámite", with the official as a reference.
    - When it no longer says "Being sealed" (a few seconds), click "Verify". The citizen folder checks on its own the operator's signature, the inclusion in the sealed batch and the TSA timestamp, without trusting the portal. The receipt can also be downloaded and verified with `rid-verify-receipt`.

## Key messages for the audience

- The provider entity decides who accesses its data and for what.
- The gateway does not store what it returns; only who queried, which operation and for what purpose.
- Revoking is immediate and is audited.
- Everything is open source and reusable.
