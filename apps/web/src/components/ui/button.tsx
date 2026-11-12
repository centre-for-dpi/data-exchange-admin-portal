import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

// shadcn/ui button, styled after the CDPI design system: pill-shaped, Outfit medium.
export const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-full font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-sm hover:bg-primary-hover',
        secondary: 'bg-primary-soft text-primary-ink hover:bg-surface-panel',
        outline:
          'border border-border-control bg-background text-foreground-strong hover:border-foreground hover:bg-surface-app',
        ghost: 'text-foreground-strong hover:bg-surface-app',
        danger: 'border border-danger-border bg-background text-danger-fg hover:bg-danger-bg',
      },
      size: {
        default: 'h-11 px-5 text-sm',
        sm: 'h-9 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot.Root : 'button';
  return <Component className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
