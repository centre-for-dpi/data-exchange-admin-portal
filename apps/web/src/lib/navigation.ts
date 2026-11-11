import { ENTITY_ROLES, type Role } from '@rid/contracts';

/** Who can see a navigation entry. The API enforces access again; this only shapes the UI. */
export type Audience = 'everyone' | 'authenticated' | readonly Role[];

export interface NavItem {
  /** Key under `nav` in messages/*.json. */
  key: string;
  href: string;
  audience: Audience;
}

/** Main navigation of the portal (SPEC.md §6). */
export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'home', href: '/', audience: 'everyone' },
  { key: 'catalog', href: '/catalog', audience: 'authenticated' },
  { key: 'myEntity', href: '/my-entity', audience: ENTITY_ROLES },
  {
    key: 'myApis',
    href: '/my-apis',
    audience: ['entity_admin', 'api_publisher', 'data_steward', 'entity_viewer'],
  },
  { key: 'myApps', href: '/my-apps', audience: ['entity_admin', 'app_developer', 'entity_viewer'] },
  { key: 'requests', href: '/requests', audience: ['data_steward'] },
  { key: 'operator', href: '/operator', audience: ['platform_admin', 'platform_reviewer'] },
  { key: 'regulator', href: '/regulator', audience: ['regulator'] },
  {
    key: 'audit',
    href: '/audit',
    audience: [
      'platform_admin',
      'platform_reviewer',
      'regulator',
      'auditor',
      'entity_admin',
      'entity_viewer',
    ],
  },
];

export interface Viewer {
  authenticated: boolean;
  /** Platform roles plus the roles of the active entity membership. */
  roles: readonly Role[];
}

export interface NavOptions {
  /** features.publicCatalog: anonymous users may browse the catalogue. */
  publicCatalog: boolean;
}

export function canSee(item: NavItem, viewer: Viewer, options: NavOptions): boolean {
  if (item.audience === 'everyone') return true;
  if (item.key === 'catalog' && options.publicCatalog) return true;
  if (!viewer.authenticated) return false;
  if (item.audience === 'authenticated') return true;
  return item.audience.some((role) => viewer.roles.includes(role));
}

export const visibleNavItems = (viewer: Viewer, options: NavOptions): NavItem[] =>
  NAV_ITEMS.filter((item) => canSee(item, viewer, options));
