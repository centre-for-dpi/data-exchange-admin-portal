# Guion de demo — Hito M1 (fin de noviembre)

Duración: 15 minutos. Todo corre en local con `pnpm infra:up && pnpm dev`. Todos los datos son ficticios.

## Personajes (usuarios semilla en Keycloak, contraseña `demo` solo en desarrollo)

| Usuario | Entidad | Rol |
| :-- | :-- | :-- |
| `ana.operadora` | Operador (AND) | `platform_reviewer` |
| `pedro.publicador` | Entidad de Salud (ficticia) | `api_publisher` |
| `lucia.datos` | Entidad de Salud (ficticia) | `data_steward` |
| `carlos.dev` | Entidad de Programas Sociales (ficticia) | `app_developer` |
| `marta.regulador` | Regulador (MinTIC) | `regulator` |

## Pasos

1. **Publicar** (pedro.publicador): crear la API "Consulta de afiliación", subir `infra/mock-providers/salud/openapi.yaml`, upstream = nodo de prueba, clasificación `personal`, finalidad permitida `eligibility_check`. Enviar a revisión.
2. **Revisar** (ana.operadora): ver ficha y campos expuestos, aprobar. Mostrar que la ruta aparece en APISIX y que una llamada sin suscripción da `403 no_subscription`.
3. **Descubrir** (carlos.dev): buscar en el catálogo, ver documentación interactiva.
4. **Credenciales** (carlos.dev): crear la aplicación "Validador de subsidios", copiar el secreto.
5. **Solicitar** (carlos.dev): pedir acceso con finalidad `eligibility_check` y detalle "Verificar afiliación al asignar el subsidio X".
6. **Aprobar** (lucia.datos): ver la solicitud en su bandeja, aprobar con vigencia de 6 meses.
7. **Llamar** (terminal):
   ```bash
   TOKEN=$(curl -s -d grant_type=client_credentials -u "$CLIENT_ID:$CLIENT_SECRET" \
     http://localhost:8080/realms/rid-gateway/protocol/openid-connect/token | jq -r .access_token)
   curl -s http://localhost:9080/salud/afiliacion/v1/afiliados/1000000001 \
     -H "Authorization: Bearer $TOKEN" -H "X-RID-Purpose: eligibility_check"
   ```
   Respuesta 200. Mostrar en el mock del proveedor las cabeceras `X-RID-*` recibidas.
8. **Finalidad incorrecta**: repetir con `X-RID-Purpose: benefit_targeting` → `403 purpose_not_allowed`.
9. **Revocar** (lucia.datos): revocar la suscripción; repetir la llamada en un bucle y ver cómo pasa a `403` en menos de 60 s.
10. **Auditar** (marta.regulador): línea de tiempo de la suscripción con cada decisión y verificación de integridad de la cadena.

## Mensajes clave para la audiencia

- La entidad proveedora decide quién accede a sus datos y para qué.
- El gateway no guarda lo que responde; solo quién consultó, qué operación y con qué finalidad.
- Revocar es inmediato y queda auditado.
- Todo es open source y reutilizable.
