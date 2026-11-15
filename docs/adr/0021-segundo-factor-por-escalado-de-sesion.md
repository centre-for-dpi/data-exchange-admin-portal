# ADR-0021 — Segundo factor por escalado de sesión, exigido por el API

- Estado: Aceptado
- Fecha: 2026-11-15

## Contexto
`SPEC.md §8` exige MFA para los roles de plataforma y para `data_steward` (M3-08). Keycloak autentica y aplica el segundo factor (ADR-0004), pero no sabe quién lo necesita, porque los roles viven en PostgreSQL. `ARCHITECTURE.md §3.1` preveía que el portal sincronizara un atributo `requires_mfa` en cada usuario de `rid-portal`, y que el flujo de login lo leyera.

Esa sincronización tiene dos costos:
- El API necesitaría una cuenta de servicio con `manage-users` en `rid-portal`. Ese permiso basta para cambiar contraseñas y correos de cualquier persona, así que un compromiso del portal sería también un compromiso de las cuentas.
- El atributo llega tarde. Entre el cambio de rol y la reconciliación, la sesión ya abierta sigue sin segundo factor, y nada en el backend lo impide.

Keycloak trae autenticación escalonada (*step-up*): el cliente pide un nivel con `acr_values`, el flujo de login exige más pasos para ese nivel, y el token declara en `acr` el nivel alcanzado.

## Decisión
- **Keycloak ofrece dos niveles** en `rid-portal`. El flujo de navegador `rid-browser` tiene dos subflujos condicionados por *Condition – Level of Authentication*:
  - nivel 1 (`acr=password`): usuario y contraseña;
  - nivel 2 (`acr=mfa`): código de un solo uso TOTP (*OTP Form*).
  - El mapa del realm es `acr.loa.map = {"password": 1, "mfa": 2}`.
  - Quien no tiene un segundo factor configurado y pide el nivel 2 pasa por `CONFIGURE_TOTP` (enrolamiento con una app autenticadora).
  - Un código sirve una sola vez.
- **El portal decide quién lo necesita.** Cualquier rol de plataforma, o `data_steward` en alguna entidad, exige el segundo factor (`requiresMfa`, `authz.policy.ts`). El requisito es de la persona, no de la entidad, como la sesión de Keycloak a la que se aplica.
- **El API lo exige.** En toda ruta de entidad o de plataforma, el guard responde 403 `mfa_required` si los roles lo exigen y el `acr` del token no es `mfa`. Lo hace después de las comprobaciones de rol: otra entidad sigue siendo 404. Las rutas de cualquier sesión (`/me`, recursos propios) quedan abiertas. `/me` informa `mfa.required` y `mfa.satisfied`.
- **La web escala la sesión.** Si `/me` o una llamada dicen que falta el factor, la web vuelve a iniciar sesión con `acr_values=mfa`. Dentro de la sesión de Keycloak, eso solo pide el código.
  - Una cookie corta evita los bucles: si el escalado no consiguió el nivel, el encabezado muestra un aviso con un botón para reintentar.
- **Sin escritura en Keycloak desde el portal** para esto: el portal sigue sin permisos sobre los usuarios de `rid-portal`.
- **Desarrollo y demo:** los usuarios semilla con rol crítico traen un secreto TOTP conocido, `RID_DEMO_TOTP_SECRET`, aleatorio en el piloto. Los e2e, `pnpm demo` y `pnpm demo:otp` generan el código. En producción no hay usuarios semilla: cada persona enrola su app la primera vez que el portal le pide el código.

## Alternativas consideradas
- **Atributo `requires_mfa` sincronizado por un reconciliador** (lo previsto en `ARCHITECTURE.md §3.1`). Pide el código en el primer login, sin el salto de vuelta por la web. Pero exige `manage-users` en `rid-portal` y deja una ventana sin control en el backend. Si algún país lo prefiere, puede sumarse sin quitar la comprobación del API.
- **Rol de realm `mfa-required` en Keycloak con *Conditional OTP*:** tiene el mismo problema de permisos, y además duplica en Keycloak un rol que vive en PostgreSQL (ADR-0004).
- **Segundo factor para todos:** es más simple, pero impone el enrolamiento a desarrolladores y publicadores, que no lo requieren según `SPEC.md`. El mapa de niveles permite cambiarlo con la configuración del realm.
- **WebAuthn o llaves de seguridad:** son más resistentes al phishing que TOTP. Keycloak las soporta como otro autenticador del nivel 2, y pueden agregarse sin cambiar el portal, porque el portal solo mira `acr`.

## Consecuencias
- El login de un rol crítico pasa dos veces por Keycloak (contraseña, vuelta a la web, código). La persona solo ve las dos pantallas seguidas.
- Un cambio de rol aplica en la siguiente petición. A quien recibe `data_steward` con una sesión abierta, la web le pide el código en la siguiente página.
- El código es el de la app de la persona: la recuperación de un segundo factor perdido la hace el administrador de Keycloak (borrar la credencial OTP), y queda en el registro de eventos de Keycloak.
- Un Keycloak que ya importó el realm recibe el flujo con `scripts/keycloak-portal-mfa.mjs`. Con `--demo-otp`, también los códigos de los usuarios de demo.
- `acr` es la única señal que el API lee del token además de la identidad. Si un despliegue cambia el mapa de niveles, `MFA_ACR` (`packages/contracts`) debe seguir el nombre del nivel 2.
