import * as React from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * `<SettingsCard>` — the standard Settings card container.
 *
 * Every Settings section paints the same bordered surface: a rounded card
 * with the app's one card-padding contract (`p-4 md:p-6` — 16 px on phones,
 * 24 px from `md` up). Before this primitive the surface hand-rolled
 * `bg-card border-border rounded-xl border p-4 sm:p-6` in ~35 files, which
 * (a) bypassed the `<Card>` primitive entirely and (b) stepped padding at
 * `sm:` (640 px) instead of `md:` (768 px), so on a ~700 px tablet Settings
 * cards read denser than every other surface.
 *
 * The default renders the ui `<Card>` so the surface composes from one shape,
 * and like `<Card>` the card owns its internal rhythm: `flex flex-col gap-4`.
 * The header→body distance therefore comes from the container's gap, never
 * from a margin a call site remembers to add. It used to come from three
 * competing techniques at once — `mt-4` on the first body child (20 files),
 * `space-y-4` on the card (9), `mb-3`/`mb-4` on the header (2) — which is
 * exactly the drift that made neighbouring cards read as different systems.
 * A denser card overrides the gap on the card itself (`className="gap-2"`),
 * as `<Card>` documents; nothing else may re-declare the header→body step.
 *
 * Pass `className` for per-card extras (`scroll-mt-28`, `flex h-full`, …).
 *
 * `as="section"` keeps a card's semantic landmark element (a `<section>` with
 * an `aria-labelledby`) while painting the same shape, rhythm, and padding.
 */
const SETTINGS_CARD_SHELL = "flex flex-col gap-4 p-4 md:p-6";

type SettingsCardOwnProps = { className?: string };

type SettingsCardProps<E extends React.ElementType> = SettingsCardOwnProps & {
  as?: E;
} & Omit<React.ComponentPropsWithoutRef<E>, keyof SettingsCardOwnProps | "as">;

export function SettingsCard<E extends React.ElementType = typeof Card>({
  as,
  className,
  ...props
}: SettingsCardProps<E>) {
  if (as) {
    const Component = as as React.ElementType;
    return (
      <Component
        data-slot="card"
        // Mirror the ui Card shell so a semantic landmark card paints
        // identically to the default <Card>-backed one.
        className={cn(
          "bg-card text-card-foreground flex flex-col gap-4 rounded-xl border p-4 shadow-sm md:p-6",
          className,
        )}
        {...props}
      />
    );
  }
  return (
    <Card
      // Reset the primitive's flex/gap layout and apply the shared
      // `p-4 md:p-6` padding; Settings bodies own their internal spacing.
      className={cn(SETTINGS_CARD_SHELL, className)}
      {...(props as React.ComponentProps<typeof Card>)}
    />
  );
}
