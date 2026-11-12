# ADR-0017 — El gateway lee el titular del cuerpo; el consumidor no lo declara

- Estado: Aceptado
- Fecha: 2026-11-12
- Precisa: ADR-0015, decisiones 1 y 2: reemplaza la cabecera `X-RID-Data-Subject` declarada por el consumidor

## Contexto

En ADR-0015, cuando el número de documento viajaba en el cuerpo, el consumidor lo declaraba aparte en la cabecera `X-RID-Data-Subject`. El gateway no leía cuerpos, así que no podía comprobar que esa cabecera coincidiera con el cuerpo. Un consumidor podía declarar a otra persona, o a nadie, y la consulta quedaba registrada mal o sin titular. La revisión de seguridad de MT-02 lo señaló, y lo cerramos antes de construir el registro (MT-03).

El plugin `opa` de APISIX no envía el cuerpo a OPA, solo método, ruta, cabeceras y query.

## Decisión

1. **Nueva forma de declarar el titular en el cuerpo.** Las operaciones con el titular en el cuerpo lo declaran con `x-rid-data-subject: { in: body, pointer, documentType? | documentTypePointer? }`, usando punteros JSON (RFC 6901). La forma `in: header` deja de aceptarse.
2. **Plugin propio de APISIX, `rid-data-subject`** (`infra/apisix/plugins`, prioridad 1020, fase rewrite):
   - corre después de `openid-connect`, así que una llamada sin token válido no hace leer ningún cuerpo, y antes de `proxy-rewrite` y `opa`;
   - primero borra cualquier `X-RID-Body-Subject` que envíe el cliente;
   - lee el cuerpo **en memoria y con tope** (64 KiB por defecto), resuelve el puntero y pasa el valor a OPA en `X-RID-Body-Subject`.
3. **OPA calcula el seudónimo** a partir de esa cabecera y nunca la devuelve, así que el valor no llega al proveedor (está en `send_headers_upstream`, SPIKE S-1). Si el cuerpo no trae el número, no es JSON o supera el tope, se niega con `data_subject_required`.
4. **El reconciliador agrega el plugin** solo a las rutas que tienen operaciones con titular en el cuerpo.
5. **Lista de plugins de APISIX.** Declarar un plugin propio obliga a listar todos en `config.yaml`: son los 3.19 por defecto más el nuestro. Reducir la lista a los que usan las rutas queda como endurecimiento para M6.

## Alternativas consideradas

- **Mantener la cabecera y que el proveedor verifique.** Deja la garantía fuera de la red y depende de cada proveedor.
- **`serverless-pre-function` con código Lua en la configuración de cada ruta.** Es código guardado en etcd, difícil de revisar y probar. Un plugin versionado en el repositorio es más claro.
- **Enviar el cuerpo completo a OPA**, con un plugin que lo agregue a la entrada. Expondría todo el cuerpo a la política, cuando solo hace falta un campo.

## Consecuencias

- El titular sale siempre de la propia petición, en la ruta o en el cuerpo, y nunca de una afirmación del consumidor. Con eso se cierra el riesgo residual de ADR-0015.
- **El gateway lee cuerpos.** Solo en las operaciones declaradas, en memoria, con tope de tamaño, y nunca los guarda ni los registra: la regla de oro 2 se mantiene.
- **Mantenimiento.** Hay un plugin Lua propio que mantener. Está cubierto por las pruebas e2e contra el APISIX real.
- **Límites.** Solo cuerpos JSON. Otros formatos (formularios, XML) tendrían que declararse `none` o adaptarse.
