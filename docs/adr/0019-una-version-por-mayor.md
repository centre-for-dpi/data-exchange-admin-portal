# ADR-0019 — Una versión por mayor; los cambios compatibles son revisiones en sitio

- Estado: Aceptado
- Fecha: 2026-11-13

## Contexto
Cada versión tiene su ruta en el gateway en `/{entidad}/{api}/v{mayor}`, y las suscripciones se atan al id de la versión (`apiVersionId`). SPEC.md §4.2 pide dos cosas:
- que una versión publicada admita cambios compatibles (descripciones, operaciones nuevas opcionales);
- que un cambio incompatible exija una versión mayor nueva.

Si la `1.1` fuera una fila nueva junto a la `1.0` ya publicada, habría dos rutas con el mismo prefijo `/v1`. Además, las suscripciones de la `1.0` tendrían que migrarse o volver a aprobarse por un cambio que, por definición, no les afecta.

## Decisión
1. **Una fila por versión mayor.** Mientras una mayor no esté retirada, no se crea otra versión con la misma mayor.
2. **Cambio compatible = revisión en sitio.** El proveedor actualiza el OpenAPI de la versión publicada. El portal lo valida con el lint RID y con una comprobación de compatibilidad contra el documento vigente. Si pasa:
   - sube la menor (`1.0 → 1.1`) sobre la misma fila, con el mismo id, la misma ruta y las mismas suscripciones;
   - el documento anterior queda en `api_version_revision`;
   - el gateway y el bundle de OPA se resincronizan.

   Las operaciones nuevas no se conceden a las suscripciones existentes: cada suscripción guarda sus `approvedOperations`.
3. **Incompatible = mayor nueva.** La mayor nueva pasa por revisión completa (operador y, si aplica, regulador) y convive con la anterior en `/v{mayor+1}`.
4. **Retiro con aviso.**
   - El proveedor marca la versión `deprecated` con una fecha de retiro que respeta el aviso mínimo `lifecycle.apiRetirementNoticeDays` de la config del país.
   - Mientras está deprecada, el gateway responde con `Deprecation` (RFC 9745) y `Sunset` (RFC 8594), y no se aceptan solicitudes de acceso nuevas.
   - Al llegar la fecha, un trabajo del API la pasa a `retired`. El reconciliador quita la ruta, y las suscripciones vivas se revocan (las pendientes se rechazan), todo auditado.

## Alternativas consideradas
- **Una fila por menor con traslado de suscripciones.** Duplica rutas o exige migrar suscripciones en cada cambio menor. Se descarta.
- **Volver a revisar cada cambio compatible con el operador.** La comprobación de compatibilidad ya impide los cambios que afectan a los consumidores, y los datos expuestos y la base legal no cambian en una revisión. Si un país lo exige, se puede agregar como opción de configuración.

## Consecuencias
- El "1.1" no es un objeto aparte: es la revisión vigente de la mayor 1. El historial de revisiones queda guardado y auditado.
- La comprobación de compatibilidad es propia y conservadora. Bloquea:
  - quitar operaciones o cambiar su `operationId`;
  - parámetros nuevos obligatorios, o parámetros que pasan a obligatorios o se quitan;
  - cuerpos que pasan a obligatorios;
  - propiedades que se quitan o cambian de tipo en respuestas 2xx;
  - cambios en la declaración del titular (`x-rid-data-subject`) o en la seguridad.
- Los avisos a los consumidores (deprecación, retiro próximo) llegan con M2-08.
