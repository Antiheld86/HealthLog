"use client";

/**
 * The one scope picker. Both surfaces that choose what a report contains — the
 * export panel and the share-link create form — mount this exact component, so
 * two selection UIs cannot drift apart.
 *
 * Twelve group rows plus a fenced tier below a separator. The fenced tier has
 * NO group checkbox: there is no control anywhere in this component that can
 * turn on more than one sensitive leaf at a time, and there is no select-all.
 * The fence uses no colour to mark itself — a separator, a heading, and
 * per-leaf controls. A red tint would be decoration; status colour is reserved
 * for meaning.
 *
 * The component is controlled: it owns no selection state, only which rows are
 * expanded and what each group looked like before it was switched off.
 */
import { useId, useState } from "react";

import { Separator } from "@/components/ui/separator";
import { useTranslations } from "@/lib/i18n/context";
import {
  REPORT_GROUPS,
  SENSITIVE_GROUP_ID,
  type ReportGroupId,
  type ReportLeafId,
} from "@/lib/report-selection/catalogue";
import {
  groupCheckState,
  groupCount,
  toggleGroup,
  toggleLeaf,
} from "@/lib/report-selection/panel-state";

import { GroupRow } from "./group-row";
import { LeafGrid } from "./leaf-grid";

export function ReportScopePicker({
  selected,
  onChange,
  hiddenLeaves,
}: {
  selected: ReadonlySet<ReportLeafId>;
  onChange: (next: Set<ReportLeafId>) => void;
  /**
   * Leaves this surface must not offer at all. The share-link form passes the
   * insurance leaf: the server refuses it with a 422, and a control that
   * cannot be honoured has no business rendering.
   */
  hiddenLeaves?: readonly ReportLeafId[];
}) {
  const { t } = useTranslations();
  const idPrefix = useId();
  const [openGroups, setOpenGroups] = useState<ReadonlySet<ReportGroupId>>(
    new Set(),
  );
  // What each group looked like before it was switched off, so switching it
  // back on inside one session restores the pattern instead of flooding it.
  const [remembered, setRemembered] = useState<ReadonlySet<ReportLeafId>>(
    new Set(),
  );

  const hidden = new Set(hiddenLeaves ?? []);
  const groups = REPORT_GROUPS.map((group) => ({
    ...group,
    leaves: group.leaves.filter((leaf) => !hidden.has(leaf)),
  })).filter((group) => group.leaves.length > 0);

  const plainGroups = groups.filter((g) => g.id !== SENSITIVE_GROUP_ID);
  const sensitiveGroup = groups.find((g) => g.id === SENSITIVE_GROUP_ID);

  const handleLeaf = (leaf: ReportLeafId) => {
    setRemembered(new Set(selected));
    onChange(toggleLeaf(selected, leaf));
  };

  const handleGroup = (group: ReportGroupId) => {
    setRemembered(new Set(selected));
    onChange(toggleGroup(selected, group, remembered));
  };

  return (
    <div className="space-y-3" data-testid="report-scope-picker">
      {plainGroups.map((group) => (
        <GroupRow
          key={group.id}
          t={t}
          id={group.id}
          labelKey={group.labelKey}
          leaves={group.leaves}
          selected={selected}
          checkState={groupCheckState(group.id, selected)}
          count={groupCount(group.id, selected)}
          open={openGroups.has(group.id)}
          panelId={`${idPrefix}-${group.id}`}
          onToggleGroup={() => handleGroup(group.id)}
          onToggleLeaf={handleLeaf}
          onToggleOpen={() =>
            setOpenGroups((prev) => {
              const next = new Set(prev);
              if (next.has(group.id)) next.delete(group.id);
              else next.add(group.id);
              return next;
            })
          }
        />
      ))}

      {sensitiveGroup ? (
        <div data-testid="report-sensitive-tier">
          <Separator className="my-4" />
          <p className="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
            {t(sensitiveGroup.labelKey)}
          </p>
          <p className="text-muted-foreground mb-2 text-xs">
            {t("reportSelection.sensitiveHint")}
          </p>
          <LeafGrid
            t={t}
            leaves={sensitiveGroup.leaves}
            selected={selected}
            onToggle={handleLeaf}
          />
        </div>
      ) : null}
    </div>
  );
}
