"use client";

/**
 * The per-leaf checkbox grid inside an expanded group.
 *
 * A dense read-out, not a field grid: `gap-2` on the enforced scale, two
 * columns from the `sm` breakpoint. Each row clears the tap floor and carries
 * a stable test id so an end-to-end assertion binds to the leaf, not to text
 * that a breakpoint may hide. The id ends with the mounting surface, because
 * one page carries two pickers.
 */
import { Checkbox } from "@/components/ui/checkbox";
import { MEASUREMENT_TYPE_ICONS } from "@/components/measurements/measurement-list-meta";
import {
  leafLabelKey,
  type ReportLeafId,
} from "@/lib/report-selection/catalogue";

import type { ReportScopeSurface } from "./surface";

export function LeafGrid({
  t,
  surface,
  leaves,
  selected,
  onToggle,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  surface: ReportScopeSurface;
  leaves: readonly ReportLeafId[];
  selected: ReadonlySet<ReportLeafId>;
  onToggle: (leaf: ReportLeafId) => void;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {leaves.map((leaf) => {
        const Icon = MEASUREMENT_TYPE_ICONS[leaf];
        return (
          <label
            key={leaf}
            data-testid={`report-leaf-${leaf}-${surface}`}
            className="flex min-h-11 items-center gap-3 text-sm sm:min-h-9"
          >
            <Checkbox
              checked={selected.has(leaf)}
              onCheckedChange={() => onToggle(leaf)}
            />
            {Icon ? (
              <Icon
                className="text-muted-foreground size-4 shrink-0"
                aria-hidden
              />
            ) : null}
            <span className="text-foreground min-w-0 flex-1">
              {t(leafLabelKey(leaf))}
            </span>
          </label>
        );
      })}
    </div>
  );
}
