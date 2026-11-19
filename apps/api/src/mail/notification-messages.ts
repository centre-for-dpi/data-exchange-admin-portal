import type { NotificationKind, NotificationParams } from '@den/contracts';
import type { MailLocale } from './messages.js';

type Text = (p: NotificationParams, date: string) => string;

const DECISION: Record<MailLocale, Record<string, string>> = {
  es: {
    approved: 'aprobada',
    rejected: 'rechazada',
    changes_requested: 'devuelta con correcciones',
  },
  en: {
    approved: 'approved',
    rejected: 'rejected',
    changes_requested: 'sent back for corrections',
  },
};

/**
 * One line per notification kind, used as the e-mail subject and first line (M2-08). The portal
 * renders the same kinds from apps/web/messages. Names come from the portal's data; no country
 * text here (CLAUDE.md, rule 6).
 */
export const NOTIFICATION_TEXTS: Record<MailLocale, Record<NotificationKind, Text>> = {
  es: {
    invitation_received: (p) => `Te invitaron a ${p.entity}`,
    entity_request_decided: (p) =>
      `La solicitud de alta de ${p.entity} fue ${DECISION.es[p.decision ?? ''] ?? p.decision}`,
    entity_status_changed: (p) =>
      p.decision === 'suspended'
        ? `${p.entity} fue suspendida en la red`
        : p.decision === 'reactivated'
          ? `${p.entity} fue reactivada en la red`
          : `${p.entity} fue dada de baja de la red`,
    api_review_requested: (p) => `${p.api} ${p.version} (${p.entity}) espera tu revisión`,
    api_changes_requested: (p) => `Se pidieron cambios en ${p.api} ${p.version}`,
    api_published: (p) => `${p.api} ${p.version} está publicada`,
    api_deprecated: (p, d) => `${p.api} ${p.version} quedó obsoleta y se retira el ${d}`,
    regulator_approval_needed: (p) =>
      p.what === 'api'
        ? `${p.api} ${p.version} (${p.entity}) espera la aprobación del regulador`
        : `Una solicitud de acceso a ${p.api} espera la aprobación del regulador`,
    access_requested: (p) => `${p.application} pide acceso a ${p.api}`,
    access_request_answered: (p) => `${p.application} respondió sobre su solicitud a ${p.api}`,
    access_info_requested: (p) => `${p.entity} pregunta sobre tu solicitud a ${p.api}`,
    access_approved: (p) => `Tu solicitud de acceso a ${p.api} fue aprobada`,
    access_rejected: (p) => `Tu solicitud de acceso a ${p.api} fue rechazada`,
    access_expiring: (p, d) => `El acceso de ${p.application} a ${p.api} vence el ${d}`,
    access_suspended: (p) => `Se suspendió el acceso de ${p.application} a ${p.api}`,
    access_revoked: (p) => `Se revocó el acceso de ${p.application} a ${p.api}`,
    certificate_expiring: (p, d) => `El certificado de cliente de ${p.application} vence el ${d}`,
    certificate_revoked: (p) =>
      `El operador revocó el certificado de cliente de ${p.application}: emite uno nuevo`,
    node_offline: (p) => `El nodo ${p.node} de ${p.entity} no envía heartbeat hace 5 minutos`,
    api_contract_differs: (p) =>
      `El nodo ${p.node} sirve para ${p.api} ${p.version} un OpenAPI distinto del publicado`,
  },
  en: {
    invitation_received: (p) => `You were invited to ${p.entity}`,
    entity_request_decided: (p) =>
      `The onboarding request of ${p.entity} was ${DECISION.en[p.decision ?? ''] ?? p.decision}`,
    entity_status_changed: (p) =>
      p.decision === 'suspended'
        ? `${p.entity} was suspended on the network`
        : p.decision === 'reactivated'
          ? `${p.entity} was reactivated on the network`
          : `${p.entity} was offboarded from the network`,
    api_review_requested: (p) => `${p.api} ${p.version} (${p.entity}) is waiting for your review`,
    api_changes_requested: (p) => `Changes were requested on ${p.api} ${p.version}`,
    api_published: (p) => `${p.api} ${p.version} is published`,
    api_deprecated: (p, d) => `${p.api} ${p.version} is deprecated and will be retired on ${d}`,
    regulator_approval_needed: (p) =>
      p.what === 'api'
        ? `${p.api} ${p.version} (${p.entity}) is waiting for the regulator`
        : `An access request to ${p.api} is waiting for the regulator`,
    access_requested: (p) => `${p.application} asks for access to ${p.api}`,
    access_request_answered: (p) => `${p.application} answered about its request to ${p.api}`,
    access_info_requested: (p) => `${p.entity} has a question about your request to ${p.api}`,
    access_approved: (p) => `Your access request to ${p.api} was approved`,
    access_rejected: (p) => `Your access request to ${p.api} was rejected`,
    access_expiring: (p, d) => `The access of ${p.application} to ${p.api} expires on ${d}`,
    access_suspended: (p) => `The access of ${p.application} to ${p.api} was suspended`,
    access_revoked: (p) => `The access of ${p.application} to ${p.api} was revoked`,
    certificate_expiring: (p, d) => `The client certificate of ${p.application} expires on ${d}`,
    certificate_revoked: (p) =>
      `The operator revoked the client certificate of ${p.application}: issue a new one`,
    node_offline: (p) => `Node ${p.node} of ${p.entity} has sent no heartbeat for 5 minutes`,
    api_contract_differs: (p) =>
      `Node ${p.node} serves ${p.api} ${p.version} with an OpenAPI other than the published one`,
  },
};

/**
 * The e-mail subject of each kind (B-10): fixed text. The sentence of NOTIFICATION_TEXTS carries
 * names and values that third parties typed (entity, API, application, comments), and an official
 * sender must not put them in a subject line, where they are the first thing a person reads. The
 * sentence stays in the body.
 */
export const NOTIFICATION_SUBJECTS: Record<MailLocale, Record<NotificationKind, string>> = {
  es: {
    invitation_received: 'Te invitaron a una entidad',
    entity_request_decided: 'Respuesta a una solicitud de alta de entidad',
    entity_status_changed: 'Cambio de estado de una entidad en la red',
    api_review_requested: 'Una API espera tu revisión',
    api_changes_requested: 'Se pidieron cambios en una API',
    api_published: 'Una API fue publicada',
    api_deprecated: 'Una API quedó obsoleta',
    regulator_approval_needed: 'Algo espera la aprobación del regulador',
    access_requested: 'Nueva solicitud de acceso',
    access_request_answered: 'Respuesta sobre una solicitud de acceso',
    access_info_requested: 'Preguntan sobre tu solicitud de acceso',
    access_approved: 'Solicitud de acceso aprobada',
    access_rejected: 'Solicitud de acceso rechazada',
    access_expiring: 'Un acceso está por vencer',
    access_suspended: 'Acceso suspendido',
    access_revoked: 'Acceso revocado',
    certificate_expiring: 'Un certificado de cliente está por vencer',
    certificate_revoked: 'Un certificado de cliente fue revocado',
    node_offline: 'Un nodo no envía heartbeat',
    api_contract_differs: 'Un nodo sirve un contrato distinto del publicado',
  },
  en: {
    invitation_received: 'You were invited to an entity',
    entity_request_decided: 'Answer to an entity onboarding request',
    entity_status_changed: 'An entity changed status on the network',
    api_review_requested: 'An API is waiting for your review',
    api_changes_requested: 'Changes were requested on an API',
    api_published: 'An API was published',
    api_deprecated: 'An API was deprecated',
    regulator_approval_needed: 'Something is waiting for the regulator',
    access_requested: 'New access request',
    access_request_answered: 'Answer about an access request',
    access_info_requested: 'A question about your access request',
    access_approved: 'Access request approved',
    access_rejected: 'Access request rejected',
    access_expiring: 'An access is about to expire',
    access_suspended: 'Access suspended',
    access_revoked: 'Access revoked',
    certificate_expiring: 'A client certificate is about to expire',
    certificate_revoked: 'A client certificate was revoked',
    node_offline: 'A node is not sending heartbeats',
    api_contract_differs: 'A node serves a contract different from the published one',
  },
};

export const NOTIFICATION_FOOTER: Record<MailLocale, (prefs: string) => string> = {
  es: (prefs) => `Puedes elegir qué avisos recibes por correo: ${prefs}`,
  en: (prefs) => `You can choose which notices you get by e-mail: ${prefs}`,
};
