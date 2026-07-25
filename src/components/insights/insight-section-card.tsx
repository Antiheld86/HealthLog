import type { ReactNode } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * The shell every Insights overview section paints its body on.
 *
 * Six sections had hand-rolled the same `bg-card … rounded-xl border p-4
 * md:p-6` literal, and the six copies had already drifted apart on the one
 * thing the literal did not pin: the inner rhythm. Three used `gap-3`, two
 * `gap-2`, one `space-y-4` — 8, 12, and 16 px between blocks, one under the
 * other in the same column. This primitive composes `<Card>` so the frame
 * comes from the card contract (radius, border, surface, `px-4 md:px-6`
 * inset, `py-4 md:py-6`) and pins the inner rhythm at one step: `gap-3`.
 *
 * Outer geometry is unchanged from the literals it replaces. What changes:
 * the two `gap-2` bodies open by 4 px, the `space-y-4` body tightens by
 * 4 px, and all six pick up the card's `shadow-sm` — which their `<Card>`
 * neighbours in the same column already had.
 *
 * Density lives here, never on a slot: `pt-*` on the content or `pb-*` on a
 * header fights the gap-based Card contract (lint-enforced).
 *
 * RSC-safe: no hooks, no browser API.
 *
 * @see .planning/audits/2026-07-05-fable/UI-STANDARDS.md §1
 */
export function InsightSectionCard({
  children,
  slot,
  flush = false,
  className,
  ...props
}: {
  children: ReactNode;
  /** The card's `data-slot` hook. Defaults to `insight-section-card`. */
  slot?: string;
  /**
   * The body is an edge-to-edge list whose rows own their own inset (a
   * `divide-y` ledger, not a gap stack), so the card drops its own padding
   * and the caller keeps the row rhythm. The frame is identical either way.
   */
  flush?: boolean;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<"div">, "children">) {
  return (
    <Card
      data-slot={slot ?? "insight-section-card"}
      className={cn(
        "w-full min-w-0",
        flush ? "gap-0 py-0" : "gap-3 py-4 md:py-6",
        className,
      )}
      {...props}
    >
      {flush ? (
        children
      ) : (
        <CardContent className="flex min-w-0 flex-col gap-3">
          {children}
        </CardContent>
      )}
    </Card>
  );
}
