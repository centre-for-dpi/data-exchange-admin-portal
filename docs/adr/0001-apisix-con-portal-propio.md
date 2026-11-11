# ADR-0001 — Apache APISIX como gateway, con portal propio

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
La red necesita un gateway central con portal de desarrolladores, flujo de aprobación de publicaciones y suscripciones, auditoría y roles por entidad. La regla es usar solo open source.

## Decisión
Usar **Apache APISIX** (Apache-2.0, Apache Software Foundation) como gateway y construir el **portal propio** (este repositorio) para catálogo, flujos de aprobación, credenciales y auditoría.

## Alternativas consideradas
- **Gravitee APIM Community Edition:** trae portal y suscripciones, pero Audit Trail, roles personalizados, registro dinámico de clientes, alertas, sharding tags y autoservicio de certificados mTLS son Enterprise (documentación APIM 4.13). Son justo las capacidades de gobierno que exige un regulador.
- **WSO2 API Manager:** el código es Apache-2.0, pero la distribución libre no tiene compromiso de parches de seguridad.
- **Kong Gateway OSS:** sin versiones OSS publicadas después de 3.9 según la comunidad, sin aclaración del proveedor; el portal es comercial.

## Consecuencias
- Esfuerzo estimado del portal: 20–25 semanas-persona para el MVP completo.
- Gobernanza neutral (fundación) en el componente crítico y control total de auditoría y roles.
- El portal es reutilizable por otros países como bien público digital.
- Asumimos el mantenimiento del portal (0,5–1 perfil de tiempo completo).
