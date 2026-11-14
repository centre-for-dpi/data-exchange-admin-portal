import type { EntityRole } from '@rid/contracts';

/**
 * Texts of the e-mails the API sends, in the portal's languages (CLAUDE.md, rule 7). Names of
 * authorities and of the product come from the country config, never from here (rule 6).
 */
export type MailLocale = 'es' | 'en';

interface RenewalText {
  product: string;
  apiName: string;
  provider: string;
  application: string;
  until: string;
  link: string;
}

interface InvitationText {
  product: string;
  entityShortName: string;
  entityLegalName: string;
  name: string | null;
  email: string;
  roles: readonly EntityRole[];
  link: string;
  expires: string;
}

const ROLE_NAMES: Record<MailLocale, Record<EntityRole, string>> = {
  es: {
    entity_admin: 'administración de la entidad',
    api_publisher: 'publicación de APIs',
    data_steward: 'responsable de datos',
    app_developer: 'desarrollo de aplicaciones',
    entity_viewer: 'consulta',
  },
  en: {
    entity_admin: 'entity administration',
    api_publisher: 'API publishing',
    data_steward: 'data steward',
    app_developer: 'application development',
    entity_viewer: 'read-only access',
  },
};

export const MESSAGES = {
  es: {
    invitation: (t: InvitationText) => ({
      subject: `Invitación a ${t.entityShortName} en ${t.product}`,
      text: [
        t.name ? `Hola, ${t.name}:` : 'Hola:',
        '',
        `${t.entityLegalName} (${t.entityShortName}) te invitó a ${t.product} con estos roles: ${t.roles.map((r) => ROLE_NAMES.es[r]).join(', ')}.`,
        '',
        `Para aceptar, entra al portal con el correo ${t.email} y abre «Mis invitaciones». Si todavía no tienes cuenta, regístrate con ese mismo correo.`,
        t.link,
        '',
        `La invitación vence el ${t.expires}.`,
        '',
        'Si no esperabas este mensaje, ignóralo: sin aceptar la invitación no pasa nada.',
      ].join('\n'),
    }),
    renewalNotice: (t: RenewalText) => ({
      subject: `Tu acceso a ${t.apiName} vence el ${t.until}`,
      text: [
        'Hola:',
        '',
        `La aplicación «${t.application}» tiene acceso a ${t.apiName} (${t.provider}) en ${t.product} hasta el ${t.until}.`,
        'Si la necesitas después de esa fecha, pide la renovación: la solicitud llega prellenada y el acceso actual sigue mientras se decide.',
        t.link,
      ].join('\n'),
    }),
  },
  en: {
    invitation: (t: InvitationText) => ({
      subject: `Invitation to ${t.entityShortName} on ${t.product}`,
      text: [
        t.name ? `Hello ${t.name},` : 'Hello,',
        '',
        `${t.entityLegalName} (${t.entityShortName}) invited you to ${t.product} with these roles: ${t.roles.map((r) => ROLE_NAMES.en[r]).join(', ')}.`,
        '',
        `To accept, sign in to the portal with ${t.email} and open "My invitations". If you do not have an account yet, register with that same address.`,
        t.link,
        '',
        `The invitation expires on ${t.expires}.`,
        '',
        'If you were not expecting this message, ignore it: nothing happens unless you accept.',
      ].join('\n'),
    }),
    renewalNotice: (t: RenewalText) => ({
      subject: `Your access to ${t.apiName} expires on ${t.until}`,
      text: [
        'Hello,',
        '',
        `The application "${t.application}" has access to ${t.apiName} (${t.provider}) on ${t.product} until ${t.until}.`,
        'If you still need it after that date, request the renewal: the request comes prefilled and the current access continues while it is decided.',
        t.link,
      ].join('\n'),
    }),
  },
} as const;

/** Language of the country locale (e.g. "es-XX" -> "es"), falling back to Spanish. */
export const mailLocale = (countryLocale: string): MailLocale =>
  countryLocale.toLowerCase().startsWith('en') ? 'en' : 'es';
