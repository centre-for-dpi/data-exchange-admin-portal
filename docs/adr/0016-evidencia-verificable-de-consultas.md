# ADR-0016 — Evidencia verificable de las consultas: lotes Merkle firmados y con sello de tiempo

- Estado: Aceptado
- Fecha: 2026-11-12

## Contexto

Para que la transparencia (ADR-0015) sirva en una disputa hacen falta dos garantías:

- poder **probar** que una consulta ocurrió: quién consultó, qué operación, cuándo y para qué;
- que **nadie, ni siquiera el operador**, pueda alterar o borrar el registro sin que se note.

X-Road lo resuelve firmando cada mensaje y sellando por lotes: un árbol hash por lote y un solo sello de tiempo de una TSA para todo el lote. Nosotros no guardamos contenido (ADR-0006), así que la evidencia es sobre los metadatos de la consulta.

## Decisión

1. **Árbol de Merkle por lote.** El colector agrupa los registros en lotes, cada N registros o cada T segundos, y construye un árbol de Merkle por lote con las reglas de RFC 9162:
   - hoja = SHA-256(0x00 ‖ JSON canónico del registro);
   - nodo = SHA-256(0x01 ‖ izquierdo ‖ derecho).
2. **Punto de control por lote.** Contiene `{desde, hasta, raíz, hash del punto anterior, fecha}`, va firmado por el operador (JWS EdDSA, con la clave pública en un JWKS) y lo sella una **TSA RFC 3161 independiente**. En desarrollo la TSA es un contenedor de sigstore timestamp-authority (Apache-2.0); en producción, una TSA acreditada del país.
3. **Anclaje en la bitácora.** Cada punto de control se anota también en la bitácora de auditoría encadenada (`transparency.checkpoint`). Alterar uno exigiría romper las dos cadenas, y M2-09 ancla la bitácora a diario.
4. **Comprobante de una consulta.** Reúne el registro, su ruta de inclusión en el árbol, el punto de control firmado y el sello de la TSA. Cualquiera puede verificarlo **sin confiar en el portal**, con un verificador abierto (`packages/transparency-verifier`, también como CLI) que usa la clave pública del operador y el certificado de la TSA.
5. **Alcance de la prueba.** El comprobante prueba que la consulta ocurrió, **no qué datos se entregaron**: no se guarda una huella del contenido.

## Alternativas consideradas

- **Guardar los mensajes completos firmados, como X-Road.** No: contradice la regla de oro 2.
- **Huella con clave del contenido de la respuesta.** Descartada en esta versión: no se quiere probar el contenido, y además obligaría a leer el cuerpo en el gateway.
- **Una cadena de hash por registro, como la bitácora de auditoría.** No escala: serializaría cada consulta de la red.
- **Un log de transparencia completo, al estilo Certificate Transparency** (Trillian, Rekor), con pruebas de consistencia. Es más fuerte, pero exige mucha más infraestructura. Los lotes encadenados detectan alteraciones y borrados con mucho menos, y la migración sigue siendo posible.
- **Firma del consumidor en cada petición** (HTTP Message Signatures, RFC 9421). Fuera de esta versión: el no repudio del consumidor se apoya en su token y, desde M3, en mTLS.

## Consecuencias

- Una alteración o un borrado se detectan, y un tercero puede verificar la prueba con material público.
- **Riesgo residual: omisión en el origen.** El operador podría no registrar una consulta. Se mitiga contrastando con las métricas por ruta y, en el futuro, con recibos del proveedor.
- **Gestión de la clave de firma:** rotación y JWKS con `kid`, para que los comprobantes antiguos sigan verificándose.
- **Dependencia de la TSA.** Si no responde, el lote queda pendiente de sello y se reintenta; el registro no se pierde.
