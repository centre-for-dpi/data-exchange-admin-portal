# ADR-0004 — Roles y membresías en el portal; Keycloak solo autentica

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
Los usuarios pertenecen a varias entidades con roles distintos, y hay reglas como la separación de funciones. Modelarlo en grupos y roles de Keycloak acopla el dominio al proveedor de identidad y complica la auditoría.

## Decisión
Keycloak autentica (y aplica MFA). Roles de plataforma y membresías por entidad viven en PostgreSQL y se evalúan en `apps/api` con una política central.

## Consecuencias
- Cualquier cambio de rol queda en la bitácora de auditoría del portal.
- El portal puede cambiar de proveedor OIDC sin migrar autorizaciones.
- La sesión debe reevaluar membresías en cada petición (no confiar en claims viejos del token).
