# ADR-0015 — Transparencia para el titular: registro de consultas por titular seudonimizado

- Estado: Aceptado
- Fecha: 2026-11-12
- Precisa: ADR-0006 (sigue vigente: no se guarda contenido ni rutas)
- Precisado por: ADR-0017 (el titular en el cuerpo lo lee el gateway; la cabecera `X-RID-Data-Subject` declarada por el consumidor queda descartada)

## Contexto

El ciudadano no tiene forma de saber qué entidad consultó sus datos, cuándo ni para qué. En Colombia la mayoría de los intercambios entre entidades públicas no requieren su autorización (Ley 1581 de 2012, art. 10, literal a), así que el control proporcional no es el consentimiento sino la **transparencia**. Es el modelo que ya funciona en otros países:

- Estonia: Data Tracker (Andmejälgija), desde 2017, sobre X-Road.
- Ucrania: el subsistema de monitoreo de accesos sobre Trembita, que en 2026 agrega avisos y una vía de reclamo.

La vitrina natural para el ciudadano es la **Carpeta Ciudadana Digital**, que ya tiene autenticación digital. La construye y opera el equipo de la Carpeta, no este repositorio.

Hoy el gateway sabe quién consulta, qué operación y para qué, pero **no de quién son los datos**. ADR-0006 prohíbe, con razón, registrar la ruta real, que es donde suele ir el número de identificación.

## Decisión

1. **El titular se declara en el OpenAPI.** Cada operación de una API `personal` o `sensitive` indica con `x-rid-data-subject` dónde está el titular:
   - un parámetro de ruta;
   - la cabecera `X-RID-Data-Subject`, cuando el identificador viaja en el cuerpo;
   - o `none` explícito, para operaciones sin titular, como las agregadas.

   El tipo de documento es fijo por operación o, si no se indica, el primero de `identifiers.person` en la configuración del país. Una regla de lint lo exige al publicar.
2. **OPA calcula el seudónimo**: `ref = HMAC-SHA-256(clave de titulares, país | tipo | número normalizado)`, y lo devuelve como cabecera `X-RID-Subject-Ref`. El número nunca sale del camino de la petición: no llega a logs, búferes ni bases. Hay dos casos de error:
   - si una operación declara titular y la petición no lo trae, se niega con `403 data_subject_required`;
   - la cabecera `X-RID-Data-Subject` en claro se elimina antes del proveedor, con el mismo mecanismo que `X-RID-End-User`.
3. **Registro de consultas por titular.** El camino es APISIX `tcp-logger` (con un formato propio que incluye la referencia) → Fluent Bit (con búfer en disco y reintentos) → colector del API del portal → tabla de solo inserción `subject_access_record`. Va separado de los logs de analítica, que siguen sin titular. Solo se registran llamadas autorizadas por OPA.
4. **API para el titular.** `GET /api/v1/data-subjects/me/accesses` solo acepta el token del ciudadano emitido por el proveedor de identidad nacional (en desarrollo, el realm `rid-citizens`) y solo desde aplicaciones ciudadanas autorizadas (la Carpeta). El portal deriva la referencia del documento verificado en el token; **nunca recibe el número como parámetro**.
5. **Avisos.** El ciudadano los activa desde la Carpeta. El portal avisa a la Carpeta con un webhook firmado que lleva un identificador opaco, sin número ni datos de contacto, y es la Carpeta quien notifica.
6. **Retención** configurable con `retention.subjectAccessMonths`, por defecto 60 meses, alineada con la bitácora de auditoría.

La regla de oro 2 se precisa así: seguimos sin guardar contenido ni rutas reales, y ahora se guarda **de quién** fue cada consulta, solo como seudónimo con clave y en un almacén dedicado.

## Alternativas consideradas

- **Registrar la ruta y seudonimizar después, en el colector.** No: el número viajaría por Fluent Bit y quedaría en sus búferes en disco.
- **Que la Carpeta consulte pasando el número como parámetro.** No: bastaría una falla o un abuso en la Carpeta para ver las consultas de cualquier persona.
- **Hash sin clave (SHA-256 del número).** No: los números de documento son un espacio pequeño y se revierten por fuerza bruta.
- **Modelo distribuido de Estonia, donde cada registro expone sus propios logs.** Es el modelo para cubrir X-Road en la siguiente versión. Para el tráfico que pasa por el gateway, el gateway es la fuente natural.

## Consecuencias

- El ciudadano ve las consultas que pasan por el gateway. Queda la base para la versión que cubra X-Road y para el consentimiento (capa 2).
- **Activo sensible.** El operador custodia la clave de titulares y el registro por titular, lo que conlleva riesgo de vigilancia. Mitigaciones:
  - solo el titular accede, a través del API;
  - la clave vive fuera de la base (variable de entorno en desarrollo, gestor de secretos libre en producción);
  - el acceso administrativo auditado queda pendiente.
- **El proveedor recibe `X-RID-Subject-Ref`**, porque el plugin `opa` reenvía las cabeceras que devuelve la política. Es el seudónimo de una persona que el proveedor ya identifica y no le da acceso a nada; un plugin propio podría quitarlo más adelante.
- **Titular en el cuerpo.** El gateway no lee cuerpos, así que no puede comprobar que la cabecera coincide con el cuerpo. Debe verificarlo el proveedor (se agrega al contrato del kit, ARCHITECTURE §10). Riesgo residual: un consumidor que declare otro titular.
- **Completitud.** Si el pipeline pierde un registro, el ciudadano no ve esa consulta. Lo mitigan el búfer en disco y los reintentos; la detección de huecos, contrastando con las métricas por ruta, queda pendiente.
- **Fuera de esta versión:** consultas por X-Road, intentos rechazados, reclamos y consentimiento.
