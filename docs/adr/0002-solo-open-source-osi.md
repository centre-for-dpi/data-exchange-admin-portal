# ADR-0002 — Solo software open source con licencia aprobada por la OSI

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
Es infraestructura pública digital nacional y debe poder reutilizarse en otros países. Entre 2023 y 2026 varios proyectos populares pasaron a licencias no libres (HashiCorp Vault y Packer a BSL; Directus a una licencia source-available en v12) o reservaron capacidades clave a ediciones pagas (conector Oracle de Hasura dependiente de jOOQ Enterprise; SQL Server y Oracle en ediciones comerciales de DreamFactory).

## Decisión
Toda dependencia debe tener licencia aprobada por la OSI. Permitidas: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, LGPL. GPL/AGPL solo como servicios separados no enlazados. Para componentes críticos, se prefiere gobernanza de fundación (Apache, CNCF, Linux Foundation) y que las funciones necesarias no estén en una edición paga.

## Alternativas consideradas
- Permitir "open core" cuando la edición libre alcanza hoy: rechazado por el riesgo de que funciones migren a la edición paga.

## Consecuencias
- Sustituciones explícitas: OpenBao en lugar de Vault; pg-boss en lugar de Redis/BullMQ; almacenamiento en volumen (y a futuro SeaweedFS o Garage) en lugar de MinIO; imágenes de VM sin Packer.
- `pnpm license:check` en CI bloquea dependencias no permitidas.
- Excepción inevitable documentada: si una entidad usa Oracle, el driver de Oracle no es open source; vive en el kit, no en el portal.
