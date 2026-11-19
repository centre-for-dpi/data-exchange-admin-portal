# Guía para entidades participantes

> English version (official): [docs/guides/entities.md](../../guides/entities.md)

Versión 1.2 · noviembre 2026 · para la jornada de incorporación (bootcamp) con las entidades

Esta guía explica qué tiene que **designar, disponer y hacer** cada entidad para conectarse a la red de intercambio de datos DEN (Data Exchange Network), como **proveedora** de datos, como **consumidora** o como ambas. La plataforma central (portal y gateway) la opera el operador nacional: la entidad no instala nada de eso.

**Las proveedoras tienen su propia guía,** en el repositorio del kit (`docs/es/guides/providers.md`, con su versión para proyectar `providers.html`): cómo se conecta el servicio por el nodo, qué servidor y qué red necesita, cómo se instala el nodo, cómo se publica una API y qué recibe el servicio en cada consulta. Aquí queda lo común a todas las entidades y lo de las consumidoras.

## 1. Qué significa para una entidad

- **Como proveedora**, publica una API sobre sus datos. Decide, por medio de su **responsable de datos**, quién accede, para qué finalidad, a qué operaciones y por cuánto tiempo. Sabe en cada consulta quién la hizo y para qué. Los datos nunca se copian a la plataforma.
- **Como consumidora**, encuentra APIs en el catálogo, crea una aplicación con sus credenciales y pide acceso declarando una **finalidad**. Cuando el proveedor aprueba, sus sistemas consultan a través del gateway.
- **El ciudadano** ve qué entidad consultó sus datos y para qué. Cada consulta debe responder a una finalidad legítima y declarada.

## 2. Personas que la entidad debe designar

| Rol en el portal | Quién suele ser | Qué hace | Segundo factor |
| :-- | :-- | :-- | :-- |
| `entity_admin` | Jefe de TI o de la oficina de datos | Pide el alta de la entidad, invita a su gente y asigna roles, gestiona los nodos del kit | — |
| `data_steward` (responsable de datos) | Quien responde por los datos (designación formal) | Aprueba, rechaza, suspende y revoca accesos a las APIs de la entidad | **Obligatorio** |
| `api_publisher` | Responsable técnico | Registra las APIs y las envía a revisión | — |
| `app_developer` | Desarrollador del sistema consumidor | Crea aplicaciones, maneja credenciales y pide accesos | — |

Cada persona necesita un **correo institucional propio**: la cuenta se verifica por correo y las invitaciones llegan a esa dirección. El segundo factor se configura con una app autenticadora (FreeOTP, Aegis, Google Authenticator u otra TOTP) en el teléfono de la persona.

**Documento:** el acto de designación del responsable de datos y del responsable técnico, en PDF. Se adjunta en la solicitud de alta.

## 3. Lo que la entidad debe disponer

### 3.1 Como consumidora

| Qué | Detalle |
| :-- | :-- |
| Un sistema consumidor | El servidor o la aplicación que hará las consultas. Debe poder hacer HTTPS con **certificado de cliente** (mTLS): cualquier lenguaje moderno lo permite (curl, Java, .NET, Python, Node) |
| Salida a internet | `443/tcp` hacia el **nombre del gateway** y el **nombre del portal** |
| Lugar seguro para secretos | La llave privada del certificado y el secreto de la aplicación: nunca en el código ni en un repositorio |
| `openssl` | Para generar la llave y la solicitud de certificado (CSR). La llave **nunca sale** del servidor de la entidad |
| Identificador del funcionario | Las APIs con datos personales exigen `X-DEN-End-User`: el usuario o el correo institucional de quien hace la consulta. Solo se registra como hash |

### 3.2 Como proveedora

Toda proveedora se conecta por medio del **nodo**, que se instala dentro de su red y abre un túnel cifrado **hacia afuera** (salida `UDP 51820` y `443/tcp`; ningún puerto de entrada). Detrás del nodo va la API propia de la entidad (modo canal) o APIs instantáneas sobre vistas de su base de datos (modo completo: SQL Server, PostgreSQL, MySQL u Oracle). Las entidades que ya publican en X-Road llegan por el Security Server del operador.

Los requisitos del servidor y de la red, la instalación y la publicación están en la **guía de proveedoras** del repositorio del kit.

#### Verificar la aserción del gateway

Si el país la tiene activada (`features.gatewayAssertion`), cada consulta llega con la cabecera `X-DEN-Assertion` (ADR-0024). Es un JWS ES256 firmado por el gateway con lo que autorizó:
- quién consulta: entidad, aplicación y suscripción;
- para qué: la finalidad;
- qué operación;
- el funcionario y el titular, como seudónimos;
- a qué petición corresponde: método y SHA-256 de la ruta con su query; con cuerpo, también el SHA-256 del cuerpo.

La entidad puede guardarla como prueba de que la red autorizó esa consulta. Para aceptarla, el servicio comprueba:
1. que la firma verifica con una clave del JWKS de la red (`https://<portal>/api/v1/gateway/jwks`, por `kid`; si llega un `kid` desconocido, volver a descargarlo);
2. que `aud` es el identificador de la entidad (su slug en el portal), que `iss` es la URL pública del gateway y que `exp` no pasó;
3. que `req.method` y `req.uri_sha256` son los de la petición recibida (método, y ruta con query tal como llegaron);
4. que, en POST, PUT y PATCH, en cualquier petición que haya traído cuerpo (también un GET o un DELETE) y siempre que la aserción lo traiga, `req.body_sha256` es el SHA-256 de los bytes recibidos, sea cual sea su tipo de contenido (el de nada, si no llegó cuerpo). El servicio tiene que hashear el cuerpo tal como llegó, antes de interpretarlo;
5. que su `jti` no se vio antes mientras la aserción vale: así una aserción capturada no se puede repetir. Basta con recordar los `jti` hasta su `exp`.

El token no lleva números de identificación: el número va en la ruta, y la aserción solo lleva su hash. Se puede archivar sin datos personales en claro. `jti` es el identificador de la petición en el gateway (el `$request_id` de nginx, no el `X-Request-Id` del consumidor), el mismo del registro de transparencia del titular.

Node.js, sin librerías:

```js
import { createHash, createPublicKey, verify } from 'node:crypto';
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const jwks = await (await fetch('https://<portal>/api/v1/gateway/jwks')).json();

const seen = new Map(); // jti -> exp; borrar periódicamente los vencidos

// body: los bytes crudos recibidos (Buffer), o undefined si no hubo cuerpo.
function checkAssertion(token, { method, url, body, audience, issuer }) {
  const [h, c, s] = token.split('.');
  const { kid, alg } = JSON.parse(Buffer.from(h, 'base64url'));
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk || alg !== 'ES256') return false;
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  if (!verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) return false;
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  if (claims.aud !== audience || claims.iss !== issuer || claims.exp * 1000 <= Date.now()) return false;
  if (claims.req.method !== method || claims.req.uri_sha256 !== sha256(url)) return false;
  if (['POST', 'PUT', 'PATCH'].includes(method) || claims.req.body_sha256 !== undefined || body?.length) {
    if (claims.req.body_sha256 !== sha256(body ?? '')) return false;
  }
  if (seen.has(claims.jti)) return false; // repetida
  seen.set(claims.jti, claims.exp);
  return true;
}
```

Python, con PyJWT (MIT) y `cryptography`:

```python
import hashlib, jwt
jwks = jwt.PyJWKClient("https://<portal>/api/v1/gateway/jwks")

seen = {}  # jti -> exp; borrar periódicamente los vencidos

def check_assertion(token, method, url, body, audience, issuer):
    """body: los bytes crudos recibidos (b"" si no hubo cuerpo)."""
    key = jwks.get_signing_key_from_jwt(token).key
    # firma, aud, iss y exp
    claims = jwt.decode(token, key, algorithms=["ES256"], audience=audience, issuer=issuer)
    req = claims["req"]
    if req["method"] != method or req["uri_sha256"] != hashlib.sha256(url.encode()).hexdigest():
        return False
    if method in ("POST", "PUT", "PATCH") or "body_sha256" in req or body:
        if req.get("body_sha256") != hashlib.sha256(body).hexdigest():
            return False
    if claims["jti"] in seen:  # repetida
        return False
    seen[claims["jti"]] = claims["exp"]
    return True
```

En Java sirve Nimbus JOSE + JWT (Apache-2.0) y en .NET `System.IdentityModel.Tokens.Jwt` (MIT), con la misma lista de comprobaciones. El proveedor de prueba del portal (`infra/mock-providers/src/assertion.ts`) es una referencia completa.

### 3.3 Lista de preparación

El portal tiene esta lista por entidad (Mi entidad → Preparación del bootcamp), y el operador ve el avance de todas:

- [ ] **Servidor** disponible (el sistema consumidor, o el del nodo).
- [ ] **Usuario de solo lectura** en la base de datos (solo proveedoras con el modo completo del nodo).
- [ ] **Salida 443** hacia el gateway (y UDP 51820 para el nodo de una proveedora).
- [ ] **Responsables designados:** el portal lo marca solo cuando hay un `api_publisher` y un `data_steward` activos.
- [ ] **Caso de uso** definido: qué dato, para qué finalidad, con qué base legal y entre qué entidades.

## 4. Paso a paso de la jornada

Antes de empezar, el operador da a las entidades los dos nombres de la plataforma: el del **portal** (`https://<portal>`) y el del **gateway** (`<gateway>`).

### 4.1 Verificar la red desde el servidor de la entidad

Desde el servidor que hará las consultas (o el del nodo), con el script `scripts/entity-check.sh` del repositorio, que el operador entrega en la jornada y el portal sirve en `https://<portal>/files/entity-check.sh` (la ficha de cada aplicación lo enlaza):

```bash
chmod +x entity-check.sh
./entity-check.sh check <portal> <gateway>
```

Comprueba el DNS, la salida HTTPS al portal y al gateway, y que el certificado del gateway verifica contra la raíz de la red. Deja la raíz en `./den-network-ca.pem`. Solo necesita `bash`, `curl` y `openssl`.

### 4.2 Alta de la entidad y de su gente

1. El futuro `entity_admin` entra a `https://<portal>`, crea su cuenta y confirma el correo.
2. Pide el alta de la entidad: datos, responsables designados y documento de designación. El operador la revisa y la aprueba. Si la entidad ya está incorporada por un acto formal, el operador la da de alta directamente.
3. El `entity_admin` invita a cada persona a su correo y asigna roles. Cada invitado crea su cuenta con **ese mismo correo** y acepta la invitación.
4. El `data_steward` configura su segundo factor la primera vez que el portal lo pide.

### 4.3 Entidad proveedora: instalar el nodo y publicar una API

Está en la **guía de proveedoras** del repositorio del kit: el token de enrolamiento, la instalación del nodo, la publicación de la API con su sandbox, la revisión y lo que recibe el servicio en cada consulta.

### 4.4 Entidad consumidora: primera consulta

1. **Probar en sandbox primero.** El `app_developer` crea una aplicación de tipo **sandbox**. Sus solicitudes a APIs con sandbox se aprueban al instante y llaman a `/sandbox/...`, con datos sintéticos.
2. **Guardar el secreto** que se muestra al crear la aplicación: se ve una sola vez.
3. **Certificado de la aplicación** (mTLS), en el servidor de la entidad:
   ```bash
   ./entity-check.sh csr <client_id>      # crea <client_id>.key (600) y <client_id>.csr
   ```
   Pega la CSR en la ficha de la aplicación → Certificado de cliente (mTLS), descarga el certificado y guárdalo como `<client_id>.crt` junto a la llave.
4. **Pedir acceso:** en el catálogo, la API → Solicitar acceso. Elige la aplicación, la finalidad, el detalle, la base legal, las operaciones, la vigencia y el acuerdo de intercambio. En producción la aprueba el `data_steward` del proveedor (y el regulador, si es sensible).
5. **Llamar:**
   ```bash
   CLIENT_SECRET=... ./entity-check.sh call <portal> <gateway> <client_id> \
     /sandbox/<entidad>/<api>/v1/<recurso> <finalidad> <funcionario>
   ```
   El script pide el token al gateway (`/oauth/token`, ligado al certificado), hace la consulta con `X-DEN-Purpose` y `X-DEN-End-User`, y explica la respuesta. Las URL exactas están en la ficha de la API y en la ficha de la suscripción.
6. Con la aplicación de **producción** se repiten los pasos 2 a 5 con la ruta real (sin `/sandbox`), una vez aprobada la solicitud.

## 5. Por qué el gateway niega una llamada

El gateway responde `403` con `application/problem+json` y un `code` estable:

| `code` | Qué significa | Qué hacer |
| :-- | :-- | :-- |
| `no_subscription` | La aplicación no tiene acceso activo a esa versión | Pedir acceso o esperar la aprobación ("Aprobada, activándose" tarda segundos) |
| `purpose_not_allowed` | Falta `X-DEN-Purpose` o no es la finalidad aprobada | Enviar el código de finalidad de la suscripción |
| `operation_not_allowed` | La suscripción no cubre esa operación | Pedir acceso a esa operación |
| `end_user_required` / `end_user_invalid` | Falta `X-DEN-End-User` o es inválido (1 a 128 caracteres visibles, sin espacios) | Enviar el usuario institucional del funcionario |
| `client_certificate_required` / `certificate_mismatch` / `certificate_revoked` | Sin certificado, el de otra aplicación o uno revocado | Usar el certificado vigente de **esa** aplicación |
| `token_not_bound` | El token no está ligado al certificado | Pedir el token en `https://<gateway>/oauth/token` con el certificado |
| `environment_mismatch` | Aplicación sandbox en una ruta real, o al revés | Usar la ruta que corresponde al tipo de aplicación |
| `subscription_expired` / `app_suspended` | Venció la vigencia o la aplicación está suspendida | Renovar la solicitud o hablar con el operador |

Otros códigos: `401` (token vencido o inválido; dura 5 minutos), `404` (no hay API publicada en esa ruta), `429` (límite de la suscripción alcanzado).

## 6. Compromisos de la entidad

- **Finalidad real.** Solo consultar para la finalidad declarada y aprobada. Cada consulta queda en la bitácora y el ciudadano la ve.
- **Funcionario identificado.** Enviar en `X-DEN-End-User` a la persona que realmente consulta.
- **Credenciales protegidas.** La llave privada y el secreto no se comparten ni se suben a repositorios. Ante una sospecha, se **revocan** desde la ficha de la aplicación. Antes de que venza un certificado (90 días, con aviso a los 15), se emite otro: el anterior sigue sirviendo durante la ventana de rotación.
- **No guardar de más.** Conservar solo lo que la finalidad exige.
- **Avisar los cambios.** Un cambio incompatible en una API publicada exige una versión mayor nueva. La anterior se deprecia con fecha de retiro.

## 7. Contactos y soporte

- **Operador:** altas de entidades, revisión de APIs, problemas de conexión con el gateway.
- **Regulador:** aprobaciones de datos sensibles, marco normativo.
- **Dentro de la entidad:** el `entity_admin` gestiona su gente y sus nodos; el `data_steward` decide los accesos.
