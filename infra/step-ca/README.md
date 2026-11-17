# step-ca (development)

The development CA initializes itself on first start with the `DOCKER_STEPCA_INIT_*` variables in `infra/compose/docker-compose.yml`:

- Name: `DEN Dev CA`; DNS names: `localhost`, `step-ca`.
- JWK provisioner `den-portal`: the API uses it to sign the applications' CSRs (M3-01).
- Password for the keys and the provisioner: `STEP_CA_PASSWORD` from `.env` (the API receives it in `DEN_STEP_CA_PROVISIONER_PASSWORD`).

On every start, `configure.sh` adjusts the portal's provisioner before starting the CA:

- `app.tpl` template: the subject is only `CN=<clientId>` (the one in the token), the clientId goes in as a DNS SAN and the key usage is TLS client authentication only;
- validity: 90 days by default and 397 at most. The portal requests `lifecycle.certificateValidityDays`.
- provisioner `den-gateway-tls` (M3-02), which `configure.sh` creates if it does not exist, with the CA password: it issues the gateway's TLS server certificate with the `gateway.tpl` template (the names in `DEN_GATEWAY_TLS_HOSTS`, server authentication only, 90 days). The portal generates the private key, requests the certificate and renews it in the last third of its lifetime.

In the single-machine deployment, the API container mounts only `certs/` from the volume (not the keys) and verifies the CA's TLS with `DEN_STEP_CA_ROOT_FILE`. Outside that machine, the root is pinned with `DEN_STEP_CA_ROOT_FINGERPRINT`.

The state (root, intermediate, keys) lives in the `step-ca-data` volume. `pnpm infra:reset` deletes it and the CA is regenerated.

Root fingerprint (for clients that need it):

```bash
docker compose -f infra/compose/docker-compose.yml exec step-ca step certificate fingerprint certs/root_ca.crt
```
