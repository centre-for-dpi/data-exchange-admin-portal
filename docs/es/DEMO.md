# Guion de demo — Hito M1 (fin de noviembre)

> English version (official): [docs/DEMO.md](../DEMO.md)

Duración: 15 minutos. Todo corre en local con `pnpm infra:up && pnpm dev`. Todos los datos son ficticios.

**Ensayo automático:** `pnpm demo` ejecuta los 10 pasos contra el stack local con los mismos personajes. Cada uno inicia sesión en Keycloak como lo haría en la web. El script narra cada paso y termina con código 1 si algo no se comporta como dice este guion. Para poder repetirse, usa una API propia por corrida (`/salud/afiliacion-<corrida>/v1`). El recorrido completo por la UI está en `apps/web/e2e/demo.spec.ts`.

## Personajes (usuarios semilla en Keycloak, contraseña `den-demo-password` solo en desarrollo, o la de `DEN_DEMO_USER_PASSWORD`)

| Usuario | Entidad | Rol |
| :-- | :-- | :-- |
| `ana.operadora` | Operador (AND) | `platform_reviewer` |
| `pedro.publicador` | Entidad de Salud (ficticia) | `api_publisher` |
| `lucia.datos` | Entidad de Salud (ficticia) | `data_steward` |
| `carlos.dev` | Entidad de Programas Sociales (ficticia) | `app_developer` |
| `marta.regulador` | Regulador (MinTIC) | `regulator` |
| `ciudadana.demo` | Titular de los datos (CC 1000000001), en la Carpeta de referencia; realm `den-citizens` | — |

**Segundo factor (M3-08).** `ana.operadora`, `lucia.datos` y `marta.regulador`, como todo rol de plataforma y `data_steward`, entran con la contraseña y después con un código de un solo uso. `pnpm demo:otp` imprime el código vigente. Para mostrarlo con un teléfono, agrega en una app autenticadora la clave que imprime el mismo comando (TOTP, SHA-1, 6 dígitos, 30 s). Cada código sirve una sola vez; si ya se usó, espera al siguiente.

## Pasos

1. **Publicar** (pedro.publicador): crear la API "Consulta de afiliación", identificador en la URL `afiliacion`, subir `infra/mock-providers/salud/openapi.yaml`, upstream = nodo de prueba con ruta del servicio `/salud` (en desarrollo, el mock de salud según `DEN_DEV_NODES`), clasificación `personal`, finalidad permitida `eligibility_check`. Enviar a revisión.
2. **Revisar** (ana.operadora): ver ficha y campos expuestos, aprobar. Mostrar que la ruta aparece en APISIX en segundos, sin intervención manual: una llamada sin token al puerto HTTP del gateway local (`http://localhost:9080/salud/afiliacion/v1/afiliados/1000000001`) da `401`.
3. **Descubrir** (carlos.dev): buscar en el catálogo, ver documentación interactiva.
4. **Credenciales** (carlos.dev): crear la aplicación "Validador de subsidios" y copiar el secreto (se muestra una sola vez). Esperar a que la ficha diga "Lista".
   - La red exige mTLS (M3-10). En "Certificado de cliente (mTLS)", generar la clave y la CSR con el comando que muestra la ficha. La clave no sale del servidor de carlos. Pegar la CSR y descargar el certificado.
   - Descargar también la raíz de la red desde la guía de integración (`den-network-ca.pem`).
   - Con token pero sin suscripción, la llamada da `403 no_subscription`.
5. **Solicitar** (carlos.dev): pedir acceso con finalidad `eligibility_check` y detalle "Verificar afiliación al asignar el subsidio X".
6. **Aprobar** (lucia.datos): ver la solicitud en su bandeja, aprobar con vigencia de 6 meses. La ficha de carlos pasa de "Aprobada (activándose)" a "Activa" cuando OPA descarga el bundle (segundos).
7. **Llamar** (terminal):
   ```bash
   TLS="--cert $CLIENT_ID.pem --key $CLIENT_ID.key --cacert den-network-ca.pem"
   TOKEN=$(curl -s $TLS -d grant_type=client_credentials -u "$CLIENT_ID:$CLIENT_SECRET" \
     https://localhost:9443/oauth/token | jq -r .access_token)
   curl -s $TLS https://localhost:9443/salud/afiliacion/v1/afiliados/1000000001 \
     -H "Authorization: Bearer $TOKEN" -H "X-DEN-Purpose: eligibility_check" \
     -H "X-DEN-End-User: funcionario-42"
   ```
   El token se pide al gateway y queda ligado al certificado (`cnf.x5t#S256` en el token: se ve en jwt.io o con `cut -d. -f2 <<<"$TOKEN" | base64 -d`). Sin `--cert` no hay sesión TLS con el gateway. Con el token y el certificado de otra aplicación, la respuesta es `403 certificate_mismatch`.

   Respuesta 200. La API es de datos personales, así que el gateway exige identificar al funcionario (`X-DEN-End-User`); sin esa cabecera responde `403 end_user_required`. Mostrar en el mock del proveedor las cabeceras `X-DEN-*` recibidas: `docker logs den-mock-salud-1 --since 1m`. Llegan la suscripción, la operación, la entidad y la aplicación que puso el gateway, y solo el hash del funcionario, nunca su identificación en claro.
8. **Finalidad incorrecta**: repetir con `X-DEN-Purpose: benefit_targeting` → `403 purpose_not_allowed`. La respuesta es problem+json y lleva la razón en `X-DEN-Deny-Reason`.
9. **Revocar** (lucia.datos): revocar la suscripción con un motivo; repetir la llamada en un bucle y ver cómo pasa a `403 no_subscription` en menos de 60 s (en local, unos 10–20 s):
   ```bash
   while true; do curl -s $TLS -o /dev/null -w "%{http_code} " https://localhost:9443/salud/afiliacion/v1/afiliados/1000000001      -H "Authorization: Bearer $TOKEN" -H "X-DEN-Purpose: eligibility_check" -H "X-DEN-End-User: funcionario-42"; sleep 1; done
   ```
   **Revocar el certificado** (carlos.dev, M3-10): en la ficha de la aplicación, "Revocar el certificado" con un motivo. Con el mismo bucle, la respuesta pasa a `403 certificate_revoked` en menos de 60 s. El certificado sigue siendo de la CA, así que el handshake pasa, pero ya no es válido para la aplicación.
10. **Auditar** (marta.regulador): en "Auditoría", abrir la suscripción desde los eventos recientes y mostrar su línea de tiempo: solicitada, aprobada, activa en el gateway, revocada, con quién y por qué. Luego pulsar "Verificar integridad" para mostrar que la cadena de hash está íntegra.
11. **¿Quién consultó mis datos?** (ciudadana.demo, en la Carpeta de referencia, `http://localhost:3100`). Para mostrar el aviso, hacer la primera parte antes del paso 7.
    - Ingresar con la identidad digital simulada (`ciudadana.demo`, documento CC 1000000001, el mismo que consulta el paso 7).
    - En "Avisos", marcar "Datos personales" y escribir un correo. El portal no conoce ese correo: solo guarda la elección y un identificador opaco.
    - Tras el paso 7, Mailpit (`http://localhost:8025`) muestra el aviso "Una entidad consultó tus datos", sin datos de la persona ni de la consulta.
    - En "¿Quién consultó mis datos?" aparece la consulta: Programas Sociales, qué API y qué datos, para "Verificación de requisitos de un trámite", con el funcionario como referencia.
    - Cuando deja de decir "En sellado" (unos segundos), pulsar "Verificar". La Carpeta comprueba por su cuenta la firma del operador, la inclusión en el lote sellado y el sello de tiempo de la TSA, sin confiar en el portal. El comprobante se puede descargar y verificar también con `den-verify-receipt`.

## Mensajes clave para la audiencia

- La entidad proveedora decide quién accede a sus datos y para qué.
- El gateway no guarda lo que responde; solo quién consultó, qué operación y con qué finalidad.
- Revocar es inmediato y queda auditado.
- Todo es open source y reutilizable.
