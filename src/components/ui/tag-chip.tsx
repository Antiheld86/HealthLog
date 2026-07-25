import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The small neutral tag chip that labels a card's subject line.
 *
 * Three Settings integration cards carried the same hand-copied literal
 * (`bg-muted text-foreground rounded-full px-2 py-0.5 text-[0.6875rem]
 * font-medium`) in `SettingsCardHeader`'s `titleAccessory` slot, each free to
 * drift on the next touch. This is that literal, named — on the `text-2xs`
 * token rather than an arbitrary value.
 *
 * It is deliberately NOT a `Badge`: `Badge` carries status meaning (variant →
 * semantic colour), while a tag chip is a neutral noun ("Glucose", "Steps").
 * Keeping them apart is what stops a neutral label from creeping into the
 * status vocabulary. A chip that means a state is a `Badge`.
 *
 * RSC-safe: no hooks, no browser API.
 */
export function TagChip({
  children,
  className,
  ...props
}: {
  children: ReactNode;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"span">, "children">) {
  return (
    <span
      data-slot="tag-chip"
      className={cn(
        "bg-muted text-foreground text-2xs rounded-full px-2 py-0.5 font-medium",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
