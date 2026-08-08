"use client";

/**
 * `<SettingsInfoTile>` — the one callout shape for Settings.
 *
 * Before this primitive, every section hand-rolled its own notice box:
 * `border-l-2`/`border-l-4`, `rounded-md`/`rounded-lg`, mismatched
 * border/background tone intensities, and raw palette colours used as
 * text (which fail AA in light mode). The tile fixes the surface to a
 * single contract — icon left, short text right, a tone-coloured left
 * border — and routes every tone through the semantic tokens so the
 * same notice reads identically in light and dark.
 *
 * Tones map to the project's semantic colour tokens:
 *   - `info`     → `--info`      (neutral guidance)
 *   - `warning`  → `--warning`   (caution / override / reconnect)
 *   - `success`  → `--success`   (confirmation)
 *   - `primary`  → `--primary`   (brand-accented instruction)
 *   - `neutral`  → muted surface (low-emphasis aside)
 */

import * as React from "react";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export type SettingsInfoTileTone =
  "info" | "warning" | "success" | "primary" | "neutral";

const TONE_SURFACE: Record<SettingsInfoTileTone, string> = {
  info: "border-info/40 bg-info/10",
  warning: "border-warning/40 bg-warning/10",
  success: "border-success/40 bg-success/10",
  primary: "border-primary/40 bg-primary/10",
  neutral: "border-border bg-muted/30",
};

const TONE_ICON: Record<SettingsInfoTileTone, string> = {
  info: "text-info",
  warning: "text-warning",
  success: "text-success",
  primary: "text-primary",
  neutral: "text-muted-foreground",
};

export interface SettingsInfoTileProps extends Omit<
  React.ComponentProps<"div">,
  "title"
> {
  /** Lucide icon component; rendered in the tone colour. */
  icon: LucideIcon;
  /** Visual tone — routes through the semantic colour tokens. */
  tone?: SettingsInfoTileTone;
  /** Optional emphasised first line. */
  title?: React.ReactNode;
  /** Body content — muted text. */
  children?: React.ReactNode;
  /** Optional extra classes on the outer wrapper. */
  className?: string;
}

export function SettingsInfoTile({
  icon: Icon,
  tone = "info",
  title,
  children,
  className,
  ...props
}: SettingsInfoTileProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border-l-4 p-3 text-sm",
        TONE_SURFACE[tone],
        className,
      )}
      {...props}
    >
      <Icon
        className={cn("mt-0.5 h-4 w-4 shrink-0", TONE_ICON[tone])}
        aria-hidden="true"
      />
      <div className="min-w-0 space-y-1">
        {title ? <p className="text-foreground font-medium">{title}</p> : null}
        {children ? (
          <div className="text-muted-foreground">{children}</div>
        ) : null}
      </div>
    </div>
  );
}
