# ADR-0024 — El gateway firma una aserción por llamada hacia el proveedor

- Estado: Aceptado
- Fecha: 2026-11-16

## Contexto

El proveedor recibe en cabeceras quién consulta, para qué y con qué suscripción (`ARCHITECTURE.md §6`). Las cabeceras no prueban nada después: si un proveedor o un consumidor discute una consulta, la red no tiene un documento firmado que el proveedor haya podido conservar. La mTLS hacia el proveedor (M3-03) autentica al gateway en el transporte, pero no deja una prueba por llamada. El SPIKE S-6 (`docs/spikes/S-6.md`) probó cómo hacerlo.

## Decisión

El gateway firma una aserción por llamada y el proveedor la recibe en `X-RID-Assertion`:
- **Formato:** JWS compacto ES256 con lo que el gateway avala (consumidor, aplicación, suscripción, finalidad, operación, hash del funcionario y referencia del titular).
- **Ligada a la petición:** por el método y el SHA-256 de la URI que recibe el proveedor, con `aud` = la entidad proveedora y `jti` = el request id del gateway.
- **Quién firma:** el plugin `rid-assertion` de APISIX, después de OPA.
- **La clave:** el portal la genera, la guarda sellada, la entrega en la metadata del plugin (cifrada en etcd con el keyring propio del despliegue) y la rota. Publica las claves públicas en un JWKS.
- **Fallo cerrado:** sin clave, el gateway falla cerrado.

## Alternativas consideradas

- **Firmar en OPA.** La clave privada viajaría en el bundle y quedaría en cada OPA y en su caché. Además, la política no conoce la URI final que recibe el proveedor.
- **Solo mTLS.** No deja prueba por llamada.
- **HTTP Message Signatures (RFC 9421).** Hoy tiene poco soporte en las librerías de las entidades; queda como evolución.

## Consecuencias

- Las entidades pueden conservar una prueba firmada de cada consulta. Se enlaza con el comprobante del titular por el mismo request id (ADR-0016).
- **Costo:** unos 870 bytes y decenas de microsegundos por llamada.
- **Proveedor:** tiene que verificar firma, `aud`, `exp` y `uri_sha256`, y mantener el JWKS en caché (la guía del proveedor debe explicarlo).
- **Keyring:** el despliegue tiene que configurar su propio `data_encryption.keyring` de APISIX (M6-01). Sin él, el cifrado en reposo de la clave usa un valor público.
- **Pendiente:** la implementación en producción (reconciliación de la clave, JWKS, activación por red o por versión, `body_sha256` para operaciones con cuerpo, verificación en los mocks) es la historia M6-10.
