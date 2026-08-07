import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * `<StatTile>` — the one label/value mini tile in the Admin console.
 *
 * Four hand-rolled variants of this box existed side by side: `StatusItem`
 * (`bg-muted/50 p-3`), the encryption section's local `Stat`
 * (`bg-muted/40 px-3 py-2`), the user-management inline panels
 * (`bg-muted/80 p-4`), and the backups upload box (`bg-muted/30 p-3`). Four
 * fills, three paddings, one role. This is the role.
 *
 * `icon` is optional — a tile with a glyph and one without still share the
 * frame, so a grid can mix them without a step in tile height.
 */
export function StatTile({
  icon: Icon,
  label,
  value,
  valueClassName,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  label: React.ReactNode;
  value: React.ReactNode;
  /** Extra classes on the value line — a status colour, or `font-mono`. */
  valueClassName?: string;
  className?: string;
}) {
  return (
    <div
      data-slot="stat-tile"
      className={cn("bg-muted/50 space-y-1 rounded-lg p-3", className)}
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
        {label}
      </div>
      <p className={cn("text-sm font-semibold", valueClassName)}>{value}</p>
    </div>
  );
}
