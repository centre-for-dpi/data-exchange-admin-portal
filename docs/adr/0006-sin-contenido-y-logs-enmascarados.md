# ADR-0006 — No se guarda contenido; logs solo con metadatos enmascarados

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
La propuesta de la red promete que el gateway no es una base centralizada. Las rutas REST suelen llevar números de identificación (`/personas/{cedula}`), así que registrar la URL ya sería guardar datos personales.

## Decisión
Ni portal, ni gateway, ni logs guardan cuerpos. Los logs de acceso registran el `operationId` resuelto por OPA, nunca la ruta real ni la query. El funcionario final se registra como hash con sal. Fluent Bit aplica una lista permitida de campos como segunda barrera.

## Consecuencias
- La analítica es por operación, no por recurso consultado.
- Para investigaciones puntuales, el proveedor conserva sus propios logs con el `X-Request-Id` de correlación.
- Test automatizado en M5-01 verifica que ningún documento indexado contenga la ruta real.
