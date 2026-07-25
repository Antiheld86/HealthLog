"use client";

/**
 * One group row in the scope picker.
 *
 * The row is a `ListRow` carrying a group checkbox, the group name, a count
 * chip, and a disclosure that opens the leaf grid. The group checkbox is one
 * control for up to sixteen leaves, which is what makes the repeat visit two
 * interactions; the chevron is the escape hatch and never sits on the fast
 * path.
 *
 * `mixed` is a derived display state and never a click target: clicking a
 * partly-selected group turns it fully on. Only leaves are ever stored.
 */
import { ChevronDown } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { ListRow } from "@/components/ui/list-row";
import { TagChip } from "@/components/ui/tag-chip";
import { cn } from "@/lib/utils";
import type {
  ReportGroupId,
  ReportLeafId,
} from "@/lib/report-selection/catalogue";
import type { GroupCheckState } from "@/lib/report-selection/panel-state";

import { LeafGrid } from "./leaf-grid";

export function GroupRow({
  t,
  id,
  labelKey,
  leaves,
  selected,
  checkState,
  count,
  open,
  panelId,
  onToggleGroup,
  onToggleLeaf,
  onToggleOpen,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  id: ReportGroupId;
  labelKey: string;
  leaves: readonly ReportLeafId[];
  selected: ReadonlySet<ReportLeafId>;
  checkState: GroupCheckState;
  count: { on: number; total: number };
  open: boolean;
  panelId: string;
  onToggleGroup: () => void;
  onToggleLeaf: (leaf: ReportLeafId) => void;
  onToggleOpen: () => void;
}) {
  const label = t(labelKey);
  return (
    <ListRow className="space-y-2" data-testid={`report-group-row-${id}`}>
      <div className="flex min-h-11 items-center gap-3 sm:min-h-9">
        <Checkbox
          checked={
            checkState === "all"
              ? true
              : checkState === "mixed"
                ? "indeterminate"
                : false
          }
          onCheckedChange={onToggleGroup}
          aria-label={label}
          data-testid={`report-group-check-${id}`}
        />
        <span className="text-foreground min-w-0 flex-1 text-sm">{label}</span>
        <TagChip>
          {t("reportSelection.groupCount", {
            on: count.on,
            total: count.total,
          })}
        </TagChip>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={t("reportSelection.groupDisclosure", { group: label })}
          onClick={onToggleOpen}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 -m-1 flex size-8 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      </div>
      {open ? (
        <div id={panelId}>
          <LeafGrid
            t={t}
            leaves={leaves}
            selected={selected}
            onToggle={onToggleLeaf}
          />
        </div>
      ) : null}
    </ListRow>
  );
}
