# Keycloak (desarrollo)

Keycloak importa al arrancar (`--import-realm`) los archivos `*-realm.json` de esta carpeta. Los secretos no están en los archivos: son marcadores `${VARIABLE}` que Keycloak resuelve con las variables de entorno del contenedor (ver `.env.example`).

> La importación usa la estrategia `IGNORE_EXISTING`: si cambias un archivo de realm, aplica el cambio con `pnpm infra:reset && pnpm infra:up` (borra los datos locales).

## Realm `rid-portal` (personas)

- Cliente `rid-portal-web`: confidencial, Authorization Code + PKCE S256, sin password grant. El access token lleva `aud = rid-portal-api` y dura 5 minutos.
- Autorregistro con verificación de correo obligatoria (ADR-0018): no se puede entrar sin confirmar el correo. Una cuenta nueva no tiene roles; solo puede pedir el alta de una entidad y aceptar invitaciones dirigidas a su correo. Protección contra fuerza bruta; correos de verificación y de recuperación vía Mailpit.
  - En un Keycloak que ya importó el realm, aplica el cambio sin borrar datos: `docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update realms/rid-portal -s registrationAllowed=true -s verifyEmail=true` (después de `kcadm.sh config credentials`).
- Usuarios semilla con IDs fijos (el seed de la base los asocia por `keycloakSub`). Contraseña: `RID_DEMO_USER_PASSWORD` (por defecto `demo`, solo en desarrollo). **Los roles no viven aquí**: los asigna el seed en PostgreSQL (ADR-0004).

| Usuario | ID (`sub`) | Rol previsto en el seed |
| :-- | :-- | :-- |
| `ana.operadora` | `0193a6c0-0000-7000-8000-000000000001` | `platform_reviewer` |
| `pedro.publicador` | `0193a6c0-0000-7000-8000-000000000002` | `api_publisher` (entidad de salud) |
| `lucia.datos` | `0193a6c0-0000-7000-8000-000000000003` | `data_steward` (entidad de salud) |
| `carlos.dev` | `0193a6c0-0000-7000-8000-000000000004` | `app_developer` (entidad de programas sociales) |
| `marta.regulador` | `0193a6c0-0000-7000-8000-000000000005` | `regulator` |
| `pablo.plataforma` | `0193a6c0-0000-7000-8000-000000000006` | `platform_admin` |
| `sofia.auditora` | `0193a6c0-0000-7000-8000-000000000007` | `auditor` |
| `elena.admin` | `0193a6c0-0000-7000-8000-000000000008` | `entity_admin` (entidad de salud) |

- **Segundo factor (M3-08, ADR-0021).** El flujo de navegador `rid-browser` tiene dos niveles: contraseña (`acr=password`) y código TOTP (`acr=mfa`, mapa `acr.loa.map`). Keycloak pide el código solo cuando la web pide `acr_values=mfa`, y el API lo exige a los roles de plataforma y a `data_steward`. Quien no tiene un código configurado pasa por `CONFIGURE_TOTP`. Un código sirve una sola vez.
  - Los usuarios semilla con esos roles (`ana`, `lucia`, `marta`, `pablo`, `sofia`) traen una credencial OTP con la clave `RID_DEMO_TOTP_SECRET`. La clave se usa tal cual, como bytes UTF-8, no en base32. `pnpm demo:otp` da el código vigente y la clave en base32 para una app autenticadora.
  - En un Keycloak que ya importó el realm, aplícalo sin borrar datos: `node scripts/keycloak-portal-mfa.mjs --demo-otp`.

## Realm `rid-gateway` (aplicaciones consumidoras)

- Sin aplicaciones: los clientes `rid-app-<uuid>` los crea el reconciliador del portal.
- Solo tres client scopes: `basic` (`sub`), `service_account` (`client_id`) y `rid-gateway-audience` (`aud = rid-gateway`). Los tokens de aplicación no llevan perfil, correo, roles ni IP del cliente. Duran 5 minutos.
- Cliente `rid-portal-provisioner` con cuenta de servicio: solo `realm-management/manage-clients` en este realm. No puede ver usuarios ni roles, ni tocar otros realms.
- Política de cliente `rid-secret-rotation` (M3-04): en los clientes con el atributo `rid.managed = true` (los que crea el portal), regenerar el secreto deja el anterior como secreto rotado, válido a lo sumo 30 días. El portal la usa para la ventana de rotación y la cierra antes al revocar.
  - En un Keycloak que ya importó el realm, aplícala sin borrar datos: `node scripts/keycloak-client-policies.mjs` (usa `KEYCLOAK_URL` y el administrador de `master` del `.env`).

## Realm `rid-citizens` (ciudadanos, MT-05)

Simula la identidad digital nacional, que en producción es la del país (`RID_CITIZEN_ISSUER`).

- Cliente `carpeta-ciudadana`: la Carpeta Ciudadana de referencia (MT-07, `RID_CARPETA_URL`). Es confidencial, usa Authorization Code + PKCE S256 y no tiene password grant. El access token lleva `aud = rid-transparency-api`, `sub` y el documento verificado (`document_type`, `document_number`); sin nombre ni correo. Dura 5 minutos.
- El documento lo fija el proveedor de identidad: el perfil de usuario solo deja editarlo al administrador.
- Ciudadanos semilla, con contraseña `RID_DEMO_USER_PASSWORD`:

| Usuario | ID (`sub`) | Documento |
| :-- | :-- | :-- |
| `ciudadana.demo` | `0193a6c0-0000-7000-8000-000000000101` | CC 1000000001 |
| `ciudadano.otro` | `0193a6c0-0000-7000-8000-000000000102` | CC 1000000002 |

Son los números que usan las e2e y la demo: `ciudadana.demo` ve en la API del titular las consultas que el gateway registró con su número.

## Pruebas

- `pnpm test` incluye verificaciones estáticas de estos archivos (`tests/infra`).
- `pnpm test:integration` (con el stack arriba) hace login real con cada usuario semilla, prueba el escalado al segundo factor (y el rechazo de un código incorrecto o repetido) y los permisos del provisionador.
