# Contribuir

> English version: [CONTRIBUTING.md](../../CONTRIBUTING.md)

Gracias por tu interés en el portal DEN. Está pensado para que cualquier país lo reutilice como bien público digital, así que son especialmente bienvenidas las contribuciones que lo mantienen genérico, seguro y fácil de operar.

## Antes de empezar

- **Alcance.** Este repositorio es solo el portal y el gateway. El kit de APIs instantáneas que se instala en las entidades es otro producto, con su propio repositorio (ADR-0011); `infra/mock-providers` y el nodo simulado son utilería de pruebas, no el kit.
- **Lee las reglas.** [CLAUDE.md](../../CLAUDE.md) reúne las reglas del proyecto (escritas como contexto para agentes de programación, pero aplican a todos), y [docs/es/SPEC.md](SPEC.md) y [docs/es/ARCHITECTURE.md](ARCHITECTURE.md) describen el producto y el diseño. Las decisiones ya tomadas están en [docs/adr/](../adr/).
- **Cambios grandes.** Abre primero un issue para acordar el enfoque. Un cambio de arquitectura necesita un ADR nuevo (`docs/adr/NNNN-titulo.md`, formato en `docs/adr/0000-template.md`); los ADRs aceptados no se editan, se reemplazan.
- **Los problemas de seguridad** nunca se reportan en issues públicos: ver [SECURITY.md](SECURITY.md).

## Entorno de desarrollo

Requisitos: Node.js 24, pnpm 11, Docker Engine (o Podman) con Compose v2.

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate && pnpm db:seed
pnpm dev                 # web en 3000, API en 4000
```

## Reglas que se revisan

1. **Solo open source, con licencia aprobada por la OSI.** Revisa la licencia antes de agregar una dependencia; la lista permitida está en ADR-0002, ADR-0008 y ADR-0012. `pnpm license:check` debe pasar. Lee por sí mismo las licencias de npm; para las imágenes de contenedores, las dependencias de los charts de Helm y los paquetes de Python del ejecutor de contratos, registra la licencia en `scripts/third-party-licenses.json` (ADR-0033). Los paquetes dentro de las imágenes (apk, deb) no se revisan.
2. **No se guarda el contenido de las respuestas**, ni en el portal, ni en el gateway, ni en los logs. Rutas y query strings se registran enmascarados; los titulares solo aparecen como seudónimos con clave (ADR-0006, ADR-0015).
3. **La autorización vive en el backend.** Cada endpoint verifica rol y pertenencia a la entidad, con tests de autorización: el rol correcto puede, los demás reciben 403 y otra entidad recibe 404.
4. **Todo cambio de estado de dominio emite un evento de auditoría** en la misma transacción.
5. **Los reconciliadores son idempotentes.** Nada escribe en APISIX, Keycloak u OPA desde un handler HTTP; los handlers encolan un trabajo de reconciliación.
6. **Nada específico de un país en el código.** Autoridades, tipos de documento, sectores, marco legal y textos de acuerdos van en `config/country/<código>.yaml` y en los archivos de i18n. `scripts/country-neutrality.test.mjs` lo verifica.
7. **Textos de interfaz vía i18n** (`next-intl`), en español e inglés. Código, identificadores, comentarios y commits en inglés.
8. **Sin secretos en el repositorio.** `.env.example` documenta las variables; los valores reales nunca se commitean.
9. **Accesibilidad:** toda pantalla cumple WCAG 2.1 AA y pasa la verificación automatizada de axe en Playwright.

## Verificaciones

Ejecútalas antes de abrir un pull request; el CI corre las mismas:

```bash
pnpm format:check
pnpm lint && pnpm typecheck
pnpm test                # tests unitarios, incluido scripts/
pnpm test:policy         # políticas de OPA
pnpm license:check
pnpm test:integration    # contra el stack local (pnpm infra:up)
pnpm test:e2e            # Playwright contra el stack completo
```

## Pull requests

- Cambios pequeños y enfocados, en cortes verticales (migración → servicio → endpoint → UI → e2e), con los tests de los criterios de aceptación.
- Commits en inglés con [Conventional Commits](https://www.conventionalcommits.org/): `feat(subscriptions): ...`, `fix(gateway): ...`, `docs: ...`.
- La documentación oficial va en inglés, con su versión en español en `docs/es/` en la misma ruta, actualizada en el mismo pull request (ADR-0027). Si cambias un servicio, una variable de entorno, un volumen o un paso manual, actualiza `docs/DEPLOYMENT.md` y `docs/OPERATIONS.md`.

## Adaptar el portal a un país nuevo

Copia `config/country/example.yaml` a `config/country/<código>.yaml` y complétalo; `co.yaml` (Colombia) es una referencia completa. `pnpm example:country` levanta el portal como un país que nunca ha visto y recorre la demo de punta a punta: es la forma más rápida de comprobar que una configuración está completa. Si algo que tu país necesita no se puede expresar en la configuración, abre un issue: la solución va en el esquema de configuración (`packages/config`), no en el código.

## Licencia

Al contribuir aceptas que tus contribuciones se licencian bajo la [Licencia Apache 2.0](../../LICENSE), la licencia del proyecto.
