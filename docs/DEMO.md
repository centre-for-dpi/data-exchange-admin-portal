# Guion de demo — Hito M1 (fin de noviembre)

Duración: 15 minutos. Todo corre en local con `pnpm infra:up && pnpm dev`. Todos los datos son ficticios.

**Ensayo automático:** `pnpm demo` ejecuta los 10 pasos contra el stack local con los mismos personajes. Cada uno inicia sesión en Keycloak como lo haría en la web. El script narra cada paso y termina con código 1 si algo no se comporta como dice este guion. Para poder repetirse, usa una API propia por corrida (`/salud/afiliacion-<corrida>/v1`). El recorrido completo por la UI está en `apps/web/e2e/demo.spec.ts`.

## Personajes (usuarios semilla en Keycloak, contraseña `demo` solo en desarrollo)

| Usuario | Entidad | Rol |
| :-- | :-- | :-- |
| `ana.operadora` | Operador (AND) | `platform_reviewer` |
| `pedro.publicador` | Entidad de Salud (ficticia) | `api_publisher` |
| `lucia.datos` | Entidad de Salud (ficticia) | `data_steward` |
| `carlos.dev` | Entidad de Programas Sociales (ficticia) | `app_developer` |
| `marta.regulador` | Regulador (MinTIC) | `regulator` |

## Pasos

1. **Publicar** (pedro.publicador): crear la API "Consulta de afiliación", identificador en la URL `afiliacion`, subir `infra/mock-providers/salud/openapi.yaml`, upstream = nodo de prueba con ruta del servicio `/salud` (en desarrollo, el mock de salud según `RID_DEV_NODES`), clasificación `personal`, finalidad permitida `eligibility_check`. Enviar a revisión.
2. **Revisar** (ana.operadora): ver ficha y campos expuestos, aprobar. Mostrar que la ruta aparece en APISIX en segundos, sin intervención manual: una llamada sin token da `401`.
3. **Descubrir** (carlos.dev): buscar en el catálogo, ver documentación interactiva.
4. **Credenciales** (carlos.dev): crear la aplicación "Validador de subsidios", copiar el secreto (se muestra una sola vez). Esperar a que la ficha diga "Lista". Una llamada con token pero sin suscripción da `403 no_subscription`.
5. **Solicitar** (carlos.dev): pedir acceso con finalidad `eligibility_check` y detalle "Verificar afiliación al asignar el subsidio X".
6. **Aprobar** (lucia.datos): ver la solicitud en su bandeja, aprobar con vigencia de 6 meses. La ficha de carlos pasa de "Aprobada (activándose)" a "Activa" cuando OPA descarga el bundle (segundos).
7. **Llamar** (terminal):
   ```bash
   TOKEN=$(curl -s -d grant_type=client_credentials -u "$CLIENT_ID:$CLIENT_SECRET" \
     http://localhost:8080/realms/rid-gateway/protocol/openid-connect/token | jq -r .access_token)
   curl -s http://localhost:9080/salud/afiliacion/v1/afiliados/1000000001 \
     -H "Authorization: Bearer $TOKEN" -H "X-RID-Purpose: eligibility_check" \
     -H "X-RID-End-User: funcionario-42"
   ```
   Respuesta 200. La API es de datos personales, así que el gateway exige identificar al funcionario (`X-RID-End-User`); sin esa cabecera responde `403 end_user_required`. Mostrar en el mock del proveedor las cabeceras `X-RID-*` recibidas: `docker logs rid-mock-salud-1 --since 1m`. Llegan la suscripción, la operación, la entidad y la aplicación que puso el gateway, y solo el hash del funcionario, nunca su identificación en claro.
8. **Finalidad incorrecta**: repetir con `X-RID-Purpose: benefit_targeting` → `403 purpose_not_allowed`. La respuesta es problem+json y lleva la razón en `X-RID-Deny-Reason`.
9. **Revocar** (lucia.datos): revocar la suscripción con un motivo; repetir la llamada en un bucle y ver cómo pasa a `403 no_subscription` en menos de 60 s (en local, unos 10–20 s):
   ```bash
   while true; do curl -s -o /dev/null -w "%{http_code} " http://localhost:9080/salud/afiliacion/v1/afiliados/1000000001      -H "Authorization: Bearer $TOKEN" -H "X-RID-Purpose: eligibility_check" -H "X-RID-End-User: funcionario-42"; sleep 1; done
   ```
10. **Auditar** (marta.regulador): en "Auditoría", abrir la suscripción desde los eventos recientes y mostrar su línea de tiempo: solicitada, aprobada, activa en el gateway, revocada, con quién y por qué. Luego pulsar "Verificar integridad" para mostrar que la cadena de hash está íntegra.

## Mensajes clave para la audiencia

- La entidad proveedora decide quién accede a sus datos y para qué.
- El gateway no guarda lo que responde; solo quién consultó, qué operación y con qué finalidad.
- Revocar es inmediato y queda auditado.
- Todo es open source y reutilizable.
