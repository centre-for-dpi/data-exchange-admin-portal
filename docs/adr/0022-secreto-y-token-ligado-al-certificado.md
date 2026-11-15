# ADR-0022 — Aplicaciones con secreto y token ligado al certificado, pedido al gateway

- Estado: Aceptado
- Fecha: 2026-11-15

## Contexto
Con `features.mtls.required` (ADR-0010, M3-10), una aplicación consumidora presenta su certificado de cliente, emitido por step-ca (M3-01), y su token queda ligado a ese certificado (RFC 8705, `cnf.x5t#S256`).

La SPIKE S-4 mostró dos formas de autenticar la aplicación ante Keycloak:
- solo con el certificado (`client-x509`, `tls_client_auth`), que fue la recomendada;
- con el secreto y el token ligado al certificado presentado.

También mostró que, detrás de un proxy, Keycloak cree en la cabecera `SSL_CLIENT_CERT`. Si alguien llega a Keycloak por otra vía con esa cabecera inventada, Keycloak la acepta.

Mientras tanto, M3-04 construyó la rotación del secreto, con ventana y revocación.

## Decisión
- **La aplicación se autentica con su secreto y el token se liga al certificado.** El cliente de Keycloak lleva `tls.client.certificate.bound.access.tokens = true` mientras la red exija mTLS; lo aplica el reconciliador. No se usa `client-x509`.
- **El token se pide al gateway**, en `POST <gateway>/oauth/token`: el mismo nombre y el mismo TLS de las llamadas (montaje B de S-4).
  - APISIX verifica el certificado en el handshake y reenvía al endpoint de tokens de `rid-gateway`, con `SSL_CLIENT_CERT` (`$ssl_client_escaped_cert`) y `ssl-client-verify` (`$ssl_client_verify`).
  - Esas dos cabeceras siempre se reescriben y las otras grafías se borran, así que el cliente no las elige.
  - Keycloak usa el proveedor x509 `nginx` con `trust-proxy-verification`.
- **OPA sigue siendo quien decide en cada llamada.** Exige el certificado y que el token esté ligado a él (`token_not_bound`, `certificate_mismatch`), y comprueba que la huella sea de esa aplicación y esté vigente (`certificate_revoked`, S-3).
- La raíz de la red se publica en `GET /api/v1/pki/ca`, y la web la ofrece en la guía de la aplicación. Con ella, la aplicación confía en el certificado del gateway, que también emite step-ca.

## Alternativas consideradas
- **`client-x509` (recomendada por S-4):** el certificado es la única credencial, y el secreto sobra.
  - Pero entonces una cabecera `SSL_CLIENT_CERT` inventada que llegue a Keycloak por otra vía **autentica** a la aplicación: basta su certificado público, que no es secreto. La seguridad de toda la red quedaría en que ninguna otra vía hacia Keycloak deje pasar esa cabecera.
  - Además, la rotación del secreto de M3-04 dejaría de tener sentido justo al activar mTLS.
- **Terminar en Keycloak el TLS de las aplicaciones (montaje A de S-4):** obliga a publicar Keycloak con su propio TLS y certificado de cliente, y el selector de certificados aparece también en el inicio de sesión del portal.

## Consecuencias
- Para obtener un token hacen falta el secreto y la clave privada del certificado. Para usarlo hace falta la misma clave. Una cabecera inventada hacia Keycloak, a lo sumo, liga un token a un certificado cuya clave el atacante no tiene: el gateway lo rechaza en el handshake o con `certificate_mismatch`.
- Igual, toda otra vía hacia Keycloak borra `SSL_CLIENT_CERT` y `ssl-client-verify`. En el piloto lo hace el middleware del proxy en `/auth` (`DEPLOYMENT.md §5.2`).
- La revocación de un certificado no pasa por Keycloak, que no consulta CRL ni OCSP. El portal lo quita del bundle y OPA niega en menos de un minuto. Keycloak puede seguir emitiendo tokens ligados a ese certificado, pero no sirven.
- Sin mTLS (otro país, o `mtls.required: false`), la misma ruta de token entrega tokens sin ligar: las aplicaciones usan siempre la misma URL.
