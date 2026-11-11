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
        'block rounded-md px-3 py-2 text-sm font-medium',
        active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted',
      )}
    >
      {children}
    </Link>
  );
}
