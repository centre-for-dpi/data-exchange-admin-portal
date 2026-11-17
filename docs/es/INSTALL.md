# Instalación en un servidor — Portal DEN (portal + gateway)

> English version (official): [docs/INSTALL.md](../INSTALL.md)

Versión 1.2 · noviembre 2026 · estado del código con M6: todo salvo la prueba de carga (M6-03) y la instalación en un clúster (M6-05), que necesitan el entorno tipo producción del operador

Esta guía instala **toda la plataforma central** (portal, gateway, identidad, CA, sellado de tiempo, registros) en **un solo servidor Linux** con un script interactivo: `sudo ./install.sh`. Es la topología de **piloto** (`DEPLOYMENT.md §1`). Sirve para la puesta en marcha con el operador, el bootcamp de entidades y las demos. La producción, con alta disponibilidad, es otro ejercicio: son los Helm charts de M6-05.

> **Qué NO instala.** El kit de APIs instantáneas que corre en las entidades es otro producto, con su propio repositorio (ADR-0011). Lo que cada entidad debe tener está en [`guides/entities.md`](guides/entities.md), y lo de las proveedoras, en la guía de proveedoras del repositorio del kit.

## 1. Requisitos del servidor (VPS)

### 1.1 Tamaño

| | Mínimo (sin observabilidad) | **Recomendado (bootcamp, con observabilidad)** |
| :-- | :-- | :-- |
| vCPU | 4 | **4–8** |
| RAM | 8 GB | **16 GB** |
| Disco | 60 GB SSD | **100 GB SSD** |
| Sistema | Linux x86_64 o arm64 de 64 bits con kernel ≥ 5.6: Ubuntu 22.04/24.04 LTS, Debian 12 o RHEL/Rocky 9 | Ubuntu 24.04 LTS |

De dónde salen los números (medido en el piloto de demo, noviembre 2026):

- **En reposo**, el stack completo usa unos **2,3 GB de RAM**: Keycloak ~650 MB, OpenSearch ~670 MB, APISIX ~190 MB, API ~150 MB, web ~120 MB y el resto menos de 70 MB cada uno.
- **El pico real es la compilación** de las imágenes del portal y del API en la instalación y en cada actualización: 3–4 GB más durante 10–20 minutos. Con 8 GB funciona; con 16 GB queda margen para el bootcamp, con muchas personas conectadas a la vez.
- **Disco:** las imágenes ocupan ~15 GB y la caché de compilación crece con cada actualización (llegó a 17 GB en el piloto). Los datos son pequeños al principio (la base de datos ~100 MB), pero la analítica y la bitácora crecen con el tráfico.
- El kernel ≥ 5.6 trae WireGuard. Sin él, el hub usa `wireguard-go`, que funciona pero rinde menos.

### 1.2 Red y DNS

| Qué | Detalle |
| :-- | :-- |
| **IP pública fija** | El servidor debe ser alcanzable desde internet (las entidades y sus sistemas llegan a él) |
| **Dos nombres DNS** (registro A) hacia esa IP | **Portal**, p. ej. `portal.den.example`: personas, portal web, API del portal e inicio de sesión. **Gateway**, p. ej. `gw.den.example`: tráfico entre sistemas, con mTLS |
| **Entrada** | `443/tcp`: portal y gateway, con un solo puerto, separados por nombre (SNI). `80/tcp`: solo para Let's Encrypt y la redirección a HTTPS. `51820/udp`: túneles WireGuard de los nodos del kit |
| **Salida durante la instalación** | HTTPS a Docker Hub, quay.io, ghcr.io, el registro de npm y PyPI (imágenes y dependencias de la compilación) |
| **Certificado del portal** | Let's Encrypt automático, o un certificado propio de la entidad (PEM con la cadena completa y la llave) |
| **Certificado del gateway** | No hace falta pedirlo: lo emite la CA de la red (step-ca). Los sistemas confían en él con la raíz de la red |

No debe haber otro servicio en 80 ni en 443. Si el servidor ya tiene un Traefik, el instalador puede unirse a él (§3, paso 4).

**Antes del martes:**

- [ ] VPS creado, con acceso `root` o `sudo` por SSH.
- [ ] Los dos registros DNS creados y propagados: `getent hosts <nombre>` debe dar la IP del servidor.
- [ ] Puertos 80/tcp, 443/tcp y 51820/udp abiertos en el firewall del proveedor de nube.
- [ ] `git` instalado y el repositorio clonado en el servidor.

### 1.3 Software

El instalador lo comprueba todo, y si falta Docker ofrece instalarlo con el script oficial (`get.docker.com`).

- Docker Engine con el plugin Compose ≥ 2.26.
- `git`, `curl`, y `openssl` para las comprobaciones.
- **No** hace falta Node.js en el servidor: los scripts auxiliares corren en un contenedor `node`.

## 2. Instalación

```bash
git clone https://github.com/centre-for-dpi/data-exchange-admin-portal.git den && cd den
sudo ./install.sh
```

El script hace las preguntas una por una, muestra un resumen y pide confirmación antes de tocar nada. Después compila y arranca todo (10–20 minutos la primera vez) y comprueba que funciona.

## 3. Las preguntas, una por una

| Paso | Pregunta | Qué responder |
| :-- | :-- | :-- |
| 1 | — | Verificación del servidor: sistema, CPU, RAM, disco, Docker, `/dev/net/tun`. Se detiene si falta algo imprescindible |
| 2 | **País** | El código de `config/country/<código>.yaml`. Por ejemplo, `co` (Colombia) |
| 3 | **Nombre del portal** | Solo el nombre, sin `https://` (p. ej. `portal.den.example`) |
| 3 | **Nombre del gateway** | Por defecto `gw.<portal>`. Debe ser distinto del portal |
| 4 | **Proxy de entrada** | `1` Incluido (recomendado): el instalador pone Traefik en 80/443. `2` Ya tengo Traefik: se une a su red de Docker y le escribe las rutas del portal y del gateway (proveedor de archivos). Pregunta el entryPoint HTTPS (`websecure`), el certResolver del certificado del portal (`-`: tu Traefik ya lo tiene) y la carpeta dinámica de Traefik en este servidor (`-`: solo escribe `infra/edge/den-external.yml`, para que lo copies) |
| 4 | **Certificado del portal** | `1` Let's Encrypt (correo de contacto opcional; el puerto 80 debe ser alcanzable). `2` Propio: rutas al certificado (cadena completa) y a la llave, en PEM. Debe ser de una CA pública reconocida: el API y la web también llaman al portal por su nombre y verifican el certificado |
| 5 | **Observabilidad** (OpenSearch, Prometheus, Alertmanager, Grafana) | Sí, si el servidor tiene 16 GB: da los indicadores de uso, las alertas por correo y el tablero del operador en `/grafana`. Se puede prescindir: no afecta al tráfico, a la auditoría ni a la transparencia |
| 5 | **Antivirus de documentos** (ClamAV) | Sí, si el servidor tiene 8 GB: revisa cada documento subido antes de guardarlo. Suma ~1,2 GB de RAM y descarga sus firmas de internet |
| 6 | **Contraseña de los usuarios de demo** | Enter genera una aleatoria. Elige una si la vas a compartir en el bootcamp |

Luego, sin más preguntas:

- **Paso 7.** Escribe `.env` (modo 600) con todos los secretos generados al azar: contraseñas de bases de datos, claves de firma, la llave del seudónimo, la clave del hub WireGuard y los tokens internos.
- **Paso 8.** Crea la red de Docker, ajusta `vm.max_map_count` para OpenSearch y, si detecta `ufw` o `firewalld`, ofrece abrir los puertos.
- **Paso 9.** Compila y arranca todo, y espera a que cada servicio esté sano.
- **Paso 10.** Comprueba cinco cosas:
  - que el API responde;
  - que el bundle de OPA **no** está expuesto al público;
  - que Keycloak responde;
  - que OPA ya tiene política;
  - que el gateway presenta el certificado de la red.

> **Guarda `.env` fuera del servidor**, cifrado. Sin él no se pueden recuperar los datos ni verificar los comprobantes ya emitidos (`DEPLOYMENT.md §4.1`). Volver a ejecutar `./install.sh` **nunca** lo regenera: reutiliza sus secretos y respuestas.

## 4. Qué queda instalado

| URL | Qué es | Quién la usa |
| :-- | :-- | :-- |
| `https://<portal>` | Portal: catálogo, consolas del operador, del regulador y de las entidades | Personas |
| `https://<portal>/api/v1` | API del portal | La web, integraciones |
| `https://<portal>/auth` | Keycloak: inicio de sesión, segundo factor, consola de administración en `/auth/admin/` | Personas, operador |
| `https://<gateway>` | **Gateway**: tráfico entre entidades con mTLS, tokens en `/oauth/token`, canal de control de los nodos | Sistemas de las entidades |
| `<gateway>:51820/udp` | Hub WireGuard: túneles de los nodos del kit | Nodos |
| `https://<portal>/mail` | Correo de pruebas (Mailpit): todo el correo del piloto llega aquí, con usuario y contraseña | Operador |
| `https://<portal>/citizen-app` | App ciudadana de referencia (demo de transparencia) | Demos |
| `https://<portal>/grafana/` | Tablero del operador (con la observabilidad activada), con su propio usuario `admin` | Operador |

Los demás servicios (PostgreSQL, etcd, OPA, step-ca, TSA, Fluent Bit, OpenSearch, el runner de contratos, los proveedores de prueba) no se publican. La explicación de cada uno está en [`guides/operator.md`](guides/operator.md).

## 5. Comprobación de punta a punta

1. `sudo ./install.sh status`: todos los servicios `healthy` (`tsa-init` termina, con `exited (0)`).
2. `sudo ./install.sh credentials`: entra al portal como `ana.operadora`. Pide un código de segundo factor, que da `sudo ./install.sh otp`.
3. El gateway exige certificado de cliente. Sin él, el handshake TLS falla:
   ```bash
   curl -v https://<gateway>/      # → error de TLS: "certificate required"
   ```
4. **Recorrido completo:** el guion de [`DEMO.md`](DEMO.md) (publicar, revisar, solicitar, aprobar, llamar) con los usuarios de demo. El ensayo automático está en `OPERATIONS.md §2.2`.

## 6. Datos de demostración y primer administrador

El piloto **siempre** carga el seed: tres entidades ficticias (operador, una de salud, una de programas sociales) y los usuarios de demo con sus roles. Así existe el primer `platform_admin` (`pablo.plataforma`): hoy no hay otra forma de crearlo (`DEPLOYMENT.md §8`). Para el bootcamp:

- las entidades reales se dan de alta desde el portal (autorregistro y solicitud de alta, o alta directa por el `platform_admin`);
- las entidades ficticias sirven para practicar;
- antes de un uso real, el operador crea las cuentas de sus personas y les asigna roles. En producción no hay usuarios semilla.

## 7. Comandos del día a día

| Comando | Qué hace |
| :-- | :-- |
| `sudo ./install.sh status` | Estado de los contenedores y las comprobaciones del paso 10 |
| `sudo ./install.sh credentials` | Usuarios de demo, administrador de Keycloak, usuario del correo de pruebas y de Grafana |
| `sudo ./install.sh otp` | Código vigente de segundo factor de los usuarios de demo con rol crítico |
| `sudo ./install.sh logs [servicio]` | Logs (p. ej. `logs api`) |
| `sudo ./install.sh backup` | Respaldo completo de pgBackRest y copia en `backups/<fecha>/`: volcados de `den` y `keycloak`, el repositorio de respaldos (cifrado), los volúmenes de la CA, la TSA, documentos y app ciudadana, y `.env`. Los respaldos diarios ya corren solos (`OPERATIONS.md §6`) |
| `sudo ./install.sh restore [instante]` | Restaura la base al último estado archivado, o al instante dado (`"2026-11-20 14:30:00-05"`). Detiene y arranca todo |
| `sudo ./install.sh update` | Respaldo, `git pull --ff-only`, recompilación y reinicio |
| `sudo ./install.sh stop` / `start` | Detiene o arranca todo, sin perder datos |

Equivalente con Compose, para los comandos de `OPERATIONS.md`, con el proxy incluido:

```bash
alias dc='docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml \
  -f infra/compose/docker-compose.edge.yml --env-file .env --profile observability'
```

Sin observabilidad, quita `--profile observability`; con el antivirus, agrega `--profile antivirus`; con un Traefik propio, quita `-f infra/compose/docker-compose.edge.yml`.

Un `.env` escrito a mano o por `make-deploy-env.mjs` (como el del piloto de demo) no tiene las respuestas del instalador. Agrégale `DEN_PORTAL_HOST`, `DEN_GATEWAY_HOST`, `DEN_INSTALL_PROXY` (`bundled` o `external`), `DEN_INSTALL_TLS`, `DEN_INSTALL_OBSERVABILITY` y `DEN_INSTALL_ANTIVIRUS` (`true` o `false`; con el antivirus, también `DEN_CLAMAV_URL=tcp://clamav:3310`), o sigue usando Compose directamente.

## 8. Problemas frecuentes de la instalación

| Síntoma | Qué hacer |
| :-- | :-- |
| "Puertos ocupados" | Otro servicio usa 80/443 (`ss -ltnp`). Detenlo o elige la opción 2 del paso 4 |
| El portal muestra un certificado inválido | Let's Encrypt no pudo validar: el DNS del portal no apunta aquí o el puerto 80 está cerrado. Corrige y espera, porque Traefik reintenta solo. `sudo ./install.sh logs edge` |
| Un servicio no queda sano y la instalación se detiene | `sudo ./install.sh logs <servicio>`. Keycloak puede tardar hasta 5 minutos en una máquina chica. Vuelve a ejecutar `sudo ./install.sh` |
| OpenSearch se reinicia | Falta memoria o `vm.max_map_count`. Reinstala sin analítica o amplía la RAM |
| Inicio de sesión en bucle | El nombre del portal no coincide con el del `.env` (`DEN_PUBLIC_URL`). `OPERATIONS.md §7` |
| Los nodos no conectan | 51820/udp cerrado en el firewall de la nube, o el DNS del gateway no apunta aquí (`DEN_WG_HUB_ENDPOINT`) |
| Se perdió `.env` | Sin copia, no hay recuperación: se reinstala desde cero, borrando los volúmenes `den_*` |

Más diagnóstico en `OPERATIONS.md §4` y §7.

## 9. Desinstalar

```bash
sudo ./install.sh stop
# Borra contenedores Y DATOS (bases de datos, CA, bitácora). Irreversible: respalda antes.
docker compose -f infra/compose/docker-compose.yml -f infra/compose/docker-compose.deploy.yml \
  -f infra/compose/docker-compose.edge.yml --env-file .env --profile observability down --volumes
docker network rm den-edge
```
