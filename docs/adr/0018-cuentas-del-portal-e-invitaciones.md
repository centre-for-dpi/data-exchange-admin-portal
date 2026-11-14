# ADR-0018 — Cuentas del portal: autorregistro con correo verificado; los roles llegan por alta o invitación

- Estado: Aceptado
- Fecha: 2026-11-13

## Contexto
El alta de entidades (SPEC.md §4.1, M2-01) la inicia "un funcionario". Al aprobarse, el solicitante queda como `entity_admin` y los responsables designados reciben invitaciones. M2-02 agrega que el `entity_admin` invite por correo.

El realm `rid-portal` no permitía autorregistro: solo existían las cuentas de la semilla. Así nadie nuevo podía pedir un alta ni aceptar una invitación sin que un técnico creara su cuenta. Eso contradice el cierre de M2: "sin intervención técnica".

## Decisión
1. **Autorregistro en `rid-portal` con verificación de correo obligatoria.** Keycloak no deja iniciar sesión hasta que la persona confirma su correo. Registrarse no da ningún rol (ADR-0004): una cuenta nueva solo puede pedir el alta de una entidad y ver sus invitaciones.
2. **Los roles llegan solo por dos caminos, ambos auditados:**
   - una **solicitud de alta aprobada**, donde el solicitante pasa a `entity_admin`;
   - una **invitación aceptada**.
3. **Una invitación va a un correo, no a una cuenta.** La persona la ve en el portal cuando entra con una cuenta cuyo correo **verificado** coincide; el correo de aviso solo trae un enlace al portal, sin secreto. Si alguien interceptara el aviso, no le serviría sin poder entrar con ese correo. El API vuelve a exigir `email_verified` en el token al aceptar.
4. **El portal no crea usuarios en Keycloak.** No hay llamadas a la Admin API para cuentas de personas. En un despliegue con identidad nacional federada, el registro local se apaga en el realm y el resto del flujo no cambia.

## Alternativas consideradas
- **Que el portal cree la cuenta del invitado en Keycloak** (Admin API más `execute-actions-email`). Hace falta otro reconciliador y una cuenta de servicio con permisos de administración de usuarios. Además duplica en el portal datos personales que ya están en Keycloak. Se descarta.
- **Invitación con un token secreto en el enlace.** Es un secreto más que guardar (aunque sea su hash) y sirve a quien reenvíe el correo. Con el correo verificado basta.
- **Mantener sin autorregistro y crear las cuentas a mano.** Contradice el cierre de M2 ("sin intervención técnica").

## Consecuencias
- Cualquiera con un correo puede crear una cuenta, pero sin roles no ve nada de ninguna entidad. El abuso posible es pedir altas falsas; cada persona tiene un límite de solicitudes abiertas y todas pasan por un revisor.
- La verificación del correo depende del SMTP de Keycloak (Mailpit en desarrollo).
- Si alguien cambia su correo en Keycloak, sus invitaciones pendientes siguen ligadas al correo anterior.
