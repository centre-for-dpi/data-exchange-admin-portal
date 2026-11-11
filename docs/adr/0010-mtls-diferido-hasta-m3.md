# ADR-0010 — mTLS de aplicaciones diferido hasta M3 (el requisito se mantiene)

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
`SPEC.md §4.3` y `ARCHITECTURE.md §3.2` exigen que, con `features.mtls.required`, las aplicaciones consumidoras se autentiquen con certificado de cliente emitido por step-ca y que sus tokens queden ligados al certificado (RFC 8705). La implementación está planificada en M3 (SPIKE S-3, S-4 y M3-01 a M3-04). La configuración de Colombia (`co.yaml`) tenía `mtls.required: true`, pero en M1 y M2 nada lo implementa: la demo de M1 (`DEMO.md`, paso 7) obtiene el token solo con `client_id` y secreto.

## Decisión
- **El mTLS de aplicaciones sigue siendo un requisito** del producto y del despliegue de Colombia. No se elimina de la especificación ni del backlog.
- Hasta cerrar M3, `config/country/co.yaml` usa `features.mtls.required: false`, con un comentario que remite a este ADR. Así la configuración refleja lo que el sistema realmente aplica y la demo de M1 funciona sin certificados.
- La historia **M3-10** vuelve a poner `features.mtls.required: true` en `co.yaml` y actualiza `DEMO.md` y las pruebas e2e para usar mTLS. M3 no se cierra sin ella.
- El código que se escriba antes de M3 debe leer el flag (no asumir que mTLS está apagado), para que activarlo no requiera cambios de diseño.

## Alternativas consideradas
- **Dejar `true` e ignorarlo hasta M3:** la configuración afirmaría un control de seguridad que no existe; es engañoso para el operador y el regulador.
- **Adelantar mTLS a M1:** pone en riesgo la demo de fin de noviembre; depende de dos spikes (S-3, S-4) aún abiertos.

## Consecuencias
- En M1 y M2 las aplicaciones se autentican con `client_credentials` y secreto; la revocación sigue siendo efectiva vía OPA.
- El riesgo de un secreto filtrado no está mitigado por certificado hasta M3; aceptable porque M1–M2 corren solo con datos sintéticos.
- `example.yaml` mantiene `mtls.required: true` como valor recomendado para nuevos países.
