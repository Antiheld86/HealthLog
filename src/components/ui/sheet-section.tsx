"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * v1.17.0 — `SheetSection` is the collapsible disclosure primitive that
 * powers the sectioned single-sheet add flows (mood, cycle). Each section
 * carries a title, an optional leading icon, and a `summary` slot that
 * communicates what is selected inside it while collapsed (e.g. a count
 * badge) — so a closed section never hides its contents silently.
 *
 * Built on Radix Collapsible. The chevron rotates and the content height
 * animates open/closed via the `tw-animate-css` `collapsible-down/up`
 * keyframes; both motions are suppressed under `prefers-reduced-motion`.
 * Matches the shadcn new-york + zinc token language used across the app.
 */

interface SheetSectionProps {
  /** Section heading shown on the always-visible trigger row. */
  title: string;
  /**
   * A node rendered on the trigger row's trailing edge — typically a count
   * badge that reports what is selected inside while the section is
   * collapsed. Stays visible whether the section is open or closed.
   */
  summary?: React.ReactNode;
  /** Optional leading icon (a Lucide component or any node). */
  icon?: React.ReactNode;
  /** Whether the section starts expanded (uncontrolled). Defaults to closed. */
  defaultOpen?: boolean;
  /** Controlled open state. When set, pair with `onOpenChange`. */
  open?: boolean;
  /** Controlled open-state change handler. */
  onOpenChange?: (open: boolean) => void;
  /** Optional className merged onto the section wrapper. */
  className?: string;
  children: React.ReactNode;
}

export function SheetSection({
  title,
  summary,
  icon,
  defaultOpen = false,
  open,
  onOpenChange,
  className,
  children,
}: SheetSectionProps) {
  return (
    <CollapsiblePrimitive.Root
      // Controlled when `open` is provided, otherwise uncontrolled.
      {...(open === undefined ? { defaultOpen } : { open, onOpenChange })}
      data-slot="sheet-section"
      className={cn("border-border/60 border-t pt-3", className)}
    >
      <CollapsiblePrimitive.Trigger
        data-slot="sheet-section-trigger"
        // `w-full`, not `-mx-1 w-[calc(100%+0.5rem)] px-1`. The old pair held
        // the row's text at the section's own left edge while pushing the box
        // 4 px outward on each side, purely to hold the focus ring off the
        // label — but a Tailwind ring is drawn OUTSIDE the border box anyway,
        // so the bleed bought nothing and made every row 8 px wider than the
        // sheet body that scrolls it. In the desktop dialog, whose body has no
        // horizontal padding to absorb it, that surfaced as a sideways-
        // scrollable form on the cycle and mood sheets.
        className="group focus-visible:ring-ring/50 flex w-full items-center gap-2 rounded-md py-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        {icon ? (
          <span
            className="text-muted-foreground flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4"
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}
        <span className="text-foreground flex-1 text-sm font-medium">
          {title}
        </span>
        {summary ? (
          <span data-slot="sheet-section-summary" className="flex items-center">
            {summary}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className="text-muted-foreground h-4 w-4 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
        />
      </CollapsiblePrimitive.Trigger>
      <CollapsiblePrimitive.Content
        data-slot="sheet-section-content"
        className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden motion-reduce:animate-none"
      >
        <div className="space-y-3 pt-3 pb-1">{children}</div>
      </CollapsiblePrimitive.Content>
    </CollapsiblePrimitive.Root>
  );
}

/**
 * A compact "(N)" count badge for a `SheetSection` summary slot. Renders
 * nothing when `count <= 0`, so a section with no selections shows a bare
 * chevron rather than a "(0)".
 */
export function SheetSectionCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span
      data-slot="sheet-section-count"
      className="bg-primary/15 text-primary inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-xs font-medium tabular-nums"
    >
      {count}
    </span>
  );
}
