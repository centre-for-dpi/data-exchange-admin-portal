# Revisión OWASP ASVS 5.0 nivel 2 (M6-01)

> English version (official): [docs/security/ASVS-L2.md](../../security/ASVS-L2.md)

- Fecha: 2026-11-16 · Alcance: portal (`apps/web`, `apps/api`), gateway (APISIX, OPA, plugins `den-*`), Keycloak, infraestructura de Compose (desarrollo y piloto).
- Método: revisión contra el código y la configuración, no contra la documentación, capítulo por capítulo de ASVS 5.0 (V17 WebRTC no aplica). Cada hallazgo se verificó en el código antes de anotarlo.
- Estados: **Cumple** · **Corregido** (en esta historia) · **Parcial** · **Pendiente** (con destino) · **No aplica**.

## Resumen

El núcleo cumple: autorización en el backend con aislamiento por entidad, validación de tokens, defensa contra SSRF, almacenamiento de documentos, CSP con nonce y bitácora de auditoría encadenada.

M6-01 corrigió lo que podía corregirse sin cambiar la topología: límites de peticiones, cabeceras del API, eventos de seguridad, política de contraseñas, URIs exactas de OIDC, segmentación de red, keyring propio de APISIX, lista mínima de plugins, escaneo de dependencias y la cola paginada del operador.

Lo que exigía otra topología (TLS y autenticación entre componentes internos, Keycloak en modo producción, bóveda de secretos), el SBOM y los logs del API en el pipeline central quedaron en el chart de Helm de M6-05 (correcciones 14 a 19), que falta instalar. El antivirus de documentos se agregó en M6-08 (corrección 20).

## Correcciones de M6-01

| # | Hallazgo | Corrección | Prueba |
| :-- | :-- | :-- | :-- |
| 1 | Sin límite de peticiones (2.4.1) | `@fastify/rate-limit` en el API, antes de leer el cuerpo:<br>• cuota por usuario verificado, o por dirección si el token no es válido: inventar tokens no da cuotas nuevas (`DEN_RATE_LIMIT_PER_MINUTE`, 600);<br>• cuota estricta en rutas costosas (subidas, versiones nuevas, solicitudes de alta, invitaciones, enrolamiento de nodos; `DEN_RATE_LIMIT_STRICT_PER_MINUTE`, 30);<br>• sin límite solo en las rutas de control de los servicios de la plataforma, cada una con su credencial, reconocidas por plantilla de ruta;<br>• `X-Forwarded-For` solo desde el proxy y la web (`DEN_TRUST_PROXY`, direcciones o nombres de host); la web reenvía la dirección del visitante solo en peticiones que traen el token del proxy (`DEN_WEB_PROXY_TOKEN`), porque no ve a su par directo: una cabecera falsificada enviada directo a la web se ignora (M-27);<br>• 429 en RFC 9457.<br>El proxy agrega límites por dirección en `/api/v1` y `/auth` (`infra/edge/den.yml.template`). | `common/rate-limit.int.test.ts`, `trust-proxy.test.ts`, `audit/audit-ip.int.test.ts`, `apps/web/src/lib/client-ip.test.ts` |
| 2 | Una subida con token inventado se leía (10 MiB) antes del 401 | El hook de la subida verifica el JWT de verdad antes de leer el cuerpo | `common/rate-limit.int.test.ts` |
| 3 | Respuestas del API sin cabeceras de seguridad (3.4.x, 4.1.x) | `nosniff`, `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, HSTS y `Cache-Control: no-store` (salvo que el endpoint declare otro) | `health/health.controller.test.ts` |
| 4 | Rechazos sin registro atribuible (16.3.1-16.3.3) | Una línea JSON por cada 400/401/403/404/409/429: quién (`sub`), desde dónde (IP con `DEN_TRUST_PROXY`, user agent), qué (plantilla de ruta, ruta sin query) y por qué. Nunca la query, el token ni el cuerpo | `common/security-event.test.ts` |
| 5 | Keycloak registraba solo errores de login y cambios de credencial | Eventos de LOGIN, LOGOUT, REGISTER, CODE_TO_TOKEN_ERROR, REFRESH_TOKEN_ERROR, RESET_PASSWORD y VERIFY_EMAIL, más eventos de administración | Realm `den-portal` |
| 6 | Sin política de contraseñas con registro abierto (6.2.x) | `length(12) and maxLength(128) and notUsername and notEmail and passwordHistory(5)` | Realm `den-portal` |
| 7 | URIs de redirección con comodín (10.4.1) | URIs exactas: el callback de Auth.js, los inicios por idioma y el callback de la app ciudadana | Realms `den-portal` y `den-citizens` |
| 8 | etcd y OPA sin autenticación, alcanzables desde cualquier contenedor (13.2.1); salida del gateway a las redes de la plataforma (pendiente de M1-08) | Segmentación en tres redes:<br>• `gateway`: control del gateway, con etcd y OPA solo ahí;<br>• `providers`: upstreams y el runner de contrato;<br>• `default`: la plataforma.<br>El gateway no alcanza la base de datos, la CA, OpenSearch ni el correo. Los upstreams no alcanzan etcd, OPA, la plataforma ni el API (en el piloto el API comparte con el runner de contrato una red `runner` solo de ellos dos).<br>Desde R-02 (ADR-0031), el API de OPA pide un token y etcd un usuario, y solo APISIX alcanza las entradas de Fluent Bit (red `logs`) | `tests/infra/src/networks.int.test.ts` (desarrollo y piloto); `tests/infra/src/gateway.int.test.ts` (credenciales, alcance) |
| 9 | Keyring de APISIX de fábrica, público (S-6) | Keyring propio por despliegue (`DEN_APISIX_KEYRING`), sin la clave de fábrica (B-31): el reconciliador vuelve a escribir cada objeto con llave privada al arrancar, así APISIX lo cifra de nuevo | `tests/infra/src/gateway.int.test.ts`, `apisix.reconciler.test.ts` |
| 10 | Todos los plugins de APISIX habilitados, incluidas funciones serverless (15.2.3) | Solo los quince que usan las rutas del portal; `serverless-*`, `inspect`, `echo` y los `ai-*` quedan fuera | `tests/infra/src/gateway.int.test.ts` |
| 11 | Sin escaneo de vulnerabilidades (15.2.1) | `pnpm audit --audit-level high` en CI y política de corrección (abajo) | `.github/workflows/ci.yml` |
| 12 | Etiqueta GCM truncada aceptada (por confirmar) | `authTagLength: 16` al abrir secretos sellados | `common/secrets.test.ts` |
| 13 | La cola de altas del operador mostraba solo las 200 más antiguas | Paginación por cursor en API y consola | `entities/entity-requests.int.test.ts` |

## Correcciones de M6-05 (chart de Helm) y M6-08

Las de M6-05 (14 a 19) están en `infra/helm/den` y se validaron solo de forma estática (`helm template` y kubeconform). El chart no se ha instalado en ningún clúster (`DEPLOYMENT.md §9`). La 20 (M6-08) corre también en el piloto.

| # | Pendiente | Corrección | Prueba |
| :-- | :-- | :-- | :-- |
| 14 | Componentes internos sin TLS ni autenticación propia (12.3.x, 13.2.1) | PKI interna con cert-manager:<br>• etcd con mTLS y una CA propia, que solo firma a sus miembros y al gateway;<br>• OpenSearch con TLS y su plugin de seguridad, con un usuario por cliente y solo los permisos que usa;<br>• Postgres con `sslmode=verify-full`;<br>• la API de OPA solo en el loopback del pod del gateway, con la escucha de diagnóstico aparte | `helm template` + kubeconform |
| 15 | Keycloak en `start-dev` y realms con usuarios de prueba (13.4.2) | `start` con realms de producción: `pnpm helm:sync` quita las personas y pone el SMTP del despliegue | `tests/infra/src/helm-files.test.ts` |
| 16 | Secretos en `.env` (13.3.x) | Un Secret por componente con solo sus claves, desde OpenBao con External Secrets | `helm template` |
| 17 | Salida de red sin límite | NetworkPolicies de entrada y de salida por componente. Hacia fuera, solo direcciones públicas en los puertos que usa cada uno | `helm template` + kubeconform |
| 18 | Sin SBOM ni escaneo de imágenes (15.1.2, 15.2.1) | SBOM CycloneDX y Trivy en CI: una vulnerabilidad alta o crítica con arreglo detiene la publicación. Imágenes del API y la web sin dependencias de desarrollo ni gestor de paquetes | `.github/workflows/images.yml` |
| 19 | Logs del API fuera del pipeline central, sin enmascarar (16.4.3, 14.x) | Cada línea enmascarada (queries, números de 6 dígitos o más, correos, credenciales en URL). En el chart, JSON para el colector de logs del clúster | `common/logger.test.ts` |
| 20 | Documentos sin antivirus (5.4.3) | ClamAV (`clamd`, M6-08) revisa cada documento antes de guardarlo; uno infectado se rechaza y, si no responde, la subida falla. Activado en el chart; opcional en el piloto (`--profile antivirus`) | `documents/antivirus.test.ts`, `documents/antivirus.int.test.ts` |
| 21 | Una sola `DEN_SECRETS_KEY`, sin identificador ni rotación (11.1) | Cada valor sellado nombra su clave (`v2.<kid>`); `DEN_SECRETS_KEYS_PREVIOUS` abre lo anterior (también el formato `v1`) y `secrets:reseal` lo sella de nuevo con la actual, de forma idempotente y auditada | `common/secrets.test.ts`, `secrets/reseal.int.test.ts` |

## Estado por capítulo

| Capítulo | Estado | Notas |
| :-- | :-- | :-- |
| V1 Codificación y saneamiento | Cumple | React escapa la salida y no hay HTML en markdown. Prisma en todo (la única consulta cruda es constante). `subprocess` sin shell. Defensa SSRF con DNS fijado. YAML con límite de alias. Nombres de archivo saneados. Correo en texto plano |
| V2 Validación y lógica | Cumple · Corregido | zod con objetos estrictos en todo `@Body`/`@Query`; transiciones condicionadas. **Corregido:** anti-automatización (1, 2). **Parcial:** las re-subidas del documento de designación se guardan todas (límite de tasa sí; tope por solicitud pendiente) |
| V3 Frontend web | Cumple · Corregido | CSP con nonce y `strict-dynamic`, HSTS, cookies `__Host-`/`__Secure-` HttpOnly SameSite, CSRF (API solo bearer). **Corregido:** cabeceras del API (3). **Parcial (baja):** abrir una notificación por GET la marca leída |
| V4 API | Cumple | Solo JSON y PDF, límites de cuerpo, cabeceras `X-DEN-*` imposibles de fijar por el cliente, errores RFC 9457 |
| V5 Archivos | Cumple · Corregido | Tamaño, bytes mágicos, nombres aleatorios fuera del web root, descarga con `attachment`. **Corregido:** antivirus con ClamAV antes de guardar, falla cerrada (20) |
| V6 Autenticación | Corregido · **Decisión** | **Corregido:** política de contraseñas (6). Fuerza bruta de Keycloak, TOTP, aviso de cambios de credencial. **Decisión pendiente (6.3.3):** hoy el segundo factor se exige a los roles de plataforma y a `data_steward`. L2 lo pide para todo acceso; extenderlo a `entity_admin` y `api_publisher` cambia el ingreso de las entidades y de los usuarios de demostración |
| V7 Sesiones | Cumple | Roles y estado desde la base en cada petición, expiración por inactividad y absoluta, cierre RP-initiated. Por confirmar: consola de cuenta de Keycloak para cerrar otras sesiones |
| V8 Autorización | Cumple | Política central, falla cerrada sin declaración de acceso, aislamiento por entidad (404 fuera), roles con efecto inmediato. El tráfico lo autoriza OPA y falla cerrado |
| V9 Tokens autocontenidos | Cumple | RS256 contra el JWKS del emisor, `exp`/`iss`/`aud`; el gateway valida antes de OPA |
| V10 OAuth/OIDC | Cumple · Corregido | Código con PKCE S256, sin implícito ni password grant, clientes confidenciales con token ligado al certificado. **Corregido:** URIs exactas (7) |
| V11 Criptografía | Cumple · Corregido | AES-256-GCM con IV aleatorio y AAD, aleatoriedad del sistema, comparaciones en tiempo constante. **Corregido:** etiqueta GCM (12). **Corregido:** identificador de clave y rotación de `DEN_SECRETS_KEY` (21) |
| V12 Comunicaciones | Cumple · Corregido en el chart | TLS externo, verificación de certificados hacia proveedores, mTLS de aplicaciones y nodos. **Corregido en el chart de Helm (M6-05, 14):** etcd con mTLS y CA propia, OpenSearch con TLS, Postgres con `verify-full`, OPA solo en el loopback del pod. El piloto con Compose sigue con la red interna como única barrera |
| V13 Configuración | Corregido · Corregido en el chart | **Corregido:** segmentación (8), keyring (9), plugins (10). Rol de base de datos de mínimo privilegio. **Corregido en el chart (14 a 17):**<br>• etcd con mTLS y OpenSearch con su plugin de seguridad;<br>• Keycloak en `start` (modo producción) con realms sin usuarios de prueba;<br>• imagen de Fluent Bit sin `-debug`;<br>• secretos desde OpenBao con External Secrets;<br>• NetworkPolicies de entrada y de salida por componente |
| V14 Protección de datos | Cumple · Corregido | Sin datos sensibles en URLs ni logs; sin cuerpos; lista blanca de campos; seudónimos con clave. **Corregido:** la clave de seudónimos en los datos de OPA ya no es alcanzable desde los upstreams (8). En el chart, la API de OPA solo escucha en el loopback del pod del gateway (14) |
| V15 Codificación segura | Corregido | Contenedores sin root, `select` explícito, bloqueos de concurrencia. **Corregido:** escaneo de dependencias (11); SBOM y escaneo de imágenes con Trivy en CI, e imágenes de producción sin dependencias de desarrollo ni gestor de paquetes (18) |
| V16 Logs y errores | Corregido · Parcial | Inventario de logs (§8), bitácora protegida y anclada, errores genéricos. **Corregido:** eventos de seguridad del API y de Keycloak (4, 5). **Corregido:** las líneas del API van enmascaradas y, en el chart, en JSON para el colector de logs del clúster, que las lleva al sistema central del operador (19) |

## Pendientes y su destino

| Pendiente | ASVS | Destino |
| :-- | :-- | :-- |
| Segundo factor para `entity_admin` y `api_publisher` | 6.3.3 | Decisión del operador. Si se adopta, es configuración y una guía para las entidades |
| Comprobar en un clúster lo corregido en el chart (14 a 19): no se ha instalado | 12.3.x, 13.x, 16.4.3 | M6-05 (instalación) |
| Tope de re-subidas del documento de designación | 2.3.2 | Mejora menor (hoy limitado por tasa) |

## Política de corrección de vulnerabilidades

| Severidad (CVSS / aviso del proveedor) | Plazo para corregir o mitigar en producción |
| :-- | :-- |
| Crítica | 7 días |
| Alta | 30 días |
| Media | 90 días |
| Baja | En la siguiente versión planificada |

CI falla con vulnerabilidades altas o críticas en las dependencias (`pnpm audit --audit-level high`). Una excepción temporal se documenta en el PR con su mitigación y su fecha de revisión.
