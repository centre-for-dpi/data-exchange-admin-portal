# ADR-0009 — Proveedores de prueba como servicios Fastify con datos sintéticos

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
M0-04 planteaba `mock-providers` como PostgREST sobre dos bases ficticias. Al contrastarlo con el guion de demo y las reglas de lint:

- PostgREST expone recursos con filtros en query (`/afiliados?id=eq.1000000001`), no por ruta (`/afiliados/1000000001`) como usa `DEMO.md`. Además viola la regla `features.lint.noIdInQuery`, que el propio portal exige a los proveedores.
- La demo pide mostrar las cabeceras `X-RID-*` que recibe el proveedor; PostgREST no ofrece un lugar natural para registrarlas.
- Se necesitaba un OpenAPI escrito a mano y estable (`infra/mock-providers/salud/openapi.yaml`) que pase el lint RID; el OpenAPI autogenerado de PostgREST no cumple las reglas (descripciones en español, `operationId`).

## Decisión
`infra/mock-providers` contiene **servicios Fastify pequeños** (TypeScript, MIT), uno por proveedor ficticio:

- `salud` — "Consulta de afiliación en salud".
- `socioeconomico` — "Registro socioeconómico".

Cada servicio:
- Genera **1.000 personas sintéticas de forma determinista** (PRNG con semilla fija) al arrancar; no hay base de datos ni datos reales. Los identificadores empiezan en `1000000001`.
- Publica su `openapi.yaml` escrito a mano, que debe pasar el lint RID.
- Expone recursos por ruta (`GET /afiliados/{id}`), nunca identificadores en query.
- Registra en su salida estándar las cabeceras `X-RID-*` y `X-Request-Id` recibidas (solo cabeceras; **nunca** el cuerpo de la respuesta ni el identificador consultado).
- Expone `GET /health` para el healthcheck de Compose y del portal.

## Alternativas consideradas
- **nginx delante de PostgREST:** resuelve la ruta con reescrituras, pero suma dos componentes por proveedor y la lógica de registro de cabeceras en configuración de nginx.
- **PostgREST con funciones RPC:** sigue usando query o POST con cuerpo; no coincide con la demo.

## Consecuencias
- Un solo lenguaje en todo el repo; los mocks se pueden probar con Vitest.
- No hace falta una base de datos para los proveedores de prueba.
- Los mocks no representan el kit real (que sí puede usar PostgREST u otra tecnología); el contrato con el kit sigue siendo `ARCHITECTURE.md §10`.
