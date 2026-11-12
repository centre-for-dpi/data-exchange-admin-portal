'use client';

import type { ReactNode } from 'react';
import { Link, usePathname } from '../i18n/navigation';
import { cn } from '../lib/utils';

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'block rounded-full px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors duration-150',
        active
          ? 'bg-primary-soft text-primary-ink'
          : 'text-muted-foreground hover:bg-surface-app hover:text-foreground-strong',
      )}
    >
      {children}
    </Link>
  );
}
