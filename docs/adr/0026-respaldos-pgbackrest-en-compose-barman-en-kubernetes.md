# ADR-0026 — Respaldos: pgBackRest en Compose, Barman Cloud en Kubernetes

- Estado: Aceptado
- Fecha: 2026-11-16

## Contexto

M6-06 pide respaldos de PostgreSQL con pgBackRest y un procedimiento de restauración probado. La base `rid` es la única fuente de verdad del portal: entidades, suscripciones, la bitácora de auditoría y el registro de transparencia. La base `keycloak` tiene las cuentas y los clientes de las aplicaciones. Hasta ahora el respaldo era un `pg_dump` manual (`install.sh backup`): sin recuperación a un punto en el tiempo, y lo escrito desde el último volcado se perdía.

Hay dos topologías y cada una gestiona PostgreSQL de forma distinta:

- **Compose** (desarrollo y el piloto de un servidor, que es lo que corre hoy en la AND): un contenedor `postgres`. No hay almacenamiento de objetos, y MinIO está prohibido (CLAUDE.md).
- **Kubernetes** (chart de M6-05): CloudNativePG gestiona las bases con réplicas y conmutación por falla. Su archivado de WAL ya no viene integrado: va por plugins (CNPG-I). Hay dos:
  - **Barman Cloud**, oficial: Apache-2.0, v0.15, mantenido por el equipo de CloudNativePG;
  - **pgBackRest**, de Opera: Apache-2.0, v0.10, de un tercero y joven.

El operador de pgBackRest de Crunchy (PGO) distribuye sus imágenes con términos no OSI (regla 1).

## Decisión

**Compose: pgBackRest** (MIT), en la imagen de PostgreSQL (`infra/postgres`).
- **Archivado.** El piloto archiva cada segmento de WAL (`archive_timeout` de 5 minutos) en un repositorio local cifrado con AES-256 (`PGBACKREST_REPO1_CIPHER_PASS`).
- **Respaldos.** El servicio `pgbackrest` toma un respaldo completo por semana y uno diferencial por día. Conserva cuatro completos, lo que da recuperación a cualquier instante del último mes.
- **Restauración.** `install.sh restore [instante]` restaura. `scripts/restore-test.mjs` prueba el procedimiento de punta a punta en CI: pérdida del volumen, recuperación a un instante y repositorio ilegible sin su clave.

**Kubernetes: el plugin oficial Barman Cloud** de CloudNativePG, instalado por `rid-platform`.
- **Destino.** Archiva el WAL y un respaldo base diario de las dos bases en el almacenamiento S3-compatible del operador, fuera del clúster.
- **Retención.** 30 días por omisión.
- **Restauración.** Se crea un `Cluster` nuevo desde ese almacenamiento.

## Alternativas consideradas

- **pgBackRest en Kubernetes con el plugin de Opera:** una sola herramienta y un solo runbook. Pero es un plugin joven de un tercero, sobre la pieza que guarda la única copia de los datos. Se puede revisar con un ADR nuevo cuando madure.
- **Barman también en Compose:** necesita un almacenamiento de objetos (barman-cloud) o un servidor Barman aparte con SSH (GPL-3.0, como servicio separado). pgBackRest guarda en un disco local cifrado sin nada más, que es lo que tiene un servidor de piloto.
- **Volúmenes instantáneos de CSI en Kubernetes:** dependen del almacenamiento del clúster y no dan recuperación a un punto en el tiempo.
- **Seguir con `pg_dump`:** se queda como copia lógica, útil para mover datos entre versiones o plataformas (del piloto a Kubernetes). No sirve como respaldo principal: pierde todo lo escrito desde el último volcado.

## Consecuencias

- **Dos herramientas y dos procedimientos** de restauración, uno por topología (`OPERATIONS.md §6`). La prueba automatizada cubre solo el de Compose. El de Kubernetes se prueba al instalar el chart (M6-05), contra el almacenamiento real del operador.
- **Cifrado.**
  - En Compose el repositorio va cifrado del lado del cliente: una copia puede salir del servidor tal cual. Sin `PGBACKREST_REPO1_CIPHER_PASS` no se restaura nada, así que esa clave se guarda fuera del servidor.
  - barman-cloud no cifra del lado del cliente. En Kubernetes la confidencialidad depende del cifrado del almacenamiento (`encryption: AES256`) y de que la clave de acceso solo escriba en ese bucket.
- **El repositorio local de Compose está en el mismo servidor.** No protege de la pérdida del disco. `install.sh backup` copia el repositorio cifrado a `backups/` para llevarlo fuera. Un segundo repositorio remoto de pgBackRest (S3 o SFTP, `repo2`) queda como mejora.
- **Primera instalación de `rid-platform` en dos pasos.** El plugin emite sus certificados con cert-manager. Si cert-manager llega con el mismo chart, se instala primero con `plugin-barman-cloud.enabled=false` y se activa en la actualización siguiente.
- **Una instalación existente del piloto** necesita la clave nueva. `install.sh` la genera si falta en `.env` y pide guardar una copia.
