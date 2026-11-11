# Portal RID — Red de Intercambio de Datos

Portal de desarrolladores y consola de gobierno para una red nacional de intercambio de datos entre entidades públicas, construido 100 % con software open source.

- Las entidades publican sus APIs (existentes o creadas con el kit de APIs instantáneas).
- Otras entidades las consumen con control: finalidad declarada, aprobación del dueño del dato, credenciales propias y trazabilidad de cada consulta.
- El tráfico pasa por un API gateway central (Apache APISIX) operado por el operador nacional; los datos se quedan en cada entidad.

Primer despliegue: **Colombia** (operador: AND · gobierno: MinTIC). Diseñado para reutilizarse en cualquier país mediante `config/country/<código>.yaml`.

## Empezar

Requisitos: Node.js LTS, pnpm, Docker Engine (o Podman) con Compose.

```bash
cp .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate && pnpm db:seed
pnpm dev
```

Abre http://localhost:3000. Usuarios de prueba en `docs/DEMO.md`.

## Arrancar con Claude Code

1. Crea el repositorio, copia estos archivos y haz el primer commit.
2. Abre Claude Code en la raíz y usa como primer mensaje:

   > Lee CLAUDE.md y todos los documentos de docs/. Luego implementa el hito M0 de docs/BACKLOG.md historia por historia, siguiendo la definición de terminado. Al cerrar cada historia, márcala en el backlog y haz commit.

3. Al cerrar M0, sigue con: "Continúa con el hito M1, empezando por el SPIKE S-1."

## Documentación

- [CLAUDE.md](CLAUDE.md) — contexto y reglas para desarrollo con Claude Code
- [docs/SPEC.md](docs/SPEC.md) — especificación funcional
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — arquitectura técnica
- [docs/BACKLOG.md](docs/BACKLOG.md) — hitos e historias
- [docs/DEMO.md](docs/DEMO.md) — guion de demo
- [docs/adr/](docs/adr/) — decisiones de arquitectura

## Licencia

Apache-2.0 (propuesta; confirmar con el operador y CDPI antes de publicar).
