/**
 * Outbox topic of the APISIX reconciler: aggregate apiVersion:<id> for a version's route, or
 * gateway:all for a full pass. In a module of its own so that services the reconciler uses can
 * queue it without importing the reconciler.
 */
export const GATEWAY_SYNC_TOPIC = 'gateway.sync';
