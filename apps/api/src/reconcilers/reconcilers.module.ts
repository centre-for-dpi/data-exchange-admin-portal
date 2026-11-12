import { Module } from '@nestjs/common';
import { APISIX_ADMIN, HttpApisixAdmin } from './apisix/apisix-admin.js';
import { APISIX_SETTINGS, ApisixReconciler } from './apisix/apisix.reconciler.js';
import { type GatewaySettings, parseDevNodes } from './apisix/desired-state.js';
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
    {
      provide: APISIX_ADMIN,
      useFactory: () =>
        new HttpApisixAdmin({
          baseUrl: process.env.APISIX_ADMIN_URL ?? 'http://localhost:9180',
          apiKey: process.env.APISIX_ADMIN_KEY ?? '',
        }),
    },
    {
      provide: APISIX_SETTINGS,
      useFactory: (): GatewaySettings => ({
        // Addresses as APISIX (inside the container network) reaches each service.
        keycloakDiscoveryUrl: `${process.env.RID_GATEWAY_KEYCLOAK_URL ?? 'http://keycloak:8080'}/realms/rid-gateway/.well-known/openid-configuration`,
        audience: 'rid-gateway',
        opaUrl: process.env.RID_GATEWAY_OPA_URL ?? 'http://opa:8181',
        accessLogUrl: process.env.RID_GATEWAY_ACCESS_LOG_URL ?? 'http://fluent-bit:9880/',
        devNodes: parseDevNodes(process.env.RID_DEV_NODES),
      }),
    },
    ApisixReconciler,
  ],
  exports: [KeycloakReconciler, KEYCLOAK_ADMIN, ApisixReconciler, APISIX_ADMIN, APISIX_SETTINGS],
})
export class ReconcilersModule {}
