# Keycloak (desarrollo)

Keycloak importa al arrancar (`--import-realm`) los archivos `*-realm.json` de esta carpeta. Los secretos no están en los archivos: son marcadores `${VARIABLE}` que Keycloak resuelve con las variables de entorno del contenedor (ver `.env.example`).

> La importación usa la estrategia `IGNORE_EXISTING`: si cambias un archivo de realm, aplica el cambio con `pnpm infra:reset && pnpm infra:up` (borra los datos locales).

## Realm `rid-portal` (personas)

- Cliente `rid-portal-web`: confidencial, Authorization Code + PKCE S256, sin password grant. El access token lleva `aud = rid-portal-api` y dura 5 minutos.
- Sin autorregistro; protección contra fuerza bruta; correo de recuperación vía Mailpit.
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

## Realm `rid-gateway` (aplicaciones consumidoras)

- Sin aplicaciones: los clientes `rid-app-<uuid>` los crea el reconciliador del portal.
- Solo tres client scopes: `basic` (`sub`), `service_account` (`client_id`) y `rid-gateway-audience` (`aud = rid-gateway`). Los tokens de aplicación no llevan perfil, correo, roles ni IP del cliente. Duran 5 minutos.
- Cliente `rid-portal-provisioner` con cuenta de servicio: solo `realm-management/manage-clients` en este realm. No puede ver usuarios ni roles, ni tocar otros realms.

## Pruebas

- `pnpm test` incluye verificaciones estáticas de estos archivos (`tests/infra`).
- `pnpm test:integration` (con el stack arriba) hace login real con cada usuario semilla y prueba los permisos del provisionador.
