import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** Page body: centred column with the standard gutters and vertical rhythm. */
export function Page({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn('mx-auto w-full max-w-6xl space-y-8 px-4 py-10 sm:px-6 md:py-12', className)}
      {...props}
    />
  );
}

/** Page title block: optional eyebrow, the page's only h1, a lead and right-aligned actions. */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  titleClassName,
}: {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleClassName?: string;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 max-w-3xl space-y-2">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h1
          className={cn(
            'text-3xl leading-tight font-bold md:text-4xl md:leading-tight',
            titleClassName,
          )}
        >
          {title}
        </h1>
        {description ? (
          <div className="text-base leading-relaxed text-muted-foreground md:text-lg">
            {description}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
    </header>
  );
}

/** A titled block of a page. `level` keeps the heading outline correct where it is nested. */
export function Section({
  title,
  description,
  actions,
  level = 2,
  id,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
  id?: string;
  className?: string;
  children?: ReactNode;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <section aria-labelledby={id} className={cn('space-y-4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 space-y-1">
          <Heading id={id} className={level === 2 ? 'text-2xl font-bold' : 'text-lg font-semibold'}>
            {title}
          </Heading>
          {description ? (
            <div className="max-w-3xl text-sm text-muted-foreground">{description}</div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** White card (hairline border, radius 24, soft shadow). */
export function Card({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('card p-6', className)} {...props} />;
}

/** Friendly empty state inside a dashed card. */
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-4 rounded-[var(--radius-card)] border border-dashed border-border-control bg-background p-8 text-muted-foreground">
      <div>{children}</div>
      {action}
    </div>
  );
}
