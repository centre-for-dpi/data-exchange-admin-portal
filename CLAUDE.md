# CLAUDE.md — Portal RID (Red de Intercambio de Datos)

Este archivo es el contexto permanente para Claude Code. Léelo completo al inicio de cada sesión.

## Qué estamos construyendo

El **Portal RID** es el portal de desarrolladores y la consola de gobierno de una red nacional de intercambio de datos entre entidades públicas. El primer despliegue es Colombia (gateway operado por la AND y gobernado por MinTIC), pero el producto debe ser **reutilizable en cualquier país**: nada específico de Colombia va en el código, todo va en `config/country/*.yaml`.

El portal NO es el gateway. El gateway es **Apache APISIX**. El portal es la capa de gobierno encima:

- Las entidades **proveedoras** registran sus APIs (OpenAPI + dónde vive el servicio).
- El **operador** (AND) revisa y aprueba la publicación; el **regulador** (MinTIC) supervisa y, según la clasificación, también aprueba.
- Las entidades **consumidoras** crean aplicaciones y solicitan acceso declarando una **finalidad**.
- El **responsable de datos** de la entidad proveedora aprueba o rechaza cada solicitud.
- El portal traduce ese estado a configuración de **APISIX**, datos de política para **OPA** y clientes en **Keycloak**.
- Todo cambio de estado queda en una **bitácora de auditoría** encadenada por hash.

Documentos que mandan (léelos antes de tocar un área):

| Documento | Para qué |
| :-- | :-- |
| `docs/SPEC.md` | Producto: actores, roles, modelo de dominio, flujos y estados, reglas de negocio |
| `docs/ARCHITECTURE.md` | Técnica: componentes, integración con APISIX/Keycloak/OPA/step-ca/OpenSearch, flujos de petición |
| `docs/BACKLOG.md` | Hitos M0–M6 con historias y criterios de aceptación. **Trabaja en orden.** |
| `docs/adr/` | Decisiones tomadas. No las contradigas sin escribir un ADR nuevo |
| `docs/DEMO.md` | Guion de la demo del hito M1 |

## Reglas de oro (no negociables)

1. **Solo open source con licencia aprobada por la OSI.** Antes de agregar cualquier dependencia, verifica su licencia. Permitidas: MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, LGPL, y las permisivas OSI de ADR-0008 (0BSD, BlueOak-1.0.0, Python-2.0, Zlib, Unlicense, MIT-0). Paquetes de datos con CC-BY/CC0 solo como excepción por paquete en `scripts/license-exceptions.json`. GPL/AGPL solo para servicios separados que corren en su propio contenedor (Grafana, k6), nunca enlazados en nuestro código. Prohibidas: BSL, SSPL, Elastic License, "source-available", "fair source", Commons Clause. Ejecuta `pnpm license:check` antes de cada commit que toque dependencias.
2. **No se guarda el contenido de las respuestas.** Ni el portal, ni APISIX, ni los logs guardan cuerpos de petición o respuesta. Solo metadatos. Rutas y query strings se registran **enmascarados** (ver `ARCHITECTURE.md §8`), porque pueden contener números de identificación.
3. **La autorización vive en el backend**, nunca solo en la UI. Cada endpoint del API verifica rol y pertenencia a la entidad. Hay tests de autorización para cada endpoint.
4. **Todo cambio de estado de dominio emite un evento de auditoría** en la misma transacción (`AuditService.record(...)`). Sin excepción.
5. **Los reconciliadores son idempotentes.** El estado deseado se calcula desde la base de datos; APISIX, OPA y Keycloak se ajustan a él. Nunca se escribe en APISIX "a mano" desde un handler HTTP.
6. **Nada específico de un país en el código.** Nombres de autoridades, tipos de documento, sectores, marco legal, textos de acuerdos: todo en `config/country/<código>.yaml` y en los archivos de i18n.
7. **UI en español por defecto, código en inglés.** Identificadores, nombres de tablas, commits y comentarios en inglés. Textos de interfaz siempre vía i18n (`next-intl`), nunca literales en componentes.
8. **Sin secretos en el repo.** `.env.example` documenta variables; los valores reales nunca se commitean.
9. **Seguridad por defecto:** OWASP ASVS nivel 2 como referencia, validación de toda entrada con zod, errores en formato RFC 9457 (`application/problem+json`), cabeceras de seguridad (CSP, HSTS) en la web.
10. **Accesibilidad WCAG 2.1 AA** en toda pantalla.

## Stack

| Capa | Tecnología |
| :-- | :-- |
| Monorepo | pnpm workspaces + Turborepo |
| Web | Next.js (App Router) + React + TypeScript, Tailwind CSS + shadcn/ui, next-intl, Auth.js (proveedor Keycloak) |
| API | NestJS con adaptador Fastify, TypeScript, OpenAPI generado (`@nestjs/swagger`) |
| Base de datos | PostgreSQL + Prisma (migraciones versionadas) |
| Trabajos en segundo plano | pg-boss (cola sobre PostgreSQL; no agregamos Redis) |
| Validación compartida | zod en `packages/contracts` (mismos esquemas en web y API) |
| Identidad | Keycloak (usuarios del portal + clientes OAuth2 de las aplicaciones consumidoras) |
| Gateway | Apache APISIX + etcd |
| Política | Open Policy Agent (OPA) con bundles servidos por el API del portal |
| PKI | step-ca (certificados mTLS de aplicaciones y nodos) |
| Logs de acceso / analítica | Fluent Bit → OpenSearch |
| Métricas / alertas | Prometheus + Alertmanager (+ Grafana para operadores) |
| Correo (dev) | Mailpit |
| Tests | Vitest (unit/integración), Playwright (e2e), Spectral (lint OpenAPI), Schemathesis (contratos) |
| Docs de API en el portal | Scalar API Reference |

## Estructura del repo

```
rid-portal/
├── CLAUDE.md
├── README.md
├── apps/
│   ├── web/                 # Next.js: portal de desarrolladores + consolas
│   └── api/                 # NestJS: API del portal, reconciliadores, bundle OPA
├── packages/
│   ├── contracts/           # esquemas zod + tipos compartidos + códigos de error
│   ├── policy/              # políticas Rego de OPA + tests (opa test)
│   └── config/              # carga y validación de config/country/*.yaml
├── config/
│   └── country/
│       ├── co.yaml          # Colombia (primer despliegue)
│       └── example.yaml     # plantilla para otros países
├── infra/
│   ├── compose/             # docker-compose.yml + overrides
│   ├── keycloak/            # realm-export.json para dev
│   ├── apisix/              # config.yaml de APISIX
│   ├── opa/                 # config de OPA (apunta al bundle del portal)
│   ├── step-ca/             # init de la CA de dev
│   ├── fluent-bit/          # pipeline de logs con enmascarado
│   └── mock-providers/      # servicios de ejemplo (Fastify + datos sintéticos, ADR-0009)
├── scripts/                 # seed, license-check, demo
└── docs/
    ├── SPEC.md
    ├── ARCHITECTURE.md
    ├── BACKLOG.md
    ├── DEMO.md
    └── adr/
```

Dentro de `apps/api/src`, un módulo NestJS por contexto de dominio: `entities`, `memberships`, `apis`, `applications`, `subscriptions`, `credentials`, `nodes`, `audit`, `notifications`, `reconcilers` (apisix, keycloak, opa-bundle), `analytics`, `admin`.

## Comandos

```bash
pnpm install
pnpm infra:up            # levanta Postgres, Keycloak, APISIX, etcd, OPA, step-ca, OpenSearch, Fluent Bit, Mailpit, mock-providers
pnpm db:migrate          # prisma migrate dev
pnpm db:seed             # entidades, usuarios y APIs de ejemplo
pnpm dev                 # web (3000) + api (4000)
pnpm test                # unit + integración
pnpm test:e2e            # Playwright contra el stack completo
pnpm test:policy         # opa test packages/policy
pnpm lint && pnpm typecheck
pnpm license:check       # falla si hay una licencia no permitida
pnpm demo                # ejecuta el guion de docs/DEMO.md de forma automatizada
```

Puertos de desarrollo: web 3000, api 4000, Keycloak 8080, APISIX proxy 9080/9443, APISIX admin 9180, OPA 8181, step-ca 9000, OpenSearch 9200, Mailpit 8025, Postgres 5432.

## Cómo trabajar

1. Abre `docs/BACKLOG.md`, toma la **siguiente historia no completada del hito actual**. No saltes de hito sin que el anterior esté cerrado.
2. Antes de codificar, relee la sección de `SPEC.md` y `ARCHITECTURE.md` que aplica. Si algo es ambiguo, propón la interpretación en el PR/commit y anótala en la historia.
3. Escribe primero los tests de los criterios de aceptación (incluidos los de autorización).
4. Implementa en cortes verticales: migración → servicio → endpoint → UI → e2e.
5. Si tomas una decisión de arquitectura que no está en un ADR, crea `docs/adr/NNNN-titulo.md` (formato en `docs/adr/0000-template.md`).
6. Marca la historia como completada en `BACKLOG.md` (`[x]`) en el mismo commit.
7. Commits pequeños, en inglés, formato Conventional Commits (`feat(subscriptions): ...`).

Las historias marcadas **SPIKE** son investigaciones con tiempo acotado: el entregable es un ADR o una nota en `docs/spikes/` con la conclusión y, si aplica, un prototipo mínimo.

## Definición de terminado (cada historia)

- Criterios de aceptación cubiertos por tests que pasan.
- Tests de autorización: el rol correcto puede, los demás reciben 403, otra entidad recibe 404.
- Eventos de auditoría emitidos y verificados en tests.
- Textos en i18n (es y en).
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm license:check` en verde.
- Pantallas nuevas pasan la verificación de accesibilidad automatizada (axe en Playwright).
- Documentación actualizada si cambió un flujo, un estado o una integración.

## Convenciones

- **API del portal:** REST bajo `/api/v1`, recursos en plural, IDs como UUIDv7, paginación por cursor (`?cursor=&limit=`), errores RFC 9457 con `type` = `https://rid.example/errors/<codigo>` y códigos definidos en `packages/contracts/src/errors.ts`.
- **Estados de dominio:** enums en Prisma + máquinas de estado explícitas en `domain/<contexto>/state-machine.ts`. Una transición inválida lanza `InvalidTransitionError` (409).
- **Fechas:** almacenar en UTC, mostrar en la zona del país (`config.country.timezone`).
- **IDs externos deterministas** para recursos en APISIX/Keycloak: `rid-<tipo>-<uuid>` para poder reconciliar sin estado extra.
- **Multi-entidad:** todo query de dominio filtra por `entityId` a través de un helper (`scopedRepo`), nunca a mano.
- **Feature flags:** en `config/country/*.yaml` bajo `features:` (por ejemplo `mtls.required`, `approval.regulatorForSensitive`).

## Cosas que NO hacer

- No guardar cuerpos de petición/respuesta, ni siquiera en modo debug.
- No llamar a la Admin API de APISIX ni a la Admin API de Keycloak desde un controlador; siempre encolar un trabajo de reconciliación.
- No agregar Redis, Kafka, MinIO, Vault, HashiCorp Packer ni ninguna dependencia con licencia no OSI (ver ADR-0002).
- No meter lógica de autorización de tráfico en el portal: el tráfico lo autoriza OPA en el gateway con datos que el portal publica.
- No modificar ADRs aceptados; se reemplazan con uno nuevo que los marca como "Reemplazado por".
