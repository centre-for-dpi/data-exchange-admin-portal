# ADR-0013 — OpenAPI del portal generado desde zod, sin @nestjs/swagger

- Estado: Aceptado
- Fecha: 2026-11-11
- Reemplaza: la línea "OpenAPI generado (`@nestjs/swagger`)" del stack en `CLAUDE.md` (ADR-0003 no menciona la herramienta y sigue vigente)

## Contexto
`@nestjs/swagger` 12 depende de `js-yaml` 5, que a su vez depende de `argparse` 3 con licencia **PSF-2.0**. Según la lista SPDX, PSF-2.0 **no** está aprobada por la OSI, así que incumple la regla de oro 1 (ADR-0002). Además, `@nestjs/swagger` genera el esquema a partir de clases con decoradores, mientras que el portal valida todas las entradas con **zod** en `packages/contracts` (regla de oro 9): habría que mantener dos descripciones de cada DTO, o sumar otra librería de adaptación.

## Decisión
- El documento OpenAPI 3.1 del API se construye en `apps/api` a partir de los mismos esquemas zod que validan las peticiones, con `z.toJSONSchema()` de zod 4. Cada endpoint registra su operación (método, ruta, esquemas de entrada y salida, respuestas de error RFC 9457) en un registro central.
- Se publica en `GET /api/docs/openapi.json` y se muestra con **Scalar API Reference** (`@scalar/nestjs-api-reference`, MIT) en `/api/docs`, la misma herramienta que el portal usa para las APIs de los proveedores.
- Una prueba verifica que todo endpoint del API aparezca en el documento, para que el OpenAPI no quede atrás del código.

## Alternativas consideradas
- **Mantener `@nestjs/swagger` y forzar `js-yaml` 4 con un override de pnpm:** parche frágil sobre la dependencia de un tercero; se rompe en la siguiente actualización.
- **`nestjs-zod` u otro adaptador zod → swagger:** sigue dependiendo de `@nestjs/swagger` y del mismo `js-yaml`.

## Consecuencias
- Un solo origen para validación y documentación: los esquemas zod de `packages/contracts`.
- Hay que escribir y mantener un registro pequeño de operaciones; se hace en la base del API (M0-08).
- El OpenAPI del portal se puede lintar con Spectral igual que las APIs de los proveedores.
