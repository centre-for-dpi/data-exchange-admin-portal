# Especificación funcional — Portal RID

Versión 0.1 · noviembre 2026 · Estado: borrador para construcción

## 1. Propósito y alcance

El Portal RID gobierna una red de intercambio de datos entre entidades públicas. Permite que una entidad publique una API, que otra la consuma con una finalidad autorizada, y que el operador y el regulador vean y controlen todo el ciclo. El tráfico pasa por un gateway central (APISIX); los datos se quedan en cada entidad y el gateway no guarda contenido.

**Dentro del alcance del MVP**

- Registro y gobierno de entidades, usuarios y roles.
- Registro, revisión, publicación, versionado y retiro de APIs.
- Catálogo con documentación interactiva.
- Aplicaciones consumidoras con credenciales OAuth2 y certificados mTLS.
- Solicitudes de acceso con finalidad, base legal y acuerdo; aprobación por el dueño del dato.
- Propagación automática al gateway (rutas, políticas, límites) y revocación casi inmediata.
- Bitácora de auditoría encadenada, analítica de uso por entidad e indicadores de la red.
- Registro de nodos del kit de incorporación (contrato con el kit; el kit en sí es otro proyecto).
- Configuración por país.

**Fuera del alcance del MVP**

- La hoja de vida del ciudadano (se construirá sobre las APIs ya en uso).
- Consentimiento ciudadano en línea (se diseña el punto de extensión, ver §9).
- Credenciales verificables.
- Facturación o cobro entre entidades.
- El kit de APIs instantáneas y su instalador (proyecto hermano; aquí solo se define su contrato con el portal).

## 2. Actores y roles

### 2.1 Roles de plataforma (no pertenecen a una entidad)

| Rol | Quién (Colombia) | Puede |
| :-- | :-- | :-- |
| `platform_admin` | Equipo técnico del operador (AND) | Todo lo operativo: aprobar entidades, revisar y publicar APIs, gestionar nodos, suspender cualquier cosa, ver toda la analítica |
| `platform_reviewer` | Analistas del operador | Revisar publicaciones y altas de entidades; no gestiona infraestructura |
| `regulator` | MinTIC | Ver todo en solo lectura; aprobar publicaciones y suscripciones cuando la política lo exige (datos sensibles); ver indicadores; exportar auditoría |
| `auditor` | Órganos de control, auditor externo | Solo lectura de auditoría y analítica; sin acceso a configuración |

### 2.2 Roles dentro de una entidad

| Rol | Puede |
| :-- | :-- |
| `entity_admin` | Gestionar miembros y roles de su entidad, datos de la entidad, aceptar acuerdos marco |
| `api_publisher` | Registrar APIs y versiones de su entidad, enviarlas a revisión |
| `data_steward` (responsable de datos) | Aprobar, rechazar, suspender y revocar suscripciones a las APIs de su entidad; definir finalidades permitidas |
| `app_developer` | Crear aplicaciones de su entidad, gestionar credenciales, solicitar acceso a APIs |
| `entity_viewer` | Ver todo lo de su entidad en solo lectura |

Un usuario puede pertenecer a varias entidades con roles distintos. Un mismo usuario no puede aprobar una suscripción que él mismo solicitó (separación de funciones).

### 2.3 Usuario anónimo

Puede ver la página pública del catálogo **solo** si `features.publicCatalog: true` en la configuración del país, y solo APIs con clasificación `public`.

### 2.4 Titular de los datos (ciudadano)

No usa el portal. Ve **quién consultó sus datos**, cuándo, qué dato, para qué y con qué funcionario (como referencia), desde la Carpeta Ciudadana Digital del país, autenticado con la identidad digital nacional. También activa avisos y descarga un comprobante verificable de cada consulta. En esta versión solo ve las consultas que pasan por el gateway (ADR-0015).

## 3. Modelo de dominio

Los nombres son los del código. Todos los registros tienen `id` (UUIDv7), `createdAt`, `updatedAt`, `createdBy`.

### Entity (entidad)
`legalName`, `shortName`, `slug`, `taxId` (p. ej. NIT), `kind` (`national` | `territorial` | `autonomous` | `private_authorized`), `sector` (de la config del país), `parentEntityId?`, `status` (§4.1), `contactEmail`, `website?`, `dataProtectionOfficer` (nombre, correo).

### User
`keycloakSub`, `email`, `fullName`, `idDocumentType?`, `idDocumentNumberHash?` (solo hash, nunca el número en claro), `status` (`active` | `disabled`).

### Membership
`userId`, `entityId`, `roles[]`, `status` (`invited` | `active` | `revoked`), `invitedBy`.

### Api
`entityId` (proveedora), `slug` (único por entidad), `name`, `summary`, `description` (markdown), `sector`, `tags[]`, `classification` (`public` | `internal` | `personal` | `sensitive`), `status` (derivado de sus versiones: `draft` | `published` | `deprecated` | `retired`), `ownerContact`.

### ApiVersion
`apiId`, `version` (semver mayor.menor), `status` (§4.2), `openapiSpec` (JSON almacenado + hash), `lintReport`, `upstream` (§3.1), `basePath` (calculado: `/{entitySlug}/{apiSlug}/v{major}`), `exposedFields[]` (atributos de datos con marca `personal: bool`, `sensitive: bool`), `legalBasis` (texto + referencias normativas), `allowedPurposes[]` (códigos del catálogo de finalidades), `sla` (`availabilityTarget`, `maxLatencyMs`, `supportHours`), `defaultRateLimit` (peticiones/minuto), `deprecatedAt?`, `sunsetAt?`, `serviceSheet` (la "ficha del servicio": responsable, descripción, esquema, nivel de servicio — se genera de estos campos).

### 3.1 Upstream (dónde vive el servicio)
Uno de:

- `node`: servicio expuesto por un nodo del kit (`nodeId`, `servicePath`). Es el camino de las APIs instantáneas.
- `xroad`: servicio consumido vía X-Road (`securityServerUrl`, `serviceId` con instancia/clase/miembro/subsistema/servicio). El gateway actúa como miembro cliente.
- `direct`: URL HTTPS de una API existente de la entidad (`url`, `mtls: bool`).

### Application (aplicación consumidora)
`entityId` (consumidora), `name`, `description`, `environment` (`sandbox` | `production`), `keycloakClientId` (determinista), `status` (`active` | `suspended` | `deleted`), `technicalContact`.

### Credential
`applicationId`, `kind` (`client_secret` | `mtls_certificate`), `status` (`active` | `rotating` | `revoked` | `expired`), `fingerprint` / `serial`, `notAfter`, `lastUsedAt?`. El secreto se muestra una sola vez al crearlo; nunca se almacena en claro en el portal.

### Purpose (catálogo de finalidades)
`code`, `name`, `description`, `legalReference?`. Catálogo por país en la config, ampliable por el operador. Ejemplos: `eligibility_check` (verificar requisitos de un trámite), `benefit_targeting` (focalización de programas), `identity_validation`, `statistics_anonymized`, `oversight` (control y auditoría).

### Subscription (solicitud y acceso)
`applicationId`, `apiVersionId`, `purposeCode`, `purposeDetail` (texto), `legalBasis` (texto + referencia), `agreementDocumentId?`, `requestedOperations[]` (subconjunto de `operationId` del OpenAPI; vacío = todas las de solo lectura), `requestedRateLimit?`, `validFrom`, `validUntil` (máximo según config, por defecto 12 meses), `status` (§4.4), `decisions[]` (quién decidió, cuándo, comentario), `endUserIdentificationRequired: bool`.

### Node (nodo del kit)
`entityId`, `name`, `status` (§4.6), `tunnelAddress`, `wireguardPublicKey`, `certificateSerial`, `kitVersion`, `lastHeartbeatAt`, `services[]` (lo que el nodo declara exponer).

### Document
Archivos adjuntos (acuerdos, actas). `ownerEntityId`, `kind` (`agreement` | `annex` | `other`), `sha256`, `size`, `mimeType`, `storageKey`. Solo PDF en el MVP.

### AuditEvent
`seq` (secuencial), `occurredAt`, `actor` (usuario, sistema o aplicación), `actorEntityId?`, `action` (p. ej. `subscription.approved`), `targetType`, `targetId`, `before?`, `after?` (solo campos de dominio, nunca secretos), `ip?`, `prevHash`, `hash`. Inmutable.

### Notification
`userId`, `kind`, `payload`, `readAt?`, `emailSentAt?`.

## 4. Flujos y estados

### 4.1 Alta de entidad

```
requested → under_review → active
                ↘ rejected
active ⇄ suspended
active → offboarded
```

1. Un funcionario inicia la solicitud de alta (o el operador la crea directamente): datos de la entidad, responsable de datos, responsable técnico, documento de designación (PDF).
2. `platform_reviewer` revisa; puede pedir correcciones (vuelve a `requested` con comentario) o aprobar.
3. Al aprobar: la entidad pasa a `active`, el solicitante queda como `entity_admin` y se envían invitaciones a los responsables designados.
4. `suspended` bloquea toda publicación nueva y suspende en el gateway todas sus suscripciones como consumidora (no como proveedora, salvo decisión explícita).

### 4.2 Publicación de una versión de API

```
draft → in_review → approved_operator → [approved_regulator] → published
          ↘ changes_requested → draft
published → deprecated → retired
```

1. `api_publisher` crea la API y la versión: sube OpenAPI 3.x, elige upstream, completa campos expuestos, base legal, finalidades permitidas, SLA.
2. Validaciones automáticas al enviar a revisión (bloqueantes):
   - Lint del OpenAPI con el conjunto de reglas RID (Spectral): `operationId` en todas las operaciones, esquemas de respuesta, sin parámetros de identificación en query si `features.lint.noIdInQuery` (se recomiendan en path o en cuerpo de POST), descripciones en español.
   - Conectividad: el portal pide al nodo/URL un `healthcheck` a través del gateway en modo prueba.
   - Prueba de contrato (Schemathesis) contra el sandbox, con un límite de tiempo.
3. `platform_reviewer` revisa ficha, clasificación y minimización. Si `classification ∈ {sensitive}` y `features.approval.regulatorForSensitive`, pasa además por `regulator`.
4. Al publicar: se crea la ruta en el gateway en modo "cerrado" (sin suscripciones nadie entra) y la API aparece en el catálogo.
5. Una versión nueva mayor convive con la anterior. `deprecated` muestra aviso y fecha de retiro; `retired` elimina la ruta y revoca las suscripciones (con aviso previo configurable, por defecto 90 días).

Cambios en una versión publicada: solo se permiten cambios compatibles (descripciones, SLA, nuevas operaciones opcionales). Un cambio incompatible exige versión mayor nueva. El lint compara contra la versión publicada y bloquea incompatibilidades.

### 4.3 Aplicaciones y credenciales

1. `app_developer` crea una aplicación en su entidad (sandbox o producción).
2. El portal crea un cliente confidencial en Keycloak (`client_credentials`), muestra el secreto una sola vez.
3. Si `features.mtls.required`, el desarrollador genera un CSR (el portal ofrece instrucciones y un comando) y lo sube; el portal lo firma vía step-ca con el `client_id` en el CN/SAN. Certificados de 90 días por defecto, con aviso a los 15 días.
4. Rotación: se puede crear una segunda credencial antes de revocar la primera (ventana de rotación).
5. Una aplicación sin suscripciones aprobadas puede obtener token pero el gateway rechaza todas sus llamadas.

### 4.4 Suscripción (solicitud de acceso)

```
pending_provider → [pending_regulator] → approved → active
        ↘ rejected                ↘ rejected
active ⇄ suspended
active → revoked
active → expired (al pasar validUntil)
pending_* → withdrawn (el solicitante desiste)
```

1. `app_developer` de la entidad consumidora elige API y versión, aplicación, finalidad (del catálogo permitido por esa API), detalle de la finalidad, base legal, operaciones requeridas, vigencia, y adjunta el acuerdo de intercambio o referencia a un convenio vigente.
2. Se notifica a los `data_steward` de la entidad proveedora. El responsable puede aprobar (opcionalmente reduciendo operaciones, límite o vigencia), rechazar con motivo o pedir información (comentario; vuelve al solicitante).
3. Si la API es `sensitive` y la política lo exige, pasa además por `regulator`.
4. `approved → active` ocurre cuando los reconciliadores confirman que el gateway ya tiene los datos de política. El portal muestra "activándose" mientras tanto. Objetivo: menos de 60 segundos.
5. Suspender o revocar (proveedor, operador o regulador) se refleja en el gateway en menos de 60 segundos.
6. Renovación: 30 días antes de `validUntil` se notifica al consumidor; la renovación es una nueva solicitud prellenada.

**Reglas**
- Una aplicación tiene como máximo una suscripción activa por versión de API y finalidad.
- Sandbox: las suscripciones de aplicaciones sandbox se aprueban automáticamente si `features.sandbox.autoApprove` y solo apuntan al upstream de pruebas.
- Separación de funciones: quien solicita no puede aprobar, aunque tenga ambos roles en entidades distintas. No aplica a revocar ni a suspender: esas acciones solo quitan acceso, y un responsable de datos debe poder cortar el acceso de una aplicación propia comprometida.

### 4.5 Llamada a una API (lo que el portal hace posible)

El sistema consumidor obtiene un token de Keycloak con sus credenciales y llama al gateway con:
- `Authorization: Bearer <token>`
- `X-RID-Purpose: <código de finalidad>` (obligatorio)
- `X-RID-End-User: <identificador del funcionario>` (obligatorio si la suscripción lo exige; se registra con hash)
- `X-Request-Id` (opcional; si no viene el gateway lo genera)

El gateway permite la llamada solo si existe una suscripción `active` para ese cliente, esa versión, esa operación y esa finalidad. El proveedor recibe cabeceras de trazabilidad (ver `ARCHITECTURE.md §6`).

### 4.6 Nodos del kit

```
enrollment_issued → enrolled → online ⇄ offline
                                 ↘ decommissioned
```

1. `platform_admin` o `entity_admin` emite un token de enrolamiento de un solo uso (válido 72 h) para un nodo de la entidad. Se usa en el bootcamp.
2. El kit, al instalarse, llama a `POST /api/v1/nodes/enroll` con el token, su CSR y su clave pública WireGuard. Recibe certificado, configuración del túnel y el ID del nodo.
3. El nodo envía heartbeat cada 60 s con versión y servicios expuestos. Sin heartbeat por 5 min → `offline` y alerta.
4. Las APIs con upstream `node` muestran el estado del nodo.

### 4.7 Transparencia para el titular (ADR-0015, ADR-0016)

1. Al publicar una versión de una API `personal` o `sensitive`, cada operación declara dónde está el titular (`x-rid-data-subject`) o que no tiene titular (`none`).
2. En cada llamada autorizada, el gateway calcula un seudónimo del titular y registra la consulta: entidad y aplicación que consultaron, entidad proveedora, API y datos expuestos, operación, finalidad, funcionario (hash), fecha y resultado. Nunca registra el contenido ni el número de documento.
3. Las consultas se agrupan en lotes sellados (firma del operador y sello de tiempo de una TSA independiente). Cada consulta tiene un comprobante que cualquiera puede verificar.
4. El ciudadano ve sus consultas en la Carpeta Ciudadana Digital. El portal solo responde a la Carpeta con el token del ciudadano, y le avisa de consultas nuevas si el ciudadano lo pidió.

## 5. Reglas de negocio transversales

- **Minimización:** el revisor ve los `exposedFields` y debe confirmar que corresponden a las finalidades permitidas. El catálogo muestra qué datos personales expone cada API.
- **Clasificación:** `public` (datos abiertos), `internal` (no personal, uso interno), `personal` (datos personales), `sensitive` (categorías especiales: salud, etc.). La clasificación decide aprobaciones adicionales, vigencia máxima y si se exige `X-RID-End-User`.
- **Vigencia máxima de suscripción** por clasificación, configurable (por defecto: public 24 m, internal 24 m, personal 12 m, sensitive 6 m).
- **Nada se borra** en el dominio: las entidades, APIs y suscripciones cambian de estado. La única eliminación física es de documentos adjuntos por orden legal, y se registra en auditoría.

## 6. Pantallas

**Portal (todas las entidades)**
- Inicio: buscador del catálogo, accesos rápidos según rol, pendientes (bandeja).
- Catálogo: filtros por sector, entidad, clasificación, estado; tarjetas con datos personales expuestos.
- Detalle de API: descripción, ficha del servicio, documentación interactiva (Scalar) con "probar en sandbox", versiones, finalidades permitidas, estado del nodo, botón "Solicitar acceso".
- Mi entidad: datos, miembros e invitaciones, nodos, acuerdos.
- Mis APIs (proveedor): lista, crear/editar versión, envío a revisión, solicitudes recibidas, consumidores activos, uso.
- Mis aplicaciones (consumidor): credenciales, certificados, suscripciones y su estado, uso, guía de integración (snippets curl/Java/Python/C#).
- Bandeja de solicitudes (responsable de datos): pendientes, historial, acciones de aprobar/rechazar/suspender/revocar.

**Consola del operador**
- Altas de entidades, revisiones de API, nodos (estado, versión, último heartbeat), estado de sincronización del gateway (último reconcile, diferencias), suscripciones globales, finalidades, configuración.

**Vista del regulador**
- Indicadores de la red (§8), aprobaciones pendientes que le corresponden, mapa de intercambios (qué entidad consume de cuál), auditoría y exportación.

**Auditoría** (regulador, auditor, operador; cada entidad ve lo suyo)
- Línea de tiempo filtrable, verificación de integridad de la cadena, exportación CSV/JSON firmada.

## 7. Notificaciones

En el portal y por correo. Eventos mínimos: invitación a entidad, alta aprobada/rechazada, API enviada a revisión / cambios solicitados / publicada, nueva solicitud de acceso, solicitud aprobada/rechazada/con preguntas, suscripción suspendida/revocada/por vencer, certificado por vencer, nodo offline, versión de API en deprecación. Cada usuario elige qué recibe por correo (los de seguridad no se pueden desactivar).

## 8. Indicadores (vienen de la propuesta de la red)

| Indicador | Cálculo |
| :-- | :-- |
| Tiempo a la primera API en uso | Días entre el alta de la entidad (o enrolamiento del nodo) y la primera llamada exitosa de un consumidor de producción |
| Entidades conectadas por mes | Entidades con al menos una API publicada, por mes de publicación |
| APIs con consumo real | APIs publicadas con ≥ 1 llamada exitosa de producción en el mes |
| Consultas exitosas | % de respuestas 2xx sobre el total (excluye 401/403 de autorización, que se reportan aparte) |
| Disponibilidad del gateway | % de tiempo con health OK (Prometheus) |
| Tiempo de aprobación | Mediana de horas entre solicitud y decisión del proveedor |
| Pasos manuales evitados | Campo manual por caso de uso (se captura en la ficha del caso) |

## 9. Puntos de extensión previstos

- **Consentimiento:** el modelo de suscripción admite `consentRequired: bool`. Cuando se active, OPA consultará un servicio de consentimiento antes de permitir. No se implementa en el MVP; la interfaz de política ya recibe la cabecera `X-RID-Consent-Ref` si viene.
- **Instancias territoriales** (p. ej. Bogotá): una instancia del gateway con su propio subconjunto de rutas, gobernada desde el mismo portal (`Gateway` como entidad de primer nivel en una versión futura).
- **Credenciales verificables:** una entidad proveedora podrá marcar una API como "fuente de emisión" para un emisor de credenciales; fuera del MVP.

## 10. Configuración por país (ejemplo abreviado)

```yaml
country:
  code: CO
  name: Colombia
  locale: es-CO
  timezone: America/Bogota
authorities:
  operator: { name: "Agencia Nacional Digital", shortName: "AND" }
  regulator: { name: "Ministerio de Tecnologías de la Información y las Comunicaciones", shortName: "MinTIC" }
legal:
  dataProtectionLaw: "Ley 1581 de 2012"
  dataProtectionAuthority: "Superintendencia de Industria y Comercio"
identifiers:
  person: [CC, CE, TI, PEP, PPT, PA]
  organization: [NIT]
sectors: [identidad, vulnerabilidad, vivienda, salud, trabajo, educacion, movilidad]
purposes:
  - { code: eligibility_check, name: "Verificación de requisitos de un trámite" }
  - { code: benefit_targeting, name: "Focalización de programas sociales" }
  - { code: identity_validation, name: "Validación de identidad" }
features:
  publicCatalog: false
  mtls: { required: true }
  sandbox: { autoApprove: true }
  approval: { regulatorForSensitive: true }
  lint: { noIdInQuery: true }
subscriptionMaxValidityMonths: { public: 24, internal: 24, personal: 12, sensitive: 6 }
branding: { productName: "Red de Intercambio de Datos", logo: "./branding/co/logo.svg", primaryColor: "#6564DB" }
```

## 11. Requisitos no funcionales

- **Disponibilidad:** el portal puede caer sin afectar el tráfico; el gateway sigue operando con la última configuración y el último bundle de OPA.
- **Latencia agregada por el gateway:** p95 < 50 ms (sin contar el upstream) con OPA local.
- **Propagación:** aprobación o revocación reflejada en el gateway en < 60 s.
- **Escala inicial:** 200 entidades, 1.000 APIs, 5.000 suscripciones, 500 peticiones/s sostenidas en el gateway.
- **Seguridad:** OWASP ASVS L2; MFA obligatorio para roles de plataforma y `data_steward` (configurado en Keycloak).
- **Privacidad:** sin cuerpos en logs; identificadores en rutas enmascarados; `X-RID-End-User` guardado como hash con sal por despliegue.
- **Retención:** bitácora de auditoría 5 años (configurable); logs de acceso 1 año (configurable).
- **Accesibilidad:** WCAG 2.1 AA.
- **Idiomas:** español (por defecto) e inglés.
- **Despliegue:** Docker Compose para desarrollo y pilotos; Helm/Kubernetes para producción (hito M6).
