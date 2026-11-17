# Portal DEN — red de intercambio de datos (Data Exchange Network)

> English version (official): [README.md](../../README.md)

Portal de desarrolladores y consola de gobierno para una red nacional de intercambio de datos entre entidades públicas, construido 100 % con software open source.

- Las entidades publican sus APIs (existentes o creadas con el kit de APIs instantáneas).
- Otras entidades las consumen con control: finalidad declarada, aprobación del dueño del dato, credenciales propias y trazabilidad de cada consulta.
- El tráfico pasa por un API gateway central (Apache APISIX) operado por el operador nacional; los datos se quedan en cada entidad.

Diseñado para reutilizarse en cualquier país: autoridades, tipos de documento, sectores, marco legal y textos de acuerdos viven en `config/country/<código>.yaml`, nunca en el código. El repositorio incluye `example.yaml`, una plantilla para un país nuevo, y `co.yaml`, la configuración del primer despliegue (Colombia), como referencia completa.

## Empezar

Requisitos: Node.js 24, pnpm 11, Docker Engine (o Podman) con Compose v2.

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Abre http://localhost:3000. Usuarios de prueba en `docs/es/DEMO.md`. La app ciudadana de referencia ("¿Quién consultó mis datos?", MT-07) queda en http://localhost:3100 con `ciudadana.demo`.

Para las pruebas e2e (`pnpm test:e2e`, con el stack arriba) instala una vez el navegador: `pnpm --filter @den/web exec playwright install chromium`.

### Infraestructura local

| Comando | Qué hace |
| :-- | :-- |
| `pnpm infra:up` | Levanta todo y espera a que cada servicio esté sano |
| `pnpm infra:up:core` | Igual, sin OpenSearch ni el Fluent Bit de analítica (más liviano). Incluye el Fluent Bit del registro de transparencia y la TSA de desarrollo (puerto 3004) |
| `pnpm infra:ps` / `pnpm infra:logs` | Estado y logs |
| `pnpm infra:down` | Detiene los servicios (conserva datos) |
| `pnpm infra:reset` | Detiene y **borra** volúmenes (base de datos, CA, índices) |

Todos los puertos se publican solo en `127.0.0.1`. Si alguno ya está ocupado en tu máquina, cámbialo en `.env` con la variable `*_PORT` correspondiente (ver `.env.example`).

## Contribuir

Las contribuciones son bienvenidas: lee [CONTRIBUTING.md](../../CONTRIBUTING.md) antes de abrir un pull request. Para reportar una vulnerabilidad no abras un issue público; sigue [SECURITY.md](../../SECURITY.md).

## Documentación

- [CLAUDE.md](../../CLAUDE.md) — reglas del proyecto, como contexto para agentes de programación (Claude Code); aplican a cualquier contribución
- [docs/es/SPEC.md](SPEC.md) — especificación funcional
- [docs/es/ARCHITECTURE.md](ARCHITECTURE.md) — arquitectura técnica
- [docs/BACKLOG.md](../BACKLOG.md) — hitos e historias
- [docs/es/DEMO.md](DEMO.md) — guion de demo
- [docs/es/INSTALL.md](INSTALL.md) — **instalación en un servidor** con `sudo ./install.sh` y requisitos del VPS
- [docs/es/guides/operator.md](guides/operator.md) — la plataforma explicada para el operador y el regulador (versión para proyectar: `operator.html`, también en el [sitio de las guías](https://centre-for-dpi.github.io/data-exchange-admin-portal/))
- [docs/es/guides/entities.md](guides/entities.md) — qué designa, dispone y hace cada entidad participante (versión para proyectar: `entities.html`). La guía de las proveedoras (nodo, instalación y publicación) está en el repositorio del kit: `docs/es/guides/providers.md`
- [docs/es/DEPLOYMENT.md](DEPLOYMENT.md) — despliegue de cada componente (desarrollo y piloto)
- [docs/es/OPERATIONS.md](OPERATIONS.md) — puesta en marcha, rutina de operación, respaldos y problemas frecuentes
- [docs/es/AUTHZ.md](AUTHZ.md) — matriz de autorización (generada)
- [docs/adr/](../adr/) — decisiones de arquitectura

## Licencia

Apache-2.0, © 2026 Centre for Digital Public Infrastructure (CDPI). Ver [LICENSE](../../LICENSE) y [NOTICE](../../NOTICE).
