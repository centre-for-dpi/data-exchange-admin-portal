# ADR-0014 — El contexto de entidad viaja en la ruta del API

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
Un usuario puede pertenecer a varias entidades con roles distintos (SPEC.md §2.2) y la web tiene un selector de "entidad activa". El API necesita saber en nombre de qué entidad actúa cada petición, para aplicar la regla de `CLAUDE.md`: el rol correcto puede, los demás miembros reciben 403 y otra entidad recibe 404. Además, los roles se reevalúan en cada petición (ADR-0004).

## Decisión
- Todo recurso que pertenece a una entidad se expone bajo **`/api/v1/entities/{entityId}/...`**. La entidad activa es solo una preferencia de la interfaz (cookie `rid-active-entity`, validada contra las membresías); el API no la conoce ni depende de ella.
- Un guard global autentica cada endpoint, salvo los marcados con `@Public()`. En los endpoints con `@EntityAccess('<acción>')` aplica una tabla de permisos central (`apps/api/src/auth/policy.ts`), en este orden:
  1. sin membresía activa en esa entidad ni rol de plataforma permitido para la acción → **404**, sin revelar si la entidad existe;
  2. miembro sin un rol permitido → **403**;
  3. rol de plataforma permitido pero la entidad no existe → **404**.
- Los roles se leen de PostgreSQL en cada petición. Un usuario de Keycloak que entra por primera vez se registra sin roles y con auditoría (`user.registered`).

## Alternativas consideradas
- **Cabecera `X-RID-Entity`:** es invisible en logs y en la documentación del API, fácil de olvidar en un cliente y difícil de cachear. Además, la regla de 404 dependería de que cada endpoint lea la cabecera.
- **Entidad dentro del token (claim de Keycloak):** acopla los roles al proveedor de identidad, contrario a ADR-0004, y no cambia sin volver a iniciar sesión.

## Consecuencias
- Las URL son explícitas y la autorización por entidad es uniforme y verificable con pruebas generadas por tabla (M2-03).
- La web compone las rutas con el `entityId` de la entidad activa.
- Los recursos globales (catálogo, consola del operador) viven fuera de `/entities/{entityId}` y se protegen con roles de plataforma.
