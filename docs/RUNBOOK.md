# Runbook del operador

Procedimientos del operador de la red (en Colombia, la AND) para lo que no es rutina: dar de alta una entidad, responder a un incidente, rotar la CA intermedia y revocar certificados en masa. La operación diaria, los respaldos y los problemas frecuentes están en [`OPERATIONS.md`](OPERATIONS.md); el despliegue, en [`DEPLOYMENT.md`](DEPLOYMENT.md).

Convenciones:

- `dc` es Docker Compose con los archivos del piloto (`OPERATIONS.md §0`). En Kubernetes, el equivalente es `kubectl -n rid`.
- **Consola** es la consola del operador del portal (`/operator`). Las acciones de `platform_admin` piden segundo factor.
- Toda acción del portal queda en la bitácora de auditoría. Lo que se hace fuera del portal (en Keycloak, en el servidor) se anota en el registro del incidente (§2.1).

## 1. Alta de una entidad

Hay dos caminos (`SPEC.md §4.1`). En los dos, la entidad queda activa y el portal invita por correo a su administrador y a sus responsables.

| Camino | Cuándo | Quién |
| :-- | :-- | :-- |
| **Solicitud de alta** | La entidad la pide desde el portal: un funcionario con cuenta verificada llena los datos, designa responsables y adjunta el documento de designación (PDF) | La revisa `platform_reviewer` en Consola → Altas de entidades por revisar |
| **Alta directa** | Un acto o una decisión ya incorporó a la entidad a la red | `platform_admin` en Consola → Entidades → Registrar entidad, con ese fundamento, que queda en la bitácora |

### 1.1 Revisar una solicitud

1. Abre la solicitud y el documento de designación. Comprueba:
   - que la entidad existe y que el identificador tributario es el suyo (el portal lo valida con el formato del país, no con un registro oficial);
   - que el documento designa a las personas que figuran como responsables de datos y técnico, y que lo firma alguien con autoridad para ello;
   - que el correo del solicitante y de los responsables es institucional de la entidad.
2. Decide:
   - **Pedir correcciones** si falta o sobra algo: el comentario lo lee el solicitante.
   - **Rechazar** si la solicitud es falsa o no corresponde. Es definitivo, pero libera el identificador para una solicitud legítima.
   - **Aprobar**: la entidad queda activa, el solicitante queda como `entity_admin` y los responsables reciben su invitación (vence a los 14 días, `RID_INVITATION_TTL_DAYS`).
3. Nadie revisa una solicitud que presentó o en la que figura como responsable: el portal no lo deja.

### 1.2 Después del alta

| Paso | Quién | Dónde |
| :-- | :-- | :-- |
| Los responsables aceptan su invitación (entran con el correo invitado, verificado) | Responsables | Portal → Invitaciones |
| Si la entidad publicará por X-Road: registrar su miembro X-Road | `platform_admin` | Consola → Entidades → la entidad |
| Preparación para el bootcamp: servidor, usuario de solo lectura en su base, salida por 443, responsables designados y caso de uso | Administrador de la entidad u operador | Consola → Bootcamp |
| Instalar el nodo del kit en la entidad y enrolarlo con un token de un solo uso | Administrador de la entidad, con el operador | Mi entidad → Nodos |
| Publicar la primera API y pasarla por revisión | Publicador de la entidad; `platform_reviewer` | Mis APIs; Consola → Revisiones |

Comprobación: la entidad figura activa en Consola → Entidades, su nodo en línea en Consola → Nodos, y su primera API en el catálogo.

### 1.3 Suspender o dar de baja

- **Suspender** (Consola → Entidades → la entidad): con un motivo. Sus aplicaciones dejan de pasar por el gateway y no publica nada nuevo. Con "también como proveedora", sus APIs dejan de atender a otras entidades. Reactivar devuelve cada suscripción a su estado anterior.
- **Dar de baja**: es definitivo. Cierra sus suscripciones de los dos lados, retira sus versiones y revoca sus membresías.

## 2. Incidentes

### 2.1 Procedimiento general

1. **Abrir un registro del incidente** (fuera del portal, en el sistema de tickets del operador): hora de detección, quién lo detectó, síntoma.
2. **Clasificar la severidad:**

   | Severidad | Ejemplos | Respuesta |
   | :-- | :-- | :-- |
   | **Crítica** | Fuga de datos personales; clave o certificado comprometido en uso; gateway caído para toda la red; cadena de auditoría alterada | Inmediata, a cualquier hora. Avisar al regulador (MinTIC) y a las entidades afectadas |
   | **Alta** | Una entidad o aplicación comprometida; portal caído (el gateway sigue); respaldos fallando | En la hora, en horario extendido |
   | **Media** | Un nodo de entidad fuera de línea; reconciliación con errores; certificado por vencer | En el día hábil |
   | **Baja** | Errores aislados sin efecto en el tráfico | En la siguiente ventana planificada |

3. **Contener** con el playbook de §2.2. Primero cortar el acceso, después investigar: cortar es reversible (suspender, revocar) y la investigación puede tardar.
4. **Conservar la evidencia** antes de cambiar nada que la borre:
   - el rango de la bitácora (Consola → Auditoría, exportar con los filtros del incidente);
   - los logs de los componentes involucrados (`dc logs --since <hora> <servicio> > archivo`);
   - el estado de sincronía (Consola → Sincronía).
5. **Recuperar** y comprobar con `OPERATIONS.md §2.2` (comprobación de punta a punta).
6. **Cerrar** con un informe: línea de tiempo, causa, qué se hizo, a quién se avisó y qué cambia para que no se repita. Si hubo datos personales, el responsable de datos de la entidad proveedora decide el aviso a los titulares según el marco legal del país.

### 2.2 Playbooks

| Incidente | Contener | Recuperar |
| :-- | :-- | :-- |
| **Clave privada de una aplicación filtrada** (su certificado de cliente) | El desarrollador de la aplicación revoca el certificado (Mis aplicaciones → la aplicación). Si la entidad no responde: revocación masiva filtrada por la entidad y la fecha de emisión (§4), o suspender las suscripciones de la aplicación como operador | La aplicación emite un certificado nuevo con una clave nueva |
| **Secreto de cliente filtrado** | El desarrollador rota el secreto y revoca el anterior (Mis aplicaciones → Credenciales). Un secreto solo no basta para llamar si la red exige mTLS: el token queda ligado al certificado | — |
| **Entidad comprometida** (varias aplicaciones, o no se sabe cuáles) | Suspender la entidad (§1.3) y revocar en masa sus certificados (§4) | Reactivar cuando la entidad confirme que limpió su entorno; sus aplicaciones emiten certificados nuevos |
| **Cuenta de usuario comprometida** | En la consola de administración de Keycloak (realm `rid-portal`): deshabilitar al usuario y cerrar sus sesiones. El administrador de la entidad le quita los roles si corresponde (Mi entidad, miembros). Si el aviso fue un enrolamiento de segundo factor que el dueño no hizo (correo de Keycloak, M3-08): borrar ese segundo factor en Keycloak | El dueño restablece su contraseña y enrola su segundo factor de nuevo |
| **Nodo de una entidad comprometido** | Dar de baja el nodo: el administrador de la entidad en Mi entidad → Nodos, o el operador por el API (`POST /api/v1/entities/{entityId}/nodes/{nodeId}/decommission`). El gateway deja de enrutarle y su certificado deja de valer para el canal de control | Instalar el kit en un servidor limpio y enrolarlo con un token nuevo |
| **Datos personales en un log** (un número de identificación, un cuerpo de respuesta) | Detener la fuente. Borrar lo escrito: el índice de OpenSearch afectado, los archivos o la salida del colector | Corregir el enmascarado y agregar una prueba de regresión (`tests/infra`, regla 2 de CLAUDE.md) |
| **Gateway caído** | `dc ps apisix opa etcd`; `dc logs apisix opa`. OPA sin bundle niega todo: ver `OPERATIONS.md §7` | Reiniciar el componente (`OPERATIONS.md §5.1`); comprobar con una llamada de prueba |
| **Portal caído** (API o web) | El gateway sigue atendiendo con su última configuración y OPA con su último bundle (M6-04). Lo nuevo (aprobaciones, revocaciones) espera | Reiniciar el API; los reconciliadores alcanzan el estado de la base solos |
| **Cadena de auditoría con error** (Consola → Auditoría → Verificar integridad) | Exportar la bitácora y los anclajes; no tocar la base | Restaurar la base a un instante anterior a la alteración (`OPERATIONS.md §6`) y comparar con la exportación para saber qué cambió |
| **Base de datos dañada o borrado por error** | Detener el API | `sudo ./install.sh restore [instante]` (`OPERATIONS.md §6`) |
| **Clave privada de la CA intermedia comprometida** | §3.3 | §3.3 |
| **Clave de firma de la aserción del gateway comprometida** (M6-10) | Rotarla como comprometida: `POST /api/v1/admin/gateway-signing-keys/rotate` con `{"compromised": true, "reason": "…"}` (`platform_admin`). El gateway firma con la nueva desde la siguiente pasada del reconciliador, en segundos; la anterior sale del JWKS | Avisar a los proveedores: lo que firmó la clave comprometida ya no verifica, y quien lo archivó debe saber desde cuándo dejó de ser confiable (la fecha está en la bitácora, `gateway_signing_key.created`) |
| **Nodos del gateway agregados o quitados** (no es un incidente, pero altera los límites) | — | Ajustar `RID_GATEWAY_NODES` (en el chart, sale de `gateway.replicas`): cada nodo cuenta los límites por su lado y el bundle le da a cada uno su parte (ADR-0020) |

## 3. Rotación de la CA intermedia

La red tiene una raíz (fuera de línea en producción) y una intermedia, con la que step-ca firma los certificados de las aplicaciones, de los nodos y del gateway. Cambiar la intermedia no cambia la raíz: lo que ya se emitió sigue siendo válido, porque encadena a la misma raíz.

Qué protege a la red además de la cadena:
- **Aplicaciones:** el gateway solo acepta las huellas de los certificados que el portal emitió y siguen vigentes (lista de OPA). Un certificado fabricado con otra intermedia, o con una robada, no está en la lista.
- **Nodos del kit:** el portal ata cada nodo a la huella de su certificado en el canal de control.
- **El gateway frente a las aplicaciones:** aquí sí cuenta solo la cadena. Las aplicaciones confían en la raíz de la red para verificar el certificado de servidor del gateway.

### 3.1 Rotación planificada: piloto (Compose)

La CA de desarrollo guarda la raíz, la intermedia y sus claves en el volumen `step-ca-data`.

1. Respaldo (`sudo ./install.sh backup`): incluye el volumen de la CA.
2. Crear la intermedia nueva con la raíz y dejar la anterior al lado:

   ```bash
   dc exec step-ca sh -c 'cd /home/step &&
     step certificate create "RID Dev CA Intermediate CA $(date +%Y-%m)" \
       certs/intermediate_ca.next.crt secrets/intermediate_ca_key.next \
       --profile intermediate-ca --ca certs/root_ca.crt --ca-key secrets/root_ca_key \
       --ca-password-file secrets/password --password-file secrets/password --not-after 43800h &&
     mv certs/intermediate_ca.crt certs/intermediate_ca.previous.crt &&
     mv secrets/intermediate_ca_key secrets/intermediate_ca_key.previous &&
     mv certs/intermediate_ca.next.crt certs/intermediate_ca.crt &&
     mv secrets/intermediate_ca_key.next secrets/intermediate_ca_key &&
     step certificate fingerprint certs/intermediate_ca.crt'
   dc restart step-ca
   ```

   La huella que imprime es la de la intermedia nueva (SHA-256), la misma que muestra la revocación masiva (§4).
3. Reemitir los certificados del gateway con la intermedia nueva, para que su cadena y la lista de CA que acepta (`client.ca`) la incluyan: borrar sus filas y reiniciar el API (`OPERATIONS.md §5.6`).
4. Comprobar:
   - una aplicación de prueba emite un certificado nuevo y su emisor es la intermedia nueva;
   - una llamada con un certificado anterior sigue pasando.

   Las aplicaciones deben presentar la cadena completa, como la entrega el portal al emitir: con solo el certificado, el gateway no puede encadenarlo a la raíz.
5. Los certificados de la intermedia anterior se reemplazan solos al vencer: los nodos los renuevan antes de vencer, y las aplicaciones reciben el aviso de vencimiento. Para no esperar, se pueden revocar en masa por emisor (§4) cuando las aplicaciones hayan emitido los nuevos.

### 3.2 Rotación planificada: Kubernetes

La raíz no está en el clúster. La intermedia y su clave viven en el Secret `stepCa.pkiSecret`.

1. Con la raíz fuera de línea, en la máquina de la ceremonia de la CA: crear la intermedia nueva (`step certificate create ... --profile intermediate-ca`, como en §3.1) y cifrar su clave con `RID_STEP_CA_PROVISIONER_PASSWORD`.
2. Reemplazar `intermediate_ca.crt` e `intermediate_ca_key` en el Secret (en el almacén de secretos, si lo sincroniza External Secrets).
3. `kubectl -n rid rollout restart statefulset/rid-step-ca`. En cada arranque, step-ca toma la PKI del Secret.
4. Seguir con los pasos 3 a 5 de §3.1.

### 3.3 Intermedia comprometida (emergencia)

Quien tiene la clave de la intermedia puede emitir certificados que encadenan a la raíz.

1. **Contener:** rotar la intermedia ya (§3.1 o §3.2) y reemitir los certificados del gateway. Desde ese momento step-ca emite solo con la nueva.
2. **Revocar en masa** todo lo emitido por la intermedia comprometida (§4, filtro por emisor). Avisar a las entidades para que emitan certificados nuevos, y a los nodos para que se renueven.
3. **Evaluar** lo que la lista de huellas no cubre: un atacante con la intermedia y una posición en la red podría hacerse pasar por el gateway ante las aplicaciones. El gateway no consulta listas de revocación (CRL) de intermedias. Si el riesgo es real, la salida completa es una raíz nueva:
   - ceremonia de una raíz y una intermedia nuevas;
   - distribuir la raíz nueva a las aplicaciones y a los nodos;
   - fijar su huella en el portal (`RID_STEP_CA_ROOT_FINGERPRINT` o `stepCa.rootFingerprint`);
   - reemitir todo.

   Se planifica con las entidades, porque cada aplicación cambia su confianza.
4. **Si la comprometida es la raíz:** el mismo plan de raíz nueva, de inmediato.

## 4. Revocación masiva de certificados

Consola → Revocación masiva de certificados (`/operator/certificates`), solo `platform_admin`.

1. **Filtrar:**
   - por entidad;
   - por fecha de emisión (desde, hasta; días en UTC);
   - por la CA intermedia que los emitió (en la tabla de intermedias, "Solo los de…").

   Se combinan todos. Sin filtros, se revocan todos los certificados vigentes de la red: el portal lo advierte.
2. **Revisar la vista previa:** cuántos certificados, de cuántas entidades y aplicaciones.
3. **Revocar:** con un motivo (queda en la bitácora de cada certificado, sin datos personales) y la confirmación del número. Si mientras tanto alguien emitió o revocó un certificado de ese conjunto, no se revoca nada y hay que volver a ver la vista previa.

Efecto:
- cada certificado pasa a `revoked` y el gateway lo rechaza con el siguiente bundle de OPA, en menos de 60 segundos;
- los desarrolladores de cada aplicación reciben un aviso, también por correo, que no se puede desactivar;
- la bitácora tiene un `credential.revoked` por certificado, con el motivo y el identificador de la revocación, y un `certificate_revocation.executed` con los filtros y el total.

No se puede deshacer: cada aplicación emite un certificado nuevo desde su ficha. Los secretos de cliente no entran en la revocación masiva; los rota cada aplicación (§2.2).

Por API: `GET /api/v1/admin/certificate-revocations/preview` y `POST /api/v1/admin/certificate-revocations` con `expectedCount` (la referencia está en `/api/docs`).
