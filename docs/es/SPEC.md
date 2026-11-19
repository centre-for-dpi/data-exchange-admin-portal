# Especificación funcional — Portal DEN

> English version (official): [docs/SPEC.md](../SPEC.md)

Versión 0.1 · noviembre 2026 · Estado: borrador para construcción

## 1. Propósito y alcance

El Portal DEN gobierna una red de intercambio de datos entre entidades públicas. Permite que una entidad publique una API, que otra la consuma con una finalidad autorizada, y que el operador y el regulador vean y controlen todo el ciclo. El tráfico pasa por un gateway central (APISIX); los datos se quedan en cada entidad y el gateway no guarda contenido.

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

| Rol | Quién (típicamente) | Puede |
| :-- | :-- | :-- |
| `platform_admin` | Equipo técnico del operador (la agencia digital nacional o equivalente) | Todo lo operativo: aprobar entidades, revisar y publicar APIs, gestionar nodos, suspender cualquier cosa, ver toda la analítica |
| `platform_reviewer` | Analistas del operador | Revisar publicaciones y altas de entidades; no gestiona infraestructura |
| `regulator` | La autoridad que gobierna la red (por ejemplo, el ministerio a cargo del gobierno digital) | Ver todo en solo lectura; aprobar publicaciones y suscripciones cuando la política lo exige (datos sensibles); ver indicadores; exportar auditoría |
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

Puede ver la página pública del catálogo **solo** si `features.publicCatalog: true` en la configuración del país, y solo APIs con clasificación `public`. No ve el contacto del responsable de la API (puede ser el correo de una persona) ni el estado de los nodos de la entidad (M6-08).

### 2.4 Titular de los datos (ciudadano)

No usa el portal. Ve **quién consultó sus datos**, cuándo, qué dato, para qué y con qué funcionario (como referencia), desde la app ciudadana del país (en Colombia, la Carpeta Ciudadana Digital), autenticado con la identidad digital nacional. También activa avisos y descarga un comprobante verificable de cada consulta. En esta versión solo ve las consultas que pasan por el gateway (ADR-0015).

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

- `node`: servicio expuesto por un nodo del kit (`nodeId`, `servicePath`). Es el camino de las APIs instantáneas. El nodo debe ser de la entidad que publica; el gateway lo llama por su túnel y deja de hacerlo si se da de baja. El detalle de la API, para el proveedor, el revisor y el consumidor, muestra el estado del nodo.
- `xroad`: servicio consumido vía X-Road (`serviceId` con instancia/clase/miembro/subsistema/servicio, y una ruta opcional). El gateway actúa como miembro cliente, a través del Security Server del operador, que fija la configuración del despliegue y no la versión (SPIKE S-5). El miembro del servicio debe ser el miembro X-Road de la entidad, que registra el operador.
- `direct`: API pública HTTPS de la entidad, que el gateway llama sin nodo (`url`, `mtls: bool`).

El nodo es el canal por defecto (ADR-0029): el país lista en `features.upstreams` los tipos que pueden usar las versiones nuevas, `[node, xroad]` si se omite. `direct` es opcional, y `xroad` solo se ofrece donde el despliegue tiene el Security Server del operador. El API rechaza otro tipo, como upstream o como sandbox, al crear, revisar, editar o enviar una versión (400, `upstream_type_not_allowed` o `xroad_not_configured`). El formulario de versión ofrece solo los tipos permitidos y, si hay uno solo, no pregunta. Una versión que ya tiene un tipo que el país dejó de aceptar sigue funcionando; su ficha y la consola de sincronización del operador la señalan, y el operador decide.

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
- **Detalle (M2-01).** Cualquier persona con cuenta (autorregistro con correo verificado, ADR-0018) puede pedir un alta. Tiene hasta 3 solicitudes abiertas a la vez. En `requested` le toca al solicitante: corrige los datos, adjunta el documento de designación y la envía (pasa a `under_review`). Pedir correcciones o rechazar exige un comentario que el solicitante lee. El identificador y la identificación tributaria quedan reservados solo desde que la solicitud se envía. Un borrador no reserva nada, y entre borradores gana el primero que se envía. El rechazo es definitivo, pero libera ambos datos para una nueva solicitud. Así una solicitud falsa no bloquea para siempre a la entidad real.
- **Separación de funciones:** nadie decide sobre una solicitud que presentó o en la que figura como responsable designado.
- **Alta directa.** `platform_admin` registra la entidad sin solicitud cuando un acto o una decisión ya la incorporó a la red. Indica ese fundamento, que queda en la bitácora, y el administrador de la entidad. La entidad queda activa de inmediato; el administrador y los responsables reciben una invitación por correo. El operador no puede ser el administrador ni uno de los responsables.
- **Responsables designados.** El responsable de datos recibe `data_steward`. El responsable técnico recibe `api_publisher` y `app_developer`. Si el solicitante se designa a sí mismo, los roles se suman a su membresía sin invitación. Cada invitación vence a los `DEN_INVITATION_TTL_DAYS` días (14 por omisión).
4. `suspended` bloquea toda publicación nueva y suspende en el gateway todas sus suscripciones como consumidora (no como proveedora, salvo decisión explícita). Lo decide el `platform_admin` con un motivo; reactivar devuelve cada suscripción a su estado. `offboarded` es definitivo: cierra sus suscripciones de ambos lados, retira sus versiones y revoca sus membresías (M2-11).

### 4.2 Publicación de una versión de API

```
draft → in_review → approved_operator → [approved_regulator] → published
          ↘ changes_requested → draft
published → deprecated → retired
```

1. `api_publisher` crea la API y la versión: sube OpenAPI 3.x, elige el upstream entre los tipos que acepta el país (§3.1), completa campos expuestos, base legal, finalidades permitidas, SLA.
2. Validaciones automáticas al enviar a revisión (bloqueantes):
   - Lint del OpenAPI con el conjunto de reglas DEN (Spectral): `operationId` en todas las operaciones, esquemas de respuesta, sin parámetros de identificación en query si `features.lint.noIdInQuery` (se recomiendan en path o en cuerpo de POST), sin dos rutas que puedan coincidir con la misma petición sin que una sea más específica (una ruta literal junto a una con parámetro sí se acepta: gana la literal, `ARCHITECTURE.md §4.2`), descripciones en español.
   - Conectividad: el portal pide al nodo/URL un `healthcheck` a través del gateway en modo prueba (GET a la raíz del servicio; pasa con cualquier respuesta que no sea 5xx).
   - Prueba de contrato (Schemathesis) contra el sandbox, con un límite de tiempo. El sandbox es el servicio de pruebas con datos sintéticos que la versión declara; sin sandbox, la prueba se omite y no bloquea.

   Las dos corren en segundo plano al enviar a revisión, y sus resultados acompañan la revisión. El operador solo aprueba si pasaron; el proveedor puede repetirlas después de corregir su servicio. De la prueba de contrato solo se guardan, por operación, los códigos de las verificaciones que fallaron y el código HTTP, nunca un cuerpo.
3. `platform_reviewer` revisa ficha, clasificación y minimización. Si `classification ∈ {sensitive}` y `features.approval.regulatorForSensitive`, pasa además por `regulator`. El regulador aprueba (se publica) o la devuelve al proveedor con motivo (`changes_requested`). No decide quien ya participó en la versión ni quien pertenece a la entidad proveedora.
4. Al publicar: se crea la ruta en el gateway en modo "cerrado" (sin suscripciones nadie entra) y la API aparece en el catálogo.
5. Una versión nueva mayor convive con la anterior. `deprecated` muestra aviso y fecha de retiro; `retired` elimina la ruta y revoca las suscripciones (con aviso previo configurable, por defecto 90 días).

Cambios en una versión publicada: solo se permiten cambios compatibles (descripciones, SLA, nuevas operaciones opcionales). Un cambio incompatible exige versión mayor nueva. El lint compara contra la versión publicada y bloquea incompatibilidades.

### 4.3 Aplicaciones y credenciales

1. `app_developer` crea una aplicación en su entidad (sandbox o producción).
2. El portal crea un cliente confidencial en Keycloak (`client_credentials`), muestra el secreto una sola vez.
3. Si `features.mtls.required`, el desarrollador genera la clave y un CSR en el propio servidor de la aplicación y sube el CSR; el portal muestra los comandos para Linux/macOS, Git Bash y PowerShell (P-05: la clave legible solo por su dueño, nunca sobrescrita, y una comprobación del sujeto antes de pegarlo) y ofrece `entity-check.sh` para descargar. Nunca ofrece crear la clave en el navegador, donde quedaría en el portátil de alguien. El portal firma el CSR vía step-ca con el `client_id` en el CN/SAN. Certificados de 90 días por defecto, con aviso a los 15 días.
4. Rotación: se puede crear una segunda credencial antes de revocar la primera (ventana de rotación). Al rotar el secreto o pedir un certificado nuevo, el anterior queda `rotating` y sigue funcionando `lifecycle.credentialRotationDays` (7 por defecto); después pasa a `expired`. Revocar corta la credencial de inmediato. El secreto actual no se revoca: primero se rota. Una rotación a la vez por tipo de credencial.
5. Una aplicación sin suscripciones aprobadas puede obtener token pero el gateway rechaza todas sus llamadas.

### 4.4 Suscripción (solicitud de acceso)

```
pending_provider → [pending_regulator] → approved → active
        ↘ rejected                ↘ rejected
active ⇄ suspended
active → revoked
active → expired (al pasar validUntil)
pending_* → withdrawn (el solicitante desiste)
pending_provider → info_requested → pending_provider (pregunta del responsable y respuesta)
```

1. `app_developer` de la entidad consumidora elige API y versión, aplicación, finalidad (del catálogo permitido por esa API), detalle de la finalidad, base legal, operaciones requeridas, vigencia, y adjunta el acuerdo de intercambio o referencia a un convenio vigente.
2. Se notifica a los `data_steward` de la entidad proveedora. El responsable puede aprobar (opcionalmente reduciendo operaciones, límite o vigencia), rechazar con motivo o pedir información (comentario; vuelve al solicitante).
3. Si la API es `sensitive` y la política lo exige, pasa además por `regulator`.
4. `approved → active` ocurre cuando los reconciliadores confirman que el gateway ya tiene los datos de política. El portal muestra "activándose" mientras tanto. Objetivo: menos de 60 segundos.
5. Suspender o revocar (proveedor, operador o regulador) se refleja en el gateway en menos de 60 segundos.
6. Renovación: 30 días antes de `validUntil` se notifica al consumidor; la renovación es una nueva solicitud prellenada.

**Reglas**
- Una aplicación tiene como máximo una suscripción activa por versión de API y finalidad.
- Sandbox (M4-08): las suscripciones de aplicaciones sandbox se aprueban automáticamente si `features.sandbox.autoApprove` y solo apuntan al upstream de pruebas. Una aplicación sandbox solo puede pedir acceso a versiones que declaran un sandbox, y llama a `/sandbox{basePath}`. El gateway nunca la deja llegar al servicio real, ni a una aplicación de producción llegar al sandbox (`environment_mismatch`). La aprobación automática la decide el sistema y queda en la bitácora.
- Separación de funciones: quien solicita no puede aprobar, aunque tenga ambos roles en entidades distintas. No aplica a revocar ni a suspender: esas acciones solo quitan acceso, y un responsable de datos debe poder cortar el acceso de una aplicación propia comprometida.

### 4.5 Llamada a una API (lo que el portal hace posible)

El sistema consumidor obtiene un token de Keycloak con sus credenciales y llama al gateway con:
- `Authorization: Bearer <token>`
- `X-DEN-Purpose: <código de finalidad>` (obligatorio)
- `X-DEN-End-User: <identificador del funcionario>`: obligatorio en APIs con datos personales o sensibles. Es un identificador de 1 a 128 caracteres visibles, sin espacios, como el usuario o el correo institucional. Solo se registra como hash con la sal del despliegue.
- `X-Request-Id` (opcional; si no viene el gateway lo genera)

El gateway permite la llamada solo si existe una suscripción `active` para ese cliente, esa versión, esa operación y esa finalidad. El proveedor recibe cabeceras de trazabilidad (ver `ARCHITECTURE.md §6`).

### 4.6 Nodos del kit

```
enrollment_issued → enrolled → online ⇄ offline
                                 ↘ decommissioned
```

1. `platform_admin` o `entity_admin` registra el nodo (nombre único en la entidad) y recibe un token de enrolamiento de un solo uso (válido 72 h), que se muestra una sola vez. Se usa en el bootcamp. Mientras el nodo no se enrola, se puede anular el token o emitir otro, que anula el vigente: un nodo tiene a lo sumo un token usable. El portal guarda solo el hash del token.
2. El kit, al instalarse, llama a `POST /api/v1/nodes/enroll` con el token, su CSR y su clave pública WireGuard. Recibe certificado, configuración del túnel y el ID del nodo. El token deja de servir.
3. El nodo envía heartbeat cada 60 s con versión y servicios expuestos. Sin heartbeat por 5 min → `offline` y alerta a los administradores de la entidad y al operador. El siguiente heartbeat lo devuelve a `online`.
4. El nodo renueva su certificado antes de que venza. `entity_admin` o `platform_admin` pueden dar de baja un nodo (`decommissioned`): deja de funcionar para siempre.
5. Las APIs con upstream `node` muestran el estado del nodo.
6. **Contrato que sirve el nodo (P-02).** Para cada versión publicada (u obsoleta) en un nodo, el portal compara el SHA-256 que el nodo informa en su heartbeat para el servicio en el `servicePath` de la versión con el `openapiSha256` de la versión publicada: **coincide**, **distinto** (con ambos hashes y desde cuándo) o **sin informar** (no hay servicio en esa ruta, o el servicio no tiene OpenAPI en el nodo, cuyos registros muestran entonces rutas `(unknown)`). Se muestra en la ficha de la versión (proveedor y revisor), en la página de nodos de la entidad y en la consola de sincronización del operador. El paso de coincide a distinto avisa a los `api_publisher` y `entity_admin` de la entidad; todo cambio de estado se audita. Nunca bloquea el tráfico: el gateway sigue enrutando con el contrato publicado.
7. **El kit para instalar (P-03).** El kit se publica en su propio repositorio (ADR-0011). El operador (`platform_admin`) define la versión vigente en la consola: versión, enlace al paquete (https), tamaño, SHA-256 y, cuando los releases se firmen, el enlace a la firma y el `allowed_signers` del operador. Cada cambio queda auditado; una versión anterior puede volver a ser la vigente. Todo miembro de la entidad la ve en _Mi entidad → Nodos del kit_, junto a "Registrar un nodo", y cualquiera en el sitio público (`/kit`), con los comandos para descargarla, verificarla e instalarla en el servidor de la entidad y la URL del propio portal para responder al instalador. Opcionalmente el operador sube el paquete y el portal lo sirve en `/kit/<versión>/` sin sesión (no contiene nada secreto: enrolarse exige el token); la subida solo se acepta con el tamaño y el SHA-256 declarados y después no cambia. La página dice que su suma de verificación es una comodidad, no una garantía: quien controla el portal controla tanto el archivo como su suma; la garantía es la firma del operador, verificada con una clave entregada por otro canal.

**Preparación del bootcamp (M4-07).** Antes del bootcamp, cada entidad confirma cinco requisitos: un servidor para el nodo, un usuario de solo lectura de la base de datos, salida a internet por 443, los responsables designados (se calcula: miembros con `api_publisher` y `data_steward`) y el caso de uso. Los marca el `entity_admin` (o el operador) y el operador ve el avance de todas las entidades.

### 4.7 Transparencia para el titular (ADR-0015, ADR-0016)

1. Al publicar una versión de una API `personal` o `sensitive`, cada operación declara dónde está el titular (`x-den-data-subject`) o que no tiene titular (`none`).
2. El número de documento viaja en la forma canónica de su tipo, que define la configuración del país (`identifiers.personNumberFormat`: por ejemplo, dígitos sin ceros a la izquierda ni puntos). El gateway niega cualquier otra escritura (`data_subject_invalid`), así que la persona que registra es la que busca el proveedor, y el proveedor debe buscarla por ese valor exacto (ADR-0030).
3. En cada llamada autorizada, el gateway calcula un seudónimo del titular y registra la consulta: entidad y aplicación que consultaron, entidad proveedora, API y datos expuestos, operación, finalidad, funcionario (hash), fecha y resultado. Nunca registra el contenido ni el número de documento.
4. Las consultas se agrupan en lotes sellados (firma del operador y sello de tiempo de una TSA independiente). Cada consulta tiene un comprobante que cualquiera puede verificar.
5. El ciudadano ve sus consultas en la app ciudadana del país. El portal solo responde a esa app con el token del ciudadano, y le avisa de consultas nuevas si el ciudadano lo pidió.

## 5. Reglas de negocio transversales

- **Minimización:** el revisor ve los `exposedFields` y debe confirmar que corresponden a las finalidades permitidas. El catálogo muestra qué datos personales expone cada API.
- **Clasificación:** `public` (datos abiertos), `internal` (no personal, uso interno), `personal` (datos personales), `sensitive` (categorías especiales: salud, etc.). La clasificación decide aprobaciones adicionales, vigencia máxima y si se exige `X-DEN-End-User`.
- **Vigencia máxima de suscripción** por clasificación, configurable (por defecto: public 24 m, internal 24 m, personal 12 m, sensitive 6 m).
- **Nada se borra** en el dominio: las entidades, APIs y suscripciones cambian de estado. La única eliminación física es de documentos adjuntos por orden legal, y se registra en auditoría.

## 6. Pantallas

**Portal (todas las entidades)**
- Inicio: buscador del catálogo, accesos rápidos según rol, pendientes (bandeja).
- Catálogo: filtros por sector, entidad, clasificación, estado; tarjetas con datos personales expuestos.
- Detalle de API: descripción, ficha del servicio, documentación interactiva (Scalar) con "probar en sandbox", versiones, finalidades permitidas, estado del nodo, botón "Solicitar acceso".
- Mi entidad: datos, miembros e invitaciones, nodos (con el kit para instalar, P-03), acuerdos.
- El kit del nodo (público, `/kit`): versión vigente, suma de verificación y cómo instalarlo (P-03).
- Mis APIs (proveedor): lista, crear/editar versión, envío a revisión, solicitudes recibidas, consumidores activos, uso.
- Mis aplicaciones (consumidor): credenciales, certificados, suscripciones y su estado, uso, guía de integración (programas en curl, Python, Node.js, Java y C#).
- Bandeja de solicitudes (responsable de datos): pendientes, historial, acciones de aprobar/rechazar/suspender/revocar.

**Consola del operador**
- Altas de entidades, revisiones de API, nodos (estado, versión, último heartbeat), estado de sincronización del gateway (último reconcile, diferencias), suscripciones globales, finalidades, la versión vigente del kit del nodo y su espejo (P-03), configuración.

**Vista del regulador**
- Indicadores de la red (§8), aprobaciones pendientes que le corresponden, mapa de intercambios (qué entidad consume de cuál), auditoría y exportación.

**Auditoría** (regulador, auditor, operador; cada entidad ve lo suyo)
- Línea de tiempo filtrable, verificación de integridad de la cadena, exportación CSV/JSON firmada.

## 7. Notificaciones

En el portal y por correo. Eventos mínimos: invitación a entidad, alta aprobada/rechazada, API enviada a revisión / cambios solicitados / publicada, nueva solicitud de acceso, solicitud aprobada/rechazada/con preguntas, suscripción suspendida/revocada/por vencer, certificado por vencer, certificado revocado por el operador (revocación masiva, M6-07), nodo offline, nodo que sirve para una versión un contrato distinto del publicado (P-02), versión de API en deprecación. Cada usuario elige qué recibe por correo (los de seguridad no se pueden desactivar).

## 8. Indicadores (vienen de la propuesta de la red)

| Indicador | Cálculo |
| :-- | :-- |
| Tiempo a la primera API en uso | Días entre el alta de la entidad (o enrolamiento del nodo) y la primera llamada exitosa de un consumidor de producción |
| Entidades conectadas por mes | Entidades con al menos una API publicada, por mes de publicación |
| APIs con consumo real | APIs publicadas con ≥ 1 llamada exitosa de producción en el mes |
| Consultas exitosas | % de respuestas 2xx sobre el total (excluye 401/403 de autorización, que se reportan aparte) |
| Disponibilidad del gateway | % de tiempo con health OK (Prometheus) |
| Tiempo de aprobación | Mediana de horas entre solicitud y decisión del proveedor |
| Pasos manuales evitados | Campo manual por caso de uso: se captura con el caso de uso del bootcamp de la entidad (M4-07) |

## 9. Puntos de extensión previstos

- **Consentimiento:** el modelo de suscripción admite `consentRequired: bool`. Cuando se active, OPA consultará un servicio de consentimiento antes de permitir. No se implementa en el MVP; la interfaz de política ya recibe la cabecera `X-DEN-Consent-Ref` si viene.
- **Instancias territoriales** (p. ej. una ciudad capital): una instancia del gateway con su propio subconjunto de rutas, gobernada desde el mismo portal (`Gateway` como entidad de primer nivel en una versión futura).
- **Credenciales verificables:** una entidad proveedora podrá marcar una API como "fuente de emisión" para un emisor de credenciales; fuera del MVP.

## 10. Configuración por país (ejemplo abreviado: `co.yaml`)

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
  personNumberFormat: { CC: '^[1-9][0-9]{2,9}$', PA: '^[A-Z0-9]{3,20}$' }  # forma canónica de cada número (ADR-0030)
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
  upstreams: [node, xroad]   # ADR-0029: direct es opcional
subscriptionMaxValidityMonths: { public: 24, internal: 24, personal: 12, sensitive: 6 }
branding: { productName: "Red de Intercambio de Datos", logo: "./branding/co/logo.svg", primaryColor: "#6564DB" }
```

## 11. Requisitos no funcionales

- **Disponibilidad:** el portal puede caer sin afectar el tráfico; el gateway sigue operando con la última configuración y el último bundle de OPA.
- **Latencia agregada por el gateway:** p95 < 50 ms (sin contar el upstream) con OPA local.
- **Propagación:** aprobación o revocación reflejada en el gateway en < 60 s.
- **Escala inicial:** 200 entidades, 1.000 APIs, 5.000 suscripciones, 500 peticiones/s sostenidas en el gateway.
- **Seguridad:** OWASP ASVS L2; MFA obligatorio para roles de plataforma y `data_steward` (Keycloak pide el código; el API lo exige en cada petición, ADR-0021).
- **Privacidad:** sin cuerpos en logs; identificadores en rutas enmascarados; `X-DEN-End-User` guardado como hash con sal por despliegue.
- **Retención:** bitácora de auditoría 5 años (configurable); logs de acceso 1 año (configurable).
- **Accesibilidad:** WCAG 2.1 AA.
- **Idiomas:** español (por defecto) e inglés.
- **Despliegue:** Docker Compose para desarrollo y pilotos; Helm/Kubernetes para producción (hito M6).
