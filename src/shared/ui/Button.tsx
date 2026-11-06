import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/shared/utils';

// Keep visual variants centralized so all button usages stay consistent.
// Buttons are pills that answer a press with the shared elastic `press` motion;
// fills are tonal steps rather than outlined boxes.
export const buttonVariants = cva(
  'press inline-flex touch-manipulation items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary/85',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 active:bg-destructive/85',
        outline:
          'border border-border bg-transparent hover:bg-foreground/[0.05] hover:text-foreground active:bg-foreground/[0.08]',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-accent active:bg-accent',
        // The tonal accent: for a prominent action that should not shout.
        tonal: 'bg-primary-container text-primary-container-foreground hover:brightness-[0.97] dark:hover:brightness-110',
        ghost: 'hover:bg-foreground/[0.06] hover:text-foreground active:bg-foreground/[0.09]',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-5 py-2',
        sm: 'h-9 px-4 text-sm',
        lg: 'h-12 px-8 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

/** The application-wide button, used by nearly every feature module and by the shared ActionMenu, Confirmation and PromptInput primitives. */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => {
    return (
      <button className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  }
);

Button.displayName = 'Button';

