# ADR-0005 — Autorización del tráfico en OPA con bundle publicado por el portal

- Estado: Aceptado
- Fecha: 2026-11-11

## Contexto
Cada llamada debe verificar suscripción activa, operación, finalidad, vigencia y, a veces, el funcionario final. La revocación debe propagarse en menos de 60 s y el tráfico no puede depender de que el portal esté arriba.

## Decisión
El token de Keycloak solo prueba la identidad de la aplicación. La decisión la toma **OPA** (plugin `opa` de APISIX) con datos que el portal publica como **bundle** (`data.json` + Rego), descargado por OPA cada 10–20 s.

## Alternativas consideradas
- Scopes de Keycloak por API: no expresa finalidad ni operación, la revocación depende de la expiración del token y obliga a reconfigurar clientes en cada aprobación.
- Consumers de APISIX con ACL: no modela finalidad; mezcla gobierno con configuración del gateway.

## Consecuencias
- Revocación casi inmediata y reglas testeables con `opa test`.
- Si el portal cae, OPA mantiene el último bundle.
- Hay que confirmar la interacción de las cabeceras de OPA con otros plugins (SPIKE S-1).
