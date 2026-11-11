# ADR-0008 — Lista de licencias permitidas ampliada y excepciones por paquete

- Estado: Aceptado
- Fecha: 2026-11-11
- Complementa: ADR-0002 (no lo reemplaza; el principio "solo licencias aprobadas por la OSI" se mantiene)

## Contexto
ADR-0002 enumera como permitidas MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0 y LGPL. El árbol de dependencias de un proyecto Next.js/NestJS típico incluye paquetes con licencias que **sí están aprobadas por la OSI** pero no aparecen en esa enumeración, y algunos paquetes de **datos** (no de código) con licencias Creative Commons:

| Paquete (transitivo) | Licencia | Tipo |
| :-- | :-- | :-- |
| `tslib` | 0BSD | OSI, permisiva |
| `glob`, `minimatch`, `lru-cache` (versiones recientes) | BlueOak-1.0.0 | OSI, permisiva |
| `argparse` (dependencia de `js-yaml`) | Python-2.0 | OSI, permisiva |
| `pako` | MIT AND Zlib | OSI, permisiva |
| `caniuse-lite` (vía Next.js / browserslist) | CC-BY-4.0 | datos de compatibilidad de navegadores |
| `spdx-license-ids`, `spdx-exceptions` | CC0-1.0 / CC-BY-3.0 | datos (listas SPDX) |

Con la lista literal de ADR-0002, `pnpm license:check` fallaría desde el primer `pnpm install`, y M0-05 exige la lista de excepciones vacía al inicio.

## Decisión
1. **Licencias permitidas** (identificadores SPDX), sin necesidad de excepción:
   - Permisivas: `MIT`, `MIT-0`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, `ISC`, `0BSD`, `BlueOak-1.0.0`, `Python-2.0`, `Zlib`, `Unlicense`.
   - Copyleft débil: `MPL-2.0`, `LGPL-2.1-only`, `LGPL-2.1-or-later`, `LGPL-3.0-only`, `LGPL-3.0-or-later`.
2. **Expresiones SPDX:** `A OR B` se acepta si al menos una opción está permitida; `A AND B` solo si todas lo están.
3. **Excepciones por paquete, no por licencia.** Licencias que no son de software (CC-BY-*, CC0-1.0) solo se aceptan para paquetes concretos de **datos** listados en `scripts/license-exceptions.json`, cada uno con nombre del paquete, licencia, motivo y fecha. Agregar una excepción requiere revisión en el PR.
4. **Siguen prohibidas** en dependencias enlazadas: GPL, AGPL, SSPL, BSL, Elastic License, Commons Clause, licencias "source-available"/"fair source", y cualquier paquete sin licencia declarada (`UNLICENSED`, `UNKNOWN`).
5. GPL/AGPL siguen permitidas solo como **servicios separados** en su propio contenedor (Grafana, k6), fuera del árbol de dependencias de Node.

## Alternativas consideradas
- **Mantener la lista literal de ADR-0002 y poner todo en excepciones:** la lista de excepciones crecería con decenas de paquetes legítimos y perdería su valor de alerta.
- **Aceptar cualquier licencia OSI automáticamente:** incluiría copyleft fuerte (GPL/AGPL) enlazado, contrario a ADR-0002.
- **Aceptar CC-BY/CC0 como licencias generales:** abriría la puerta a código bajo licencias pensadas para contenido; se limitan a paquetes de datos identificados.

## Consecuencias
- `pnpm license:check` puede pasar en verde con un árbol de dependencias real y su lista de excepciones es corta y auditable.
- La regla de oro 1 de `CLAUDE.md` remite a este ADR para la lista completa.
- Si un paquete de datos nuevo requiere excepción, se documenta en `scripts/license-exceptions.json` y se justifica en el PR.
