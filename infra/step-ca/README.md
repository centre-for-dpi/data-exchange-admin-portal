# step-ca (desarrollo)

La CA de desarrollo se inicializa sola en el primer arranque con las variables `DOCKER_STEPCA_INIT_*` de `infra/compose/docker-compose.yml`:

- Nombre: `RID Dev CA`; nombres DNS: `localhost`, `step-ca`.
- Provisioner JWK `rid-portal`: con él el API firma los CSR de las aplicaciones (M3-01).
- Contraseña de las claves y del provisioner: `STEP_CA_PASSWORD` de `.env` (el API la recibe en `RID_STEP_CA_PROVISIONER_PASSWORD`).

En cada arranque, `configure.sh` ajusta el provisioner del portal antes de iniciar la CA:

- plantilla `app.tpl`: el sujeto es solo `CN=<clientId>` (el del token), el clientId va como SAN DNS y el uso de clave es solo autenticación de cliente TLS;
- vigencia: 90 días por defecto y 397 como máximo. El portal pide `lifecycle.certificateValidityDays`.
- provisioner `rid-gateway-tls` (M3-02), que `configure.sh` crea si no existe, con la contraseña de la CA: emite el certificado de servidor TLS del gateway con la plantilla `gateway.tpl` (los nombres de `RID_GATEWAY_TLS_HOSTS`, solo autenticación de servidor, 90 días). El portal genera la clave, lo pide y lo renueva en el último tercio de su vida.

En el despliegue de una sola máquina, el contenedor del API monta solo `certs/` del volumen (no las claves) y verifica el TLS de la CA con `RID_STEP_CA_ROOT_FILE`. Fuera de esa máquina se fija la raíz con `RID_STEP_CA_ROOT_FINGERPRINT`.

El estado (raíz, intermedia, claves) vive en el volumen `step-ca-data`. `pnpm infra:reset` lo borra y la CA se regenera.

Huella de la raíz (para clientes que la necesiten):

```bash
docker compose -f infra/compose/docker-compose.yml exec step-ca step certificate fingerprint certs/root_ca.crt
```
