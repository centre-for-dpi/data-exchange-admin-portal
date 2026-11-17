# Política de seguridad

> English version: [SECURITY.md](../../SECURITY.md)

El portal DEN gobierna el intercambio de datos personales entre entidades públicas, así que tomamos en serio los reportes de vulnerabilidades y los tratamos en privado.

## Reportar una vulnerabilidad

**No abras un issue, pull request ni discusión públicos para una vulnerabilidad.**

Repórtala en privado por GitHub: en la pestaña **Security** de este repositorio, elige **Report a vulnerability**. Incluye, en lo posible:

- el componente afectado (web, API, configuración del gateway, políticas de OPA, chart de Helm, instalador, verificador de transparencia…) y la versión o el commit;
- los pasos para reproducirla, o una prueba de concepto, y el impacto que esperas (por ejemplo, acceso a datos de otra entidad, saltarse una suscripción o una finalidad, recuperar la identidad de un titular);
- la configuración de la que depende (opciones de `config/country/*.yaml`, variables de entorno).

No incluyas datos personales reales en el reporte: el entorno de desarrollo trae datos sintéticos para eso.

Acusaremos recibo del reporte, lo evaluaremos, te mantendremos al tanto mientras preparamos la corrección y acordaremos contigo la fecha de divulgación. Con tu permiso, te damos crédito en el aviso.

## Alcance

Dentro del alcance: el código y la configuración de este repositorio, incluidas las dependencias que fija.

Fuera del alcance aquí:

- **El kit de APIs instantáneas** que se instala en las entidades: tiene su propio repositorio y su propia política.
- **El despliegue de un país.** Cada despliegue lo opera su operador nacional. Reporta los problemas de una instancia en funcionamiento (una mala configuración, un servicio expuesto) a ese operador; si la causa está en este código, repórtalo también aquí.
- **Los valores por omisión de desarrollo.** Los secretos de `.env.example`, los realms de Keycloak de desarrollo, los usuarios de demo, `infra/mock-providers` e `infra/mock-citizen-app` son solo para desarrollo y pruebas. Un valor por omisión que pasaría a una instalación de producción (por `install.sh`, `scripts/make-deploy-env.mjs` o el chart de Helm) sí está dentro del alcance.

## Versiones soportadas

Las correcciones de seguridad van a la rama `main` y a la última versión publicada.

## Para operadores

Mantén tu despliegue en la última versión y sigue [docs/es/RUNBOOK.md](RUNBOOK.md) para responder a incidentes, rotar la CA intermedia y revocar certificados en masa. La lista de verificación OWASP ASVS nivel 2 que cumple el portal está en [docs/es/security/ASVS-L2.md](security/ASVS-L2.md).
