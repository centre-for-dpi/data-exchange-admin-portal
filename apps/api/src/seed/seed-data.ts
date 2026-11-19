import type { EntityRole, PlatformRole } from '@den/contracts';

/**
 * Development and demo data (docs/DEMO.md). Every entity is fictitious. Country-specific values
 * (organization id type, sectors, purposes) come from config/country/<code>.yaml, and users come
 * from the Keycloak realm export, so this file stays country-neutral.
 */
export interface SeedEntity {
  slug: string;
  legalName: string;
  shortName: string;
  /** Fictitious organization identifier. */
  taxId: string;
  kind: 'national' | 'territorial' | 'autonomous' | 'private_authorized';
  /** Preferred sector code; falls back to the first configured sector if the country lacks it. */
  sector: string;
  contactEmail: string;
  dpoName: string;
  dpoEmail: string;
}

export const SEED_ENTITIES: readonly SeedEntity[] = [
  {
    slug: 'salud',
    legalName: 'Entidad de Salud (ficticia)',
    shortName: 'Salud (ficticia)',
    taxId: '900000001',
    kind: 'national',
    sector: 'salud',
    contactEmail: 'contacto@salud.demo.den.example',
    dpoName: 'Responsable de protección de datos (ficticio)',
    dpoEmail: 'datos@salud.demo.den.example',
  },
  {
    slug: 'socioeconomico',
    legalName: 'Entidad de Registro Socioeconómico (ficticia)',
    shortName: 'Registro Socioeconómico (ficticia)',
    taxId: '900000002',
    kind: 'national',
    sector: 'vulnerabilidad',
    contactEmail: 'contacto@socioeconomico.demo.den.example',
    dpoName: 'Responsable de protección de datos (ficticio)',
    dpoEmail: 'datos@socioeconomico.demo.den.example',
  },
  {
    slug: 'programas-sociales',
    legalName: 'Entidad de Programas Sociales (ficticia)',
    shortName: 'Programas Sociales (ficticia)',
    taxId: '900000003',
    kind: 'national',
    sector: 'vulnerabilidad',
    contactEmail: 'contacto@programas.demo.den.example',
    dpoName: 'Responsable de protección de datos (ficticio)',
    dpoEmail: 'datos@programas.demo.den.example',
  },
];

export interface SeedRoles {
  platform?: PlatformRole[];
  /** Entity roles by entity slug. */
  entities?: Record<string, EntityRole[]>;
}

/** Roles of the Keycloak seed users (infra/keycloak/README.md), keyed by username. */
export const SEED_ROLES: Readonly<Record<string, SeedRoles>> = {
  'ana.operadora': { platform: ['platform_reviewer'] },
  'pablo.plataforma': { platform: ['platform_admin'] },
  'marta.regulador': { platform: ['regulator'] },
  'sofia.auditora': { platform: ['auditor'] },
  // Member of two entities: exercises the active-entity selector (M1-02).
  'pedro.publicador': { entities: { salud: ['api_publisher'], socioeconomico: ['api_publisher'] } },
  'lucia.datos': { entities: { salud: ['data_steward'] } },
  'elena.admin': { entities: { salud: ['entity_admin'] } },
  'carlos.dev': { entities: { 'programas-sociales': ['app_developer'] } },
};

/**
 * The kit's first public release (P-03), set as the current version when the portal has none,
 * so the nodes page shows how to download it. The operator replaces it in the console; the seed
 * never touches the releases once there is one.
 */
export const SEED_KIT_RELEASE = {
  version: '0.2.0',
  url: 'https://github.com/centre-for-dpi/data-exchange-provider/releases/download/v0.2.0/den-node-kit-0.2.0.tar.gz',
  fileName: 'den-node-kit-0.2.0.tar.gz',
  sizeBytes: 26_006_019,
  sha256: '4e196fae6d46a4c5942c0bdc1d35cdf29dc6ca25d667a0341dadf1b5c47c21d9',
} as const;
