import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `<SettingsCardActions>` — the action row of a Settings or Admin card.
 *
 * The audit found four positions (bottom-right, bottom-left, the header's
 * status slot, inline mid-card) and five variants carrying the SAME role —
 * "the primary action of this card" — sometimes two of them in one file. The
 * two sections that already read right (`score-section.tsx`,
 * `coach-prefs-section.tsx`) agreed on one shape, and this is it.
 *
 * The contract (design standards §12):
 *   - The row is the LAST thing in the card. Status lines and results sit
 *     above it; a result set big enough to need a frame becomes its own card.
 *   - Primary action last (rightmost), `variant` default, `size="sm"` with
 *     the `min-h-11` mobile tap floor. One per card.
 *   - Secondary action `outline`, before the primary in the same row.
 *   - Destructive card-wide action: same row, `variant="destructive"` —
 *     never an `outline` hand-tinted with `text-destructive`.
 *
 * `align="start"` is the one documented exception: a card whose only actions
 * are deep links out of it (privacy, about, export) has no primary action, so
 * its links read with the text on the left rather than against it.
 */
export function SettingsCardActions({
  align = "end",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="settings-card-actions"
      className={cn(
        "flex flex-wrap items-center gap-2",
        align === "end" ? "justify-end" : "justify-start",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
