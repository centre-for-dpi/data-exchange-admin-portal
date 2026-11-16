# ADR-0025 — Errores del API en el idioma del usuario

- Estado: Aceptado
- Fecha: 2026-11-16

## Contexto

Las acciones de servidor de la web envían el formulario tal cual al API. El API valida con zod y con sus reglas de negocio, y responde RFC 9457 con `errors[].message` en inglés. La web mostraba ese texto junto al campo.

La auditoría de accesibilidad (M6-02) encontró ese texto en inglés en páginas en español: "at most 6 months for this classification", "Too small: expected number to be >=1". Eso incumple WCAG 3.1.2 (idioma de las partes) y deja al usuario sin saber qué corregir. Lo mismo pasaba con el `detail` de los 409 y 403, que la web mostraba como error del formulario.

## Decisión

Cada error de campo del API lleva, además del `message` en inglés para los clientes del API, una `key` estable y sus `params`. La web los traduce con next-intl. Hay tres clases de clave (`packages/contracts`):

- **`FieldErrorKey`**: las reglas de negocio del API, con sus valores en `params` (`max_validity_months`, `{ max: 6 }`).
- **`ValidationMessage`**: los mensajes propios de los esquemas zod de contracts. Cada mensaje es una constante con su clave, y el API encuentra la clave por el mensaje.
- **`zod`** (`ZOD_ISSUE_KEY`): cualquier otra validación. `params` es el issue de zod sin el valor recibido (`code`, `expected`, `minimum`, el *tipo* recibido), y la web lo redacta otra vez con el locale de zod.

Un error sin campo se muestra con el texto de su `code` (`apiErrors.codes.*`), nunca con el `detail` en inglés. Un conflicto cuya razón el usuario necesita saber para seguir lleva su clave como error del formulario (`path` vacío), por ejemplo `too_many_open_requests` (`ConflictError` con `reason`).

`params` nunca lleva lo que escribió el usuario: puede ser un dato personal y terminaría en un log.

## Alternativas consideradas

- **Traducir en el API según `Accept-Language`**: obliga a duplicar los textos de la interfaz en el API, cuando la regla 7 de CLAUDE.md los pone todos en next-intl, y a mantener dos catálogos.
- **Validar en la web antes de llamar al API**: duplica las reglas de negocio, que solo el API conoce (la vigencia máxima según la clasificación, los nombres ya usados), y no cubre las validaciones que solo puede hacer el API.
- **Marcar el texto inglés con `lang="en"`**: cumple 3.1.2 en lo formal, pero el usuario sigue leyendo inglés.

## Consecuencias

- Una regla de negocio nueva que responde 400 define su `FieldErrorKey` y su texto en `messages/{es,en}.json`. La prueba `src/i18n/messages.test.ts` falla si falta alguno, igual que con los mensajes de contracts y con los códigos de error.
- El `detail` específico de un 409 o 403 ("la solicitud cambió mientras tanto") se reemplaza por el texto general del código. La interfaz ya oculta las acciones que no aplican, así que estos errores son raros y casi siempre se resuelven recargando.
- Los diagnósticos del lint de OpenAPI siguen en inglés: son técnicos, nombran reglas, rutas y campos del documento, y van a quien escribió ese documento.
- Los clientes del API que no usan `key` no cambian: `message` sigue ahí. El contrato con el kit (`docs/contracts/node-contract-v1.openapi.json`) solo gana dos campos opcionales y sigue siendo la v1.
