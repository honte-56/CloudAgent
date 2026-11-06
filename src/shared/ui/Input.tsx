import * as React from 'react';

import { cn } from '@/shared/utils';

type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/** The application-wide text input, used by the chat, file-tree, mcp, project-creation-wizard, settings, sidebar and skills modules. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // An inset well: filled one step below its surface, no outline until focus
          // draws a soft ring in the accent color.
          'flex h-10 w-full rounded-xl border border-transparent bg-input/70 px-3.5 py-1 text-sm transition-[background-color,box-shadow,border-color] duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/80 hover:bg-input focus-visible:border-ring/40 focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);

Input.displayName = 'Input';

