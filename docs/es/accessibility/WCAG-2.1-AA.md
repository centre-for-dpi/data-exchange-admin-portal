# Auditoría WCAG 2.1 AA del portal (M6-02)

> English version (official): [docs/accessibility/WCAG-2.1-AA.md](../../accessibility/WCAG-2.1-AA.md)

- Fecha: 2026-11-16. Alcance: las 42 pantallas de `apps/web` en español e inglés, los diálogos que aparecen sobre ellas y las páginas de Keycloak que forman parte del flujo (ingreso y registro).
- Método: una revisión automatizada de todas las pantallas, que se repite en cada corrida de e2e, más una revisión manual, criterio por criterio, de lo que la automatización no juzga.
- Estados: **Cumple** · **Corregido** (en esta historia) · **No aplica** · **Pendiente** (con destino).

## Revisión automatizada

`apps/web/e2e/accessibility.spec.ts` recorre cada pantalla con el rol que más ve de ella, en español y en inglés. Antes publica una API con datos sensibles y la deja en el estado en que existen todas las pantallas de la cadena de aprobación: aprobada por operador y regulador, con una solicitud de acceso aprobada por el responsable de datos que espera al regulador. Una prueba falla si se agrega una página que no está en el recorrido.

En cada pantalla:

| Verificación | Criterio |
| :-- | :-- |
| axe, reglas WCAG 2.0/2.1 A y AA | Varios (contraste, nombres, roles, etiquetas, estructura) |
| `lang` del documento igual al idioma de la ruta | 3.1.1 |
| Título propio (solo el inicio lleva el nombre del producto a secas) | 2.4.2 |
| Un solo encabezado de nivel 1, contando `aria-level` | 1.3.1, 2.4.6 |
| La primera tabulación llega al enlace "Saltar al contenido" | 2.4.1 |
| Los siguientes elementos interactivos muestran foco visible | 2.4.7 |
| Sin texto visible fuera del contenedor que lo recorta, con el espaciado de texto del criterio | 1.4.12 |
| Sin desplazamiento horizontal a 320 px (una tabla puede desplazarse dentro de su propio contenedor) | 1.4.10 |

Además:
- El aviso de fin de sesión: aparece a tiempo, toma el foco, pasa axe y mantiene la sesión.
- Las páginas de ingreso y registro de Keycloak, solo con axe: son su tema, no el nuestro.

Para auditar sin fallar en el primer hallazgo: `DEN_A11Y_REPORT=1 pnpm --filter @den/web exec playwright test e2e/accessibility.spec.ts`.

## Hallazgos y correcciones

| # | Hallazgo | Criterio | Corrección |
| :-- | :-- | :-- | :-- |
| 1 | Los errores de validación del API llegaban en inglés a páginas en español ("at most 6 months for this classification", los mensajes de zod, el `detail` de 409 y 403) | 3.1.2, 3.3.1, 3.3.3 | Cada error del API lleva `key` y `params`, y la web los muestra en el idioma del usuario. Los de zod se redactan con el locale de zod. ADR-0025 |
| 2 | La sesión terminaba a los 30 minutos sin actividad sin aviso, y se perdía lo escrito | 2.2.1 | Diálogo dos minutos antes con "Seguir conectado", que renueva la sesión con Keycloak (`components/session-timeout.tsx`, `DEN_SESSION_IDLE_SECONDS`) |
| 3 | Con más de una entidad, el selector del encabezado desbordaba a 320 px | 1.4.10 | El selector se acomoda en varias líneas |
| 4 | Las tablas de la ficha de servicio desbordaban la página a 320 px | 1.4.10 | Desplazamiento dentro de su propio contenedor, como las demás tablas |
| 5 | La documentación de Scalar agregaba un segundo `h1` a la página de la API | 1.3.1 | Sus encabezados bajan un nivel (`aria-level`) |
| 6 | El tooltip de los gráficos de uso y del mapa de intercambios no se cerraba con Escape | 1.4.13 | Escape lo oculta sin mover el puntero ni el foco |
| 7 | El estado de una solicitud de acceso cambiaba en silencio mientras la página se refresca sola | 4.1.3 | El estado es una región `role="status"` |
| 8 | El límite de solicitudes de alta abiertas respondía un 409 genérico | 3.3.1 | El conflicto dice la razón y el máximo (`too_many_open_requests`) |
| 9 | A 320 px desbordaban también:<br>• las tablas de uso y de indicadores, porque la rejilla crecía con la tabla;<br>• el formulario de solicitud de acceso, porque un `fieldset` toma el ancho de su contenido y las rutas largas no se cortaban;<br>• el mapa de intercambios y el gráfico diario, por su ancho mínimo | 1.4.10 | Columnas `minmax(0, 1fr)`, `fieldset` que se encoge (regla global), rutas que se cortan donde haga falta, gráficos desde 240 px |
| 10 | Con el espaciado de texto del criterio, el SVG recortaba las etiquetas del eje de los gráficos de uso, y el enlace "Download OpenAPI Document" de Scalar quedaba cortado | 1.4.12 | El SVG deja ver lo que sale al margen de la tarjeta. El enlace de Scalar se acomoda en varias líneas (CSS propio sobre Scalar) |

## Estado por criterio

| Criterio | Estado | Notas |
| :-- | :-- | :-- |
| 1.1.1 Contenido no textual | Cumple | Logo decorativo con `alt=""` dentro de un enlace con nombre. Íconos `aria-hidden`. Los gráficos tienen nombre, cada barra o enlace su texto, y una tabla con los mismos datos |
| 1.2.x Multimedia | No aplica | No hay audio ni video |
| 1.3.1 Información y relaciones | Corregido | Tablas con `th scope`, listas de definición, `fieldset`/`legend` en grupos, etiquetas asociadas. #5 |
| 1.3.2 Secuencia significativa | Cumple | El orden del DOM es el visual |
| 1.3.3 Características sensoriales | Cumple | Las instrucciones no dependen de forma, color ni posición |
| 1.3.4 Orientación | Cumple | Sin bloqueo de orientación |
| 1.3.5 Propósito de los campos | Cumple | Los datos propios del usuario se piden en Keycloak (registro), con `autocomplete`. En el portal, los campos de personas son de terceros (designados, oficial de datos) y llevan `autocomplete="off"` a propósito |
| 1.4.1 Uso del color | Cumple | Los estados llevan texto además del color |
| 1.4.2 Control del audio | No aplica | |
| 1.4.3 Contraste mínimo | Cumple | axe en todas las pantallas. El color de marca de cada país se usa oscurecido para texto (`--primary-ink`), y Scalar tiene una paleta propia que cumple 4.5:1 |
| 1.4.4 Cambio de tamaño del texto | Cumple | Unidades relativas. Se cubre con la reflujo a 320 px (400 %) |
| 1.4.5 Imágenes de texto | Cumple | No hay |
| 1.4.10 Reflujo | Corregido | #3, #4, #9. Las tablas anchas se desplazan dentro de su contenedor (excepción del criterio para datos tabulares) |
| 1.4.11 Contraste de elementos no textuales | Cumple | Borde de los controles #8e8e8e: 3.28:1 sobre blanco, 3.08:1 sobre la superficie. Anillo de foco #0f0f0f: 19:1 |
| 1.4.12 Espaciado del texto | Corregido | #10. Verificado en cada pantalla: ningún texto visible queda fuera del contenedor que lo recorta |
| 1.4.13 Contenido al pasar el puntero o con el foco | Corregido | #6. El tooltip aparece también con el foco, se puede recorrer con el puntero y se cierra con Escape |
| 2.1.1 Teclado | Cumple | Todo con elementos nativos. Las barras de los gráficos y los enlaces del mapa reciben foco |
| 2.1.2 Sin trampas de teclado | Cumple | El diálogo de sesión no es modal. Scalar no atrapa el foco |
| 2.1.4 Atajos de una tecla | Cumple | No hay |
| 2.2.1 Tiempo ajustable | Corregido | #2. El refresco automático mientras se aplica un cambio dura como máximo un minuto y no tiene tiempo límite para el usuario |
| 2.2.2 Pausar, detener, ocultar | Cumple | Sin animaciones ni carruseles. El refresco automático es breve (≤ 60 s) y solo durante un estado transitorio. Se respeta `prefers-reduced-motion` |
| 2.3.1 Tres destellos | Cumple | No hay |
| 2.4.1 Evitar bloques | Cumple | "Saltar al contenido principal" en toda pantalla, verificado |
| 2.4.2 Titulado de páginas | Cumple | Título propio por pantalla, verificado |
| 2.4.3 Orden del foco | Cumple | El orden del DOM. El diálogo de sesión toma el foco y lo devuelve |
| 2.4.4 Propósito de los enlaces | Cumple | axe. Los enlaces de tablas llevan el nombre del recurso |
| 2.4.5 Múltiples vías | Cumple | Navegación principal, inicio con accesos por rol, búsqueda en el catálogo |
| 2.4.6 Encabezados y etiquetas | Cumple | Verificado |
| 2.4.7 Foco visible | Cumple | Anillo oscuro fijo para cualquier color de marca, verificado |
| 2.5.1 Gestos del puntero | Cumple | No hay gestos |
| 2.5.2 Cancelación del puntero | Cumple | Elementos nativos (activan al soltar) |
| 2.5.3 Etiqueta en el nombre | Cumple | El nombre accesible empieza por el texto visible (p. ej. "Notificaciones" con su contador) |
| 2.5.4 Activación por movimiento | No aplica | |
| 3.1.1 Idioma de la página | Cumple | Verificado en es y en |
| 3.1.2 Idioma de las partes | Corregido | #1. Quedan en inglés, a propósito, los diagnósticos técnicos del lint de OpenAPI, que nombran reglas y campos del documento (ADR-0025) |
| 3.2.1 Al recibir el foco | Cumple | |
| 3.2.2 Al recibir entradas | Cumple | El cambio de entidad activa tiene su botón; ningún `select` navega solo |
| 3.2.3 Navegación coherente | Cumple | El mismo encabezado y pie en toda pantalla |
| 3.2.4 Identificación coherente | Cumple | Los mismos componentes y textos para las mismas funciones |
| 3.3.1 Identificación de errores | Corregido | Resumen con `role="alert"` y error junto a cada campo con `aria-describedby`. #1, #8 |
| 3.3.2 Etiquetas o instrucciones | Cumple | Etiqueta visible en todo campo, "(Obligatorio)" en el texto, ayudas con `aria-describedby` |
| 3.3.3 Sugerencias ante errores | Corregido | Los mensajes dicen qué corregir y en el idioma del usuario (#1) |
| 3.3.4 Prevención de errores (legales, financieros, datos) | Cumple | Las decisiones con efecto (rechazo, revocación, suspensión, borrado por orden legal) piden motivo o confirmación. Una aprobación se puede revertir con revocación. Lo enviado se puede revisar antes |
| 4.1.1 Procesamiento | Cumple | HTML generado por React. Ids únicos con `useId` |
| 4.1.2 Nombre, función, valor | Cumple | axe en todas las pantallas. Elementos nativos, y ARIA solo donde no hay elemento nativo |
| 4.1.3 Mensajes de estado | Corregido | Confirmaciones con `role="status"`, errores con `role="alert"`. #7 |

## Keycloak

Las páginas de ingreso, registro y código de un solo uso son el tema `keycloak.v2` (PatternFly), en español e inglés según el realm. axe no encuentra violaciones en ingreso ni en registro (prueba "Keycloak's sign-in and registration pages"). Un tema propio por país sería configuración del operador y debería pasar la misma prueba.

## Lo que la automatización no cubre

- **Lectores de pantalla.** Esta auditoría verifica nombres, roles, estados y regiones vivas con axe y con pruebas, pero no se probó con NVDA, JAWS ni VoiceOver. Antes de la puesta en producción, el operador debe recorrer los flujos principales con NVDA y Firefox y con VoiceOver y Safari: alta de entidad, publicación, solicitud y aprobación de acceso, revisión del regulador.
- **Usuarios con discapacidad.** Una prueba con usuarios reales, idealmente de las entidades, encontraría problemas de comprensión que ninguna herramienta ve. Queda como recomendación para la operación.

## Cómo mantenerlo

- Una pantalla nueva debe entrar en `SCREENS` de `e2e/accessibility.spec.ts`: la prueba de cobertura falla si no está.
- Una regla de negocio nueva del API con error de campo define su `FieldErrorKey` y sus textos (ADR-0025): `src/i18n/messages.test.ts` falla si faltan.
