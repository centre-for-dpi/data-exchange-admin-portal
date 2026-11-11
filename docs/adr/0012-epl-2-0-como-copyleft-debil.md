# ADR-0012 — EPL-2.0 permitida como copyleft débil

- Estado: Aceptado
- Fecha: 2026-11-11
- Complementa: ADR-0002 y ADR-0008

## Contexto
El CLI de Prisma 7 (`prisma`, dependencia de desarrollo del API) incluye `@prisma/studio-core`, que depende de `elkjs` con licencia **EPL-2.0** (Eclipse Public License 2.0). La lista de ADR-0008 no la incluía, así que `pnpm license:check` fallaba. Prisma es parte del stack definido en `CLAUDE.md`.

EPL-2.0 está aprobada por la OSI (lista SPDX: `isOsiApproved: true`). Es un copyleft débil a nivel de archivo, del mismo tipo que MPL-2.0: obliga a publicar las modificaciones a los archivos bajo EPL, no al código que los usa.

## Decisión
Se agrega `EPL-2.0` a la lista de licencias permitidas, en el grupo de copyleft débil junto a MPL-2.0 y LGPL. EPL-1.0 sigue fuera (no es compatible con GPL y está reemplazada por EPL-2.0).

## Alternativas consideradas
- **Cambiar Prisma por otro ORM (Drizzle, MIT):** cambia el stack de `CLAUDE.md` por una dependencia que solo usa Prisma Studio en desarrollo.
- **Excepción por paquete para `elkjs`:** ADR-0008 reserva las excepciones para paquetes de datos; usarla para código debilitaría esa regla.

## Consecuencias
- `pnpm license:check` acepta EPL-2.0 y sigue rechazando EPL-1.0, PSF-2.0 y cualquier licencia no aprobada por la OSI.
- Si alguna vez se modificara un archivo de una dependencia EPL-2.0, esa modificación debe publicarse bajo EPL-2.0.
