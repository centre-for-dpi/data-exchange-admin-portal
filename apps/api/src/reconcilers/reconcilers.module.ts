import { readFileSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { Module } from '@nestjs/common';
import { APISIX_ADMIN, HttpApisixAdmin } from './apisix/apisix-admin.js';
import { APISIX_SETTINGS, ApisixReconciler } from './apisix/apisix.reconciler.js';
import { getCountryConfig } from '@den/config';
import {
  type GatewaySettings,
  parseDevNodes,
  parseHostNames,
  parseHostPort,
} from './apisix/desired-state.js';
import { GatewaySigningKeysService } from '../assertion/gateway-signing-keys.service.js';
import { GatewayCertificates } from './apisix/gateway-certificates.js';
import { HttpKeycloakGatewayAdmin, KEYCLOAK_ADMIN } from './keycloak/keycloak-admin.js';
import { keycloakAdminUrl } from '../admin/keycloak-users.js';
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
          baseUrl: keycloakAdminUrl(),
          realm: 'den-gateway',
          clientId: process.env.DEN_GATEWAY_PROVISIONER_CLIENT_ID ?? 'den-portal-provisioner',
          clientSecret: process.env.DEN_GATEWAY_PROVISIONER_SECRET ?? '',
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
        keycloakDiscoveryUrl: `${process.env.DEN_GATEWAY_KEYCLOAK_URL ?? 'http://keycloak:8080'}/realms/den-gateway/.well-known/openid-configuration`,
        audience: 'den-gateway',
        opaUrl: process.env.DEN_GATEWAY_OPA_URL ?? 'http://opa:8181',
        opaToken: process.env.DEN_OPA_DECISION_TOKEN || undefined,
        accessLogUrl: process.env.DEN_GATEWAY_ACCESS_LOG_URL ?? 'http://fluent-bit:9880/',
        transparencyLog: parseHostPort(
          process.env.DEN_GATEWAY_TRANSPARENCY_LOG ?? 'fluent-bit-transparency:5170',
        ),
        devNodes: parseDevNodes(process.env.DEN_DEV_NODES),
        resolveHost: async (host) =>
          (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
        tls: {
          hosts: parseHostNames(process.env.DEN_GATEWAY_TLS_HOSTS ?? 'localhost'),
          clientName: parseHostNames(process.env.DEN_GATEWAY_CLIENT_NAME ?? 'den-gateway')[0] ?? '',
          // Read when used: the country configuration is loaded at startup (main.ts).
          get mtlsRequired() {
            return getCountryConfig().features.mtls.required;
          },
        },
        wgHub: process.env.DEN_GATEWAY_WG_HUB ?? 'wg-hub:8443',
        // Read when used, like mtlsRequired (M6-10).
        get assertion() {
          return getCountryConfig().features.gatewayAssertion
            ? { issuer: process.env.DEN_GATEWAY_PUBLIC_URL ?? 'https://localhost:9443' }
            : undefined;
        },
        validationToken: process.env.DEN_VALIDATION_TOKEN || undefined,
        xroad:
          process.env.DEN_XROAD_SECURITY_SERVER_URL && process.env.DEN_XROAD_CLIENT
            ? {
                securityServerUrl: process.env.DEN_XROAD_SECURITY_SERVER_URL,
                client: process.env.DEN_XROAD_CLIENT,
                ...(process.env.DEN_XROAD_SECURITY_SERVER_CA
                  ? { caPem: readFileSync(process.env.DEN_XROAD_SECURITY_SERVER_CA, 'utf8') }
                  : {}),
              }
            : undefined,
        nodeControl:
          process.env.DEN_GATEWAY_PORTAL_API_URL && process.env.DEN_NODE_CONTROL_TOKEN
            ? {
                portalUrl: process.env.DEN_GATEWAY_PORTAL_API_URL,
                token: process.env.DEN_NODE_CONTROL_TOKEN,
              }
            : undefined,
      }),
    },
    GatewayCertificates,
    GatewaySigningKeysService,
    ApisixReconciler,
    {
      provide: HUB_AGENT,
      useFactory: () =>
        process.env.DEN_WG_HUB_AGENT_URL && process.env.DEN_WG_HUB_AGENT_TOKEN
          ? new HttpHubAgent({
              baseUrl: process.env.DEN_WG_HUB_AGENT_URL,
              token: process.env.DEN_WG_HUB_AGENT_TOKEN,
            })
          : null,
    },
    WireguardReconciler,
  ],
  exports: [
    GatewaySigningKeysService,
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
