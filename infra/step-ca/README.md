# step-ca (desarrollo)

La CA de desarrollo se inicializa sola en el primer arranque con las variables `DOCKER_STEPCA_INIT_*` de `infra/compose/docker-compose.yml`:

- Nombre: `RID Dev CA`; nombres DNS: `localhost`, `step-ca`.
- Provisioner JWK `rid-portal` (lo usará el backend para firmar CSR en M3-01).
- Contraseña de las claves: `STEP_CA_PASSWORD` de `.env`.

El estado (raíz, intermedia, claves) vive en el volumen `step-ca-data`. `pnpm infra:reset` lo borra y la CA se regenera.

Huella de la raíz (para clientes que la necesiten):

```bash
docker compose -f infra/compose/docker-compose.yml exec step-ca step certificate fingerprint certs/root_ca.crt
```
