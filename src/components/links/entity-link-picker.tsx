"use client";

/**
 * The shared entity link picker: a searchable, grouped, multi-select surface
 * for attaching records (documents, lab results, illness episodes, …) to a
 * visit or a vaccination.
 *
 * One pattern, two consumers. The visit form mounts one per family (documents,
 * labs, conditions); the vaccination form mounts the documents one. Both used
 * to render a flat capped list with no search — 30 lab values arrived as 25
 * undifferentiated rows and anything past the cap was unreachable. This block
 * replaces that with an inline summary (removable chips + an add button) and a
 * sheet that searches, groups and multi-selects.
 *
 * **The gate blanks the block, it does not post-filter it.** The caller mounts
 * this only for a module that is on; a switched-off module leaves nothing here.
 *
 * Nothing here can block a save: the selection starts empty and stays valid
 * empty, and the link cap stays authoritative on the server. This surface only
 * ever raises the FETCH limit so grouping has something to group; it never
 * raises what may be linked.
 */
import { useMemo, useState } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

export interface EntityLinkOption {
  id: string;
  label: string;
  /** Already-localized date string, or null for a target with no date. */
  dateLabel?: string | null;
  /** Optional secondary muted line (e.g. the analyte under a panel group). */
  meta?: string | null;
  /**
   * Grouping key + already-localized heading. Omit or null for a flat list.
   * Options with the same key collapse under one heading, in first-seen order.
   */
  group?: { key: string; label: string } | null;
}

/** Lowercased haystack for the client search over one option. */
function haystack(option: EntityLinkOption): string {
  return [option.label, option.meta, option.group?.label, option.dateLabel]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Client-side search: the whole term must appear in the option's haystack. */
export function filterOptions(
  options: EntityLinkOption[],
  term: string,
): EntityLinkOption[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) => haystack(option).includes(needle));
}

export interface EntityLinkGroup {
  /** Group key, or null for the flat (ungrouped) bucket. */
  key: string | null;
  /** Heading to render, or null when the list is flat. */
  label: string | null;
  options: EntityLinkOption[];
}

/**
 * Collapse options into ordered groups. A group's position is where its first
 * member appears, so the caller's own ordering (usually newest first) carries
 * through. When no option carries a group, the whole list is one flat bucket
 * with a null heading.
 */
export function groupOptions(options: EntityLinkOption[]): EntityLinkGroup[] {
  const anyGrouped = options.some((option) => option.group != null);
  if (!anyGrouped) {
    return options.length ? [{ key: null, label: null, options }] : [];
  }
  const order: string[] = [];
  const byKey = new Map<string, EntityLinkGroup>();
  for (const option of options) {
    const key = option.group?.key ?? "__ungrouped__";
    const label = option.group?.label ?? null;
    let group = byKey.get(key);
    if (!group) {
      group = { key, label, options: [] };
      byKey.set(key, group);
      order.push(key);
    }
    group.options.push(option);
  }
  return order.map((key) => byKey.get(key)!);
}

/**
 * Toggle a whole group's ids: if every id is already selected, remove them
 * all; otherwise add the missing ones. Preserves order and never duplicates.
 */
export function toggleAll(selected: string[], ids: string[]): string[] {
  const selectedSet = new Set(selected);
  const allOn = ids.every((id) => selectedSet.has(id));
  if (allOn) {
    const drop = new Set(ids);
    return selected.filter((id) => !drop.has(id));
  }
  const merged = [...selected];
  for (const id of ids) if (!selectedSet.has(id)) merged.push(id);
  return merged;
}

function toggleOne(selected: string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((entry) => entry !== id)
    : [...selected, id];
}

export function EntityLinkPicker({
  icon: Icon,
  title,
  slot,
  options,
  pending,
  selected,
  onChange,
  searchPlaceholder,
  emptyLabel,
}: {
  icon: LucideIcon;
  title: string;
  /** data-slot on the inline block; the module-gate tests assert this. */
  slot: string;
  options: EntityLinkOption[];
  pending: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
  searchPlaceholder: string;
  emptyLabel: string;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");

  const optionById = useMemo(() => {
    const map = new Map<string, EntityLinkOption>();
    for (const option of options) map.set(option.id, option);
    return map;
  }, [options]);

  const groups = useMemo(
    () => groupOptions(filterOptions(options, term)),
    [options, term],
  );

  const selectedSet = new Set(selected);
  const selectedChips = selected
    .map((id) => optionById.get(id))
    .filter((option): option is EntityLinkOption => option != null);

  return (
    <div className="space-y-2" data-slot={slot}>
      <div className="flex items-center gap-2">
        <Icon className="text-foreground size-4 shrink-0" aria-hidden />
        <span className="text-sm font-medium">{title}</span>
        {selected.length > 0 ? (
          <Badge variant="outline" className="ml-auto">
            {selected.length}
          </Badge>
        ) : null}
      </div>

      {pending ? (
        <Skeleton className="h-9 w-full rounded-md" />
      ) : options.length === 0 ? (
        <p className="text-muted-foreground text-xs">{emptyLabel}</p>
      ) : (
        <div className="space-y-2">
          {selectedChips.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" data-slot={`${slot}-chips`}>
              {selectedChips.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    data-slot={`${slot}-chip`}
                    onClick={() => onChange(toggleOne(selected, option.id))}
                    className="border-border bg-muted/40 hover:bg-muted focus-visible:ring-ring/50 flex min-h-8 items-center gap-1.5 rounded-full border px-3 text-xs focus-visible:ring-[3px] focus-visible:outline-none"
                  >
                    <span className="text-foreground max-w-[12rem] truncate">
                      {option.label}
                    </span>
                    <X
                      className="text-muted-foreground size-3 shrink-0"
                      aria-hidden
                    />
                    <span className="sr-only">{t("links.picker.remove")}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-9"
            data-slot={`${slot}-add`}
            onClick={() => setOpen(true)}
          >
            <Plus className="size-4" aria-hidden />
            {t("links.picker.add")}
          </Button>
        </div>
      )}

      <ResponsiveSheet
        open={open}
        onOpenChange={setOpen}
        title={title}
        contentWidth="lg"
      >
        <div className="space-y-3">
          <div className="relative">
            <Search
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
              aria-hidden
            />
            <Input
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="pl-9"
              data-slot={`${slot}-search`}
            />
          </div>

          {groups.length === 0 ? (
            <p className="text-muted-foreground px-1 py-6 text-center text-sm">
              {t("links.picker.searchNoMatch")}
            </p>
          ) : (
            <div className="max-h-[50vh] space-y-4 overflow-y-auto overscroll-contain">
              {groups.map((group) => {
                const groupIds = group.options.map((option) => option.id);
                return (
                  <div key={group.key ?? "__flat__"} className="space-y-1">
                    {group.label ? (
                      <div className="flex items-center justify-between gap-2 px-1">
                        <span
                          className="text-muted-foreground text-xs font-medium"
                          data-slot={`${slot}-group-heading`}
                        >
                          {group.label}
                        </span>
                        <button
                          type="button"
                          data-slot={`${slot}-group-select`}
                          onClick={() =>
                            onChange(toggleAll(selected, groupIds))
                          }
                          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
                        >
                          {t("links.picker.selectAll")}
                        </button>
                      </div>
                    ) : null}
                    <ul className="space-y-1">
                      {group.options.map((option) => {
                        const on = selectedSet.has(option.id);
                        return (
                          <li key={option.id}>
                            <button
                              type="button"
                              aria-pressed={on}
                              data-slot={`${slot}-option`}
                              onClick={() =>
                                onChange(toggleOne(selected, option.id))
                              }
                              className={cn(
                                "border-border hover:bg-muted/50 focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-2 rounded-md border px-3 text-left focus-visible:ring-[3px] focus-visible:outline-none",
                                on && "border-primary/40 bg-primary/5",
                              )}
                            >
                              <Check
                                className={cn(
                                  "size-4 shrink-0",
                                  on ? "opacity-100" : "opacity-0",
                                )}
                                aria-hidden
                              />
                              <span className="min-w-0 flex-1">
                                <span className="text-foreground block truncate text-sm">
                                  {option.label}
                                </span>
                                {option.meta ? (
                                  <span className="text-muted-foreground block truncate text-xs">
                                    {option.meta}
                                  </span>
                                ) : null}
                              </span>
                              {option.dateLabel ? (
                                <span className="text-muted-foreground shrink-0 text-xs">
                                  {option.dateLabel}
                                </span>
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex justify-end border-t pt-3">
            <Button type="button" onClick={() => setOpen(false)}>
              {t("links.picker.done")}
            </Button>
          </div>
        </div>
      </ResponsiveSheet>
    </div>
  );
}
