# Recorrido completo: de la primera cuenta a la primera consulta

> English version: [docs/guides/walkthrough.md](../../guides/walkthrough.md)

Esta guía recorre, paso a paso y en orden, todo lo que hacen las personas reales para que una entidad publique una API en la red y otra la consulte: crear las cuentas, dar de alta las entidades, instalar el nodo, publicar, aprobar, pedir acceso y hacer la primera consulta. Sale de un ensayo completo hecho a mano sobre una red de prueba, con cuentas creadas desde cero (2026-11-18).

Usa estos valores de ejemplo; cámbialos por los tuyos:

| Qué | Ejemplo |
| :-- | :-- |
| Portal | `https://portal.example.org` |
| Gateway (nombre propio para mTLS) | `https://gateway.example.org` |
| Entidad proveedora | *Civil Registry*, identificador `civil-registry`, NIT `900000100` |
| Entidad consumidora | *Ministerio de Bienestar de Wakanda*, identificador `bienestar-wakanda`, NIT `900000200` |
| API | *Certificado de afiliación*, identificador `certificados-afiliacion` |

## Quién hace qué

| Papel | Quién es | Qué hace en este recorrido |
| :-- | :-- | :-- |
| **Operador de la red** | El equipo que opera la red (por ejemplo, la agencia digital del país) | Aprueba altas de entidades y publicaciones de APIs; da los roles de plataforma |
| **Administración del servidor del portal** | Quien tiene acceso al servidor donde corre el portal | Da los roles de plataforma con un comando |
| **Administradora de la entidad** | Quien pide el alta de su entidad | Registra el nodo de la entidad y entrega el token |
| **Responsable de datos** de la entidad proveedora | Persona designada en el alta | Aprueba o rechaza cada solicitud de acceso a sus APIs |
| **Responsable técnico** de la entidad proveedora | Persona designada en el alta | Publica las APIs de la entidad |
| **Infraestructura** de la entidad proveedora | El equipo que administra sus servidores | Instala el nodo y conecta la API |
| **Desarrollo** de la entidad consumidora | Quien construye la aplicación que consulta | Crea la aplicación, su certificado y pide acceso |

Una misma persona puede tener varios papeles en su entidad (en la consumidora de este ejemplo, una sola persona es administradora, responsable de datos y responsable técnica). Lo que el portal no permite es aprobar lo que uno mismo pidió.

## Antes de empezar

- **Una app autenticadora** en el celular (Google Authenticator, Microsoft Authenticator u otra TOTP). La piden los roles críticos: los de plataforma y el responsable de datos.
- **Contraseña:** al menos 12 caracteres, distinta del usuario y del correo, sin repetir las últimas 5.
- **El correo de verificación vence a los 5 minutos.** Ten el correo abierto antes de registrarte y pulsa el enlace en cuanto llegue. En una red de prueba, los correos del portal llegan al buzón de pruebas (`/mail`), no a internet: ahí puedes usar direcciones inventadas.
- **Usa una ventana privada por persona** si haces varios papeles desde el mismo equipo, para no mezclar sesiones.

## 1. El equipo del operador

Ninguna pantalla da todavía los roles de plataforma (`platform_admin`, `platform_reviewer`, `regulator`, `auditor`): se dan desde el servidor del portal.

1. **Cada persona del operador** abre el portal, pulsa **Iniciar sesión → Registrarse**, llena usuario, correo, nombre y contraseña, **verifica el correo** y **entra una vez**. El portal le dirá que aún no tiene roles: es lo esperado. Entrar una vez es lo que la crea dentro del portal.
2. **Quien administra el servidor del portal** le da su rol:

   ```bash
   sudo ./install.sh platform-role grant <correo> platform_reviewer --reason "Equipo de revisión"
   sudo ./install.sh platform-role grant <correo> platform_admin --reason "Equipo técnico"
   sudo ./install.sh platform-role list
   ```

   Roles: `platform_admin` (equipo técnico: todo lo operativo), `platform_reviewer` (revisa y aprueba altas y APIs), `regulator` (supervisa y aprueba lo sensible), `auditor` (consulta la bitácora). El cambio queda en la bitácora de auditoría con el motivo. Para quitarlo: `revoke`. El comando no deja la red sin ningún `platform_admin`. Si tu instalación no tiene el comando, actualiza el portal a una versión que lo incluya.
3. **La persona vuelve a entrar.** Keycloak le muestra un **código QR**: lo escanea con la app autenticadora y escribe el código de 6 dígitos. Desde ahí ve la **Consola del operador**.

## 2. La entidad proveedora pide su alta

**Quién:** la persona que será administradora de la entidad.

1. Se registra como en el paso 1.1 (registro, verificación, primera entrada). Verá "Aún no tienes roles en una entidad".
2. Entra a **Alta de entidades** y crea una solicitud:

   | Campo | Ejemplo |
   | :-- | :-- |
   | Nombre legal / Nombre corto | `Civil Registry` |
   | Identificador | `civil-registry` (es el primer segmento de las rutas en el gateway: no cambia después) |
   | Tipo y número de identificación | `NIT` · `900000100` |
   | Naturaleza / Sector | `Entidad del orden nacional` · `Identidad` |
   | Correo de contacto, sitio web | Los institucionales |
   | Oficial de protección de datos | Nombre y correo |
   | Responsable de datos | Nombre y correo **exacto** de la persona |
   | Responsable técnico | Nombre y correo **exacto** de la persona |

3. Pulsa **Guardar cambios**, sube el **Documento de designación (PDF)**, máximo 10 MB, y pulsa **Enviar a revisión**. Después de enviarla ya no se puede editar, salvo que el operador pida correcciones.

**Sobre el documento:** el portal no lee su contenido; guarda el archivo y su huella SHA-256 en la bitácora. Quien lo revisa es una persona del operador: debe ser el acto o la carta que designa a los responsables, con los mismos nombres y correos del formulario, firmado por quien tiene la autoridad.

## 3. El operador aprueba el alta

**Quién:** una persona con `platform_reviewer` o `platform_admin`, que no sea quien pidió el alta.

1. **Consola del operador → Altas de entidades por revisar →** la solicitud.
2. Revisa los datos, el documento y que los correos sean institucionales.
3. **Decisión del operador:** **Aprobar el alta**, **Pedir correcciones** (el solicitante lee el comentario) o **Rechazar** (definitivo; libera el identificador).

Al aprobar, quien pidió el alta queda como **administradora** y cada responsable recibe una **invitación** por correo, que vence a los 14 días.

## 4. Los responsables aceptan su invitación

**Quién:** el responsable de datos y el responsable técnico.

1. Cada uno se registra con **exactamente** el correo que aparece en la solicitud, lo verifica y entra.
2. **Invitaciones →** la invitación de la entidad, con sus roles y su fecha de vencimiento **→ Aceptar**.
3. El **responsable de datos** configura su segundo factor (QR) la primera vez que trabaja en la entidad.

Si **Invitaciones** sale vacía: el correo de registro no es idéntico al de la solicitud, o no está verificado.

## 5. El nodo de la entidad

El nodo es el canal seguro entre el gateway de la red y la entidad: abre un túnel **hacia afuera**, sin puertos de entrada, y solo acepta al gateway. Toda entidad proveedora entra por su nodo, tenga su propia API (modo **canal**) o use las APIs instantáneas sobre su base de datos (modo **completo**).

### 5.1 Registrar el nodo (administradora de la entidad)

**Mi entidad → Nodos del kit → Registrar un nodo:** un nombre único en la entidad (por ejemplo `nodo-principal`) **→ Registrar y emitir token**. **Copia el token en ese momento:** se muestra una sola vez, sirve para un solo nodo y vence a las 72 horas. Entrégalo a quien instala.

### 5.2 Instalar el nodo (infraestructura de la entidad)

Servidor: Ubuntu Server 22.04 o 24.04, amd64 o arm64, con salida a internet por **UDP 51820** (el túnel) y **TCP 443** (el portal), y la hora sincronizada.

```bash
curl -fLO https://github.com/centre-for-dpi/data-exchange-provider/releases/download/v0.2.0/den-node-kit-0.2.0.tar.gz
curl -fLO https://github.com/centre-for-dpi/data-exchange-provider/releases/download/v0.2.0/den-node-kit-0.2.0.tar.gz.sha256
sha256sum -c den-node-kit-0.2.0.tar.gz.sha256      # debe decir: OK
tar -xzf den-node-kit-0.2.0.tar.gz && cd den-node-kit-0.2.0
sudo DEN_LANG=es ./install.sh
```

**Compara la huella** con la que publica el operador por su propio canal antes de abrir el paquete: es la garantía de que no fue alterado.

| Pregunta del instalador | Respuesta |
| :-- | :-- |
| Modo | `canal` si la entidad ya tiene su API; `completo` para APIs instantáneas sobre su base |
| Proxy corporativo | `n`, o la dirección del proxy |
| URL del portal | `https://portal.example.org` |
| Token | El de 5.1 (no se ve mientras se pega) |

El instalador revisa el sistema, instala Docker si falta y termina con **"El nodo está en línea"**. En el portal, el nodo aparece **En línea** y su token como **Usado**.

### 5.3 Conectar la API al nodo

**API propia (modo canal):**

```bash
sudo /opt/den-node/install.sh service
```

| Pregunta | Ejemplo |
| :-- | :-- |
| Tipo | `proxy` |
| Nombre del servicio | `afiliacion` |
| Ruta en el nodo | `/afiliacion` (la pedirá el portal en 6.2) |
| URL interna de la API | `http://api-afiliacion:8000` (`https://` si la API lo tiene; `http` solo dentro de la red de la entidad) |
| Credencial que exige la API interna | `none`, `header`, `basic` o `certificate`; el nodo la agrega y nunca sale de la entidad |
| OpenAPI de la API | La ruta del **mismo archivo** que se subirá al portal |

**Pasa siempre el OpenAPI**, aunque sea opcional: con él, el nodo registra qué operación se pidió (sin él, cada consulta queda como `(unknown)`), y envía al portal la huella del contrato que sirve.

**API instantánea (modo completo):** el mismo comando con tipo `instant` pide el motor, el servidor, la base, el usuario de **solo lectura**, la **vista** a publicar, la columna clave y, si la clave identifica a una persona, su tipo de documento. El instalador genera el OpenAPI en `/opt/den-node/config/services/<servicio>.openapi.json`: ese es el archivo que se sube al portal. Detalle en la guía del kit (`INSTANT-APIS.md`).

Para terminar: `sudo /opt/den-node/install.sh doctor`. Todo en ✔; el único aviso aceptable es `http` sin cifrar dentro de la red de la entidad.

## 6. El responsable técnico publica la API

### 6.1 Registrar la API

**Mis APIs → Registrar API:**

| Campo | Ejemplo |
| :-- | :-- |
| Identificador en la URL | `certificados-afiliacion` (forma la ruta pública `/civil-registry/certificados-afiliacion/v1`) |
| Nombre, resumen, descripción | Lo que verán quienes consultan, en el catálogo |
| Sector, etiquetas | Para encontrarla en el catálogo |
| Clasificación | `Pública`, `Interna`, `Datos personales` o `Datos sensibles` (las de datos sensibles necesitan además al regulador) |
| Correo del responsable | El institucional |

### 6.2 Crear la versión

**Nueva versión:**

| Campo | Ejemplo |
| :-- | :-- |
| Versión | `1.0` |
| Archivo OpenAPI | El mismo que se configuró en el nodo |
| ¿Dónde vive el servicio? | **Nodo del kit de APIs instantáneas**, también para una API propia: la opción dice "nodo" porque el gateway llega por el túnel del nodo |
| Nodo del kit / Ruta del servicio en el nodo | El nodo de 5.1 · `/afiliacion` |
| Servicio de pruebas (sandbox) | Sin sandbox, o uno con datos sintéticos |
| Finalidades permitidas | Las del catálogo del país, por ejemplo *Verificación de requisitos de un trámite* |
| Datos que expone | Cada campo de la respuesta, marcando los personales y los sensibles |
| Base legal / Referencias normativas | La norma que permite compartir los datos |

**Crear versión:** el portal revisa el contrato al subirlo. Errores comunes: un número de identificación en la consulta (`?documento=`) en vez de en la ruta, `operationId` repetidos, referencias externas, y no declarar de quién son los datos en las APIs personales (`x-den-data-subject`). La ficha de la versión muestra cada operación y dónde va el titular.

### 6.3 Enviar a revisión

**Enviar a revisión:** el portal ejecuta las **validaciones automáticas**, que llaman al servicio a través del gateway, el túnel y el nodo. Si fallan, la ficha dice cuál y por qué; corrige y pulsa **Validaciones automáticas → Repetir validaciones**.

## 7. El operador aprueba la API

**Consola del operador → Versiones en revisión →** la versión: revisa el contrato, los datos que expone, las finalidades y el resultado de las validaciones **→ Aprobar**. Con las validaciones fallidas, el portal no deja aprobar. Las APIs sensibles pasan además por el regulador. Al aprobar, la ruta queda viva en el gateway.

## 8. La entidad consumidora

### 8.1 Alta

Igual que los pasos 2 a 4. Si una sola persona tendrá todos los papeles, pone su propio correo como responsable de datos y como responsable técnico: al aprobar el alta recibe todos los roles en su cuenta, sin invitaciones que aceptar.

### 8.2 Crear la aplicación

**Mis aplicaciones → Crear aplicación:** nombre, para qué la usará la entidad, entorno, correo del contacto técnico **→ Crear aplicación**. Aparece **"Guarda el secreto ahora"** con el **Client ID** y el **Client secret**: **el secreto se muestra una sola vez.** Guárdalo en el gestor de secretos del servidor de la aplicación.

### 8.3 El certificado de la aplicación (mTLS)

La clave privada se genera **en el servidor donde correrá la aplicación** y nunca sale de ahí; al portal solo va la solicitud (CSR). Lo más fácil es el script `entity-check.sh` del repositorio del portal, que el operador entrega a las entidades:

```bash
./entity-check.sh csr <CLIENT_ID>      # crea <CLIENT_ID>.key (solo legible por su dueño) y <CLIENT_ID>.csr
cat <CLIENT_ID>.csr
```

Funciona igual en Linux, macOS y Git Bash en Windows, se niega a sobrescribir una clave existente, comprueba que el CSR nombre exactamente al Client ID y, si OpenSSL falla, dice por qué sin dejar una clave a medias.

Sin el script, el comando equivalente es:

```bash
umask 077
MSYS_NO_PATHCONV=1 openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
  -keyout <CLIENT_ID>.key -out <CLIENT_ID>.csr -subj "/CN=<CLIENT_ID>"
openssl req -in <CLIENT_ID>.csr -noout -subject      # debe mostrar: subject=CN=<CLIENT_ID>
```

`MSYS_NO_PATHCONV=1` es para **Git Bash en Windows**, que si no convierte `/CN=…` en una ruta (`C:/Program Files/Git/CN=…`): OpenSSL lo rechaza y deja la clave creada sin CSR. En Linux y macOS no hace nada. El `CN` debe ser **exactamente** el Client ID.

En la aplicación, **Certificado de cliente (mTLS)**: pega el CSR completo (de `-----BEGIN CERTIFICATE REQUEST-----` a `-----END CERTIFICATE REQUEST-----`) **→ Solicitar certificado → Descargar**. Guarda el certificado como `<CLIENT_ID>.crt` junto a la clave.

### 8.4 Pedir acceso

**Catálogo →** la API **→ Solicitar acceso:**

| Campo | Qué poner |
| :-- | :-- |
| Aplicación que hará las llamadas | La de 8.2 |
| Finalidad | Una de las que permite la API |
| Para qué usarás los datos | El trámite o programa concreto: la entidad proveedora lo revisa |
| Base legal | La norma o el convenio que habilita a tratar estos datos |
| Operaciones que necesitas | Sin marcar = todas las de lectura |
| Vigencia en meses | Hasta el máximo de la clasificación (12 para datos personales) |

**Enviar solicitud.**

## 9. La entidad proveedora decide

**Quién:** el responsable de datos de la entidad proveedora (con segundo factor).

**Solicitudes →** la solicitud: quién pide, con qué aplicación, para qué, con qué base legal y qué datos personales recibirá **→ Aprobar** (puede reducir las operaciones, la vigencia o el límite, nunca ampliarlos) o rechazar con un motivo. Al aprobar, el acuerdo queda en la bitácora y el gateway habilita el acceso en menos de un minuto.

## 10. La primera consulta

Desde el servidor de la aplicación, en la carpeta con `<CLIENT_ID>.key` y `<CLIENT_ID>.crt`:

```bash
./entity-check.sh check portal.example.org gateway.example.org        # llega a la red y guarda su raíz
./entity-check.sh call portal.example.org gateway.example.org <CLIENT_ID> \
  /civil-registry/certificados-afiliacion/v1/certificados/1000000001 eligibility_check funcionario-123
```

El script pide el secreto sin mostrarlo (o lo lee de `CLIENT_SECRET`), pide el token con el certificado, hace la consulta con la finalidad y el funcionario, y explica la respuesta. El secreto y el token nunca van en la línea de comandos.

Lo mismo con `curl`, paso a paso:

```bash
curl -fsS https://portal.example.org/api/v1/pki/ca -o red-ca.pem      # la raíz de la red
read -rs CLIENT_SECRET                                                 # pégalo: no queda en el historial
TOKEN=$(curl -fsS --cacert red-ca.pem --cert <CLIENT_ID>.crt --key <CLIENT_ID>.key \
  -u "<CLIENT_ID>:$CLIENT_SECRET" -d grant_type=client_credentials \
  https://gateway.example.org/oauth/token | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
curl -sS --cacert red-ca.pem --cert <CLIENT_ID>.crt --key <CLIENT_ID>.key \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-DEN-Purpose: eligibility_check" \
  -H "X-DEN-End-User: funcionario-123" \
  https://gateway.example.org/civil-registry/certificados-afiliacion/v1/certificados/1000000001
```

- **Cada consulta declara su finalidad** (`X-DEN-Purpose`, una de las aprobadas) y **quién la hace** dentro de la entidad (`X-DEN-End-User`; la red guarda solo un seudónimo).
- El token dura unos minutos y está ligado al certificado: se pide otro cuando vence.
- Respuestas: **200** con los datos; **403** con la cabecera `X-DEN-Deny-Reason` si falta algo (`no_subscription`: no hay acceso aprobado; `end_user_required`: falta quién consulta); **404** en formato `problem+json` si el registro no existe.

## Si algo falla

| Síntoma | Causa | Qué hacer |
| :-- | :-- | :-- |
| Venció el enlace de verificación | Dura 5 minutos | Inicia sesión con esa cuenta: la pantalla de verificación ofrece reenviarlo. O usa "¿Olvidaste tu contraseña?" |
| "El correo ya existe" al registrarse | La cuenta se creó; solo falta verificarla | Lo mismo: inicia sesión y reenvía la verificación |
| Invitaciones vacía | El correo no es idéntico al de la solicitud, o no está verificado | Registra la cuenta con el correo exacto |
| "No pudimos completar la operación" al subir el documento del alta | (Operador) el API no puede escribir en su carpeta de documentos | En el `.env` del portal, `DEN_DOCUMENTS_DIR=/var/lib/den/documents`, y recrea el contenedor del API (`docker compose ... up -d --no-build --no-deps api`) |
| No aparece un rol de plataforma | La persona no ha entrado nunca al portal | Que entre una vez y repetir `platform-role grant` |
| No se puede aprobar la API (409) | Las validaciones automáticas fallaron | Mira la ficha de la versión; corrige y **Repetir validaciones** |
| Validación con **504** (tiempo agotado) | El gateway no llega al nodo por el túnel | En el nodo: `sudo /opt/den-node/install.sh status` (el túnel debe tener un saludo reciente). Si la red del servidor cambió de dirección y el túnel no se recupera: `sudo /opt/den-node/install.sh stop` y `start` |
| `subject name is expected to be in the format /type0=value0…` | Git Bash convirtió `/CN=…` en una ruta | Usa `./entity-check.sh csr`, o borra la clave a medio crear y repite con `MSYS_NO_PATHCONV=1` |
| El portal rechaza el CSR | El `CN` no es el Client ID, o la clave no es ECDSA P-256/P-384 ni RSA 2048–4096 | Genera otro con el Client ID exacto |
| Los registros del nodo dicen `(unknown)` | El servicio no tiene su OpenAPI en el nodo | `install.sh service remove <servicio>` y agregarlo de nuevo con el OpenAPI |

## Lo que todavía falta en el producto

Encontrado en el ensayo y anotado en el backlog del portal (sección P):

- **P-01** ✔ Roles de plataforma desde el comando del servidor (falta una pantalla en la consola).
- **P-02** Aviso cuando el nodo sirve un contrato distinto del publicado.
- **P-03** El paquete del kit, su huella y los comandos en la pantalla de nodos del portal.
- **P-04** Que solo se ofrezcan los tipos de servicio que el país permite (el nodo y X-Road), con nombres claros.
- **P-05** Que la pantalla de la aplicación muestre un comando de CSR que funcione en Linux, Git Bash y PowerShell (o remita a `entity-check.sh`).
- **P-06** El `.env` del despliegue manda los documentos a una carpeta donde el API no puede escribir (el arreglo provisional está en la tabla de problemas).
- **P-07** Que el portal no deje aprobar con validaciones fallidas y explique qué hacer con cada fallo.
- **P-08** Desactivar las cuentas de demostración del piloto y alargar el enlace de verificación.
