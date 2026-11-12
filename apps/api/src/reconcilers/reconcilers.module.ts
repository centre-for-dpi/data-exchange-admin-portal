import { Module } from '@nestjs/common';
import { HttpKeycloakGatewayAdmin, KEYCLOAK_ADMIN } from './keycloak/keycloak-admin.js';
import { KeycloakReconciler } from './keycloak/keycloak.reconciler.js';

/** Reconcilers: the only code that writes to Keycloak / APISIX / OPA (ADR-0007). */
@Module({
  providers: [
    {
      provide: KEYCLOAK_ADMIN,
      useFactory: () =>
        new HttpKeycloakGatewayAdmin({
          baseUrl: process.env.KEYCLOAK_URL ?? 'http://localhost:8080',
          realm: 'rid-gateway',
          clientId: process.env.RID_GATEWAY_PROVISIONER_CLIENT_ID ?? 'rid-portal-provisioner',
          clientSecret: process.env.RID_GATEWAY_PROVISIONER_SECRET ?? '',
        }),
    },
    KeycloakReconciler,
  ],
  exports: [KeycloakReconciler, KEYCLOAK_ADMIN],
})
export class ReconcilersModule {}
