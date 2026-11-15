import { lookup } from 'node:dns/promises';
import { Module } from '@nestjs/common';
import { APISIX_ADMIN, HttpApisixAdmin } from './apisix/apisix-admin.js';
import { APISIX_SETTINGS, ApisixReconciler } from './apisix/apisix.reconciler.js';
import { getCountryConfig } from '@rid/config';
import {
  type GatewaySettings,
  parseDevNodes,
  parseHostNames,
  parseHostPort,
} from './apisix/desired-state.js';
import { GatewayCertificates } from './apisix/gateway-certificates.js';
import { HttpKeycloakGatewayAdmin, KEYCLOAK_ADMIN } from './keycloak/keycloak-admin.js';
import { KeycloakReconciler } from './keycloak/keycloak.reconciler.js';
import { HUB_AGENT, HttpHubAgent } from './wireguard/hub-agent.js';
import { WireguardReconciler } from './wireguard/wireguard.reconciler.js';

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
        transparencyLog: parseHostPort(
          process.env.RID_GATEWAY_TRANSPARENCY_LOG ?? 'fluent-bit-transparency:5170',
        ),
        devNodes: parseDevNodes(process.env.RID_DEV_NODES),
        resolveHost: async (host) =>
          (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
        tls: {
          hosts: parseHostNames(process.env.RID_GATEWAY_TLS_HOSTS ?? 'localhost'),
          clientName: parseHostNames(process.env.RID_GATEWAY_CLIENT_NAME ?? 'rid-gateway')[0] ?? '',
          // Read when used: the country configuration is loaded at startup (main.ts).
          get mtlsRequired() {
            return getCountryConfig().features.mtls.required;
          },
        },
        wgHub: process.env.RID_GATEWAY_WG_HUB ?? 'wg-hub:8443',
        nodeControl:
          process.env.RID_GATEWAY_PORTAL_API_URL && process.env.RID_NODE_CONTROL_TOKEN
            ? {
                portalUrl: process.env.RID_GATEWAY_PORTAL_API_URL,
                token: process.env.RID_NODE_CONTROL_TOKEN,
              }
            : undefined,
      }),
    },
    GatewayCertificates,
    ApisixReconciler,
    {
      provide: HUB_AGENT,
      useFactory: () =>
        process.env.RID_WG_HUB_AGENT_URL && process.env.RID_WG_HUB_AGENT_TOKEN
          ? new HttpHubAgent({
              baseUrl: process.env.RID_WG_HUB_AGENT_URL,
              token: process.env.RID_WG_HUB_AGENT_TOKEN,
            })
          : null,
    },
    WireguardReconciler,
  ],
  exports: [
    KeycloakReconciler,
    KEYCLOAK_ADMIN,
    ApisixReconciler,
    APISIX_ADMIN,
    APISIX_SETTINGS,
    WireguardReconciler,
    HUB_AGENT,
  ],
})
export class ReconcilersModule {}
