"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Tag } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useTranslations } from "@/lib/i18n/context";
import { moodTagIcon } from "./mood-tag-icons";
import { TagEditorSheet } from "./manage/tag-editor-sheet";
import { apiGet } from "@/lib/api/api-fetch";

/**
 * v1.8.5 / v1.12.0 — structured mood-tag capture surface (Daylio-style).
 *
 * Loads the global Category -> Tag catalog from `/api/mood/tags` and
 * renders one labelled group per category. Two tag kinds are surfaced:
 *
 *   - `BINARY` — an icon-above-label toggle tile. Multi-select across
 *     categories; the selection is a controlled set of tag keys lifted
 *     to the parent form, which sends them as `tagKeys` on create.
 *   - `RATED` — a 1..scaleMax segmented control (a Yes/No pair when
 *     `scaleMax === 2`). The score is lifted as a `{ key, rating }`
 *     entry and sent as `ratedFactors`. `inverse` factors (higher =
 *     worse day) carry the same control; the inversion is a read-side
 *     concern handled server-side.
 *
 * Additive next to the legacy free-text tag input: a user can use
 * either or both. Renders nothing if the catalog is empty so a
 * deployment that cleared the taxonomy degrades to the free-text field.
 *
 * v1.17 — three management-suite additions: (1) a custom tag renders
 * its decrypted `label` (the v1.13 API field the web picker previously
 * ignored — a custom tag used to paint its raw key through the `t()`
 * fallback); (2) a trailing ghost "+" tile per group opens the shared
 * create sheet with that group preselected, and the fresh tag is
 * selected in the form right away; (3) the render order is exactly the
 * server-resolved per-user order — no client-side sorting.
 */

interface CatalogTag {
  key: string;
  labelKey: string;
  /** Decrypted custom label (v1.13+); null/absent for catalogue tags. */
  label?: string | null;
  icon: string | null;
  kind: "BINARY" | "RATED";
  scaleMin: number;
  scaleMax: number;
  inverse: boolean;
  custom?: boolean;
}

interface CatalogCategory {
  key: string;
  labelKey: string;
  /** Decrypted custom group label; null/absent for seeded categories. */
  label?: string | null;
  icon: string | null;
  custom?: boolean;
  tags: CatalogTag[];
}

interface CatalogResponse {
  categories: CatalogCategory[];
}

export interface RatedFactor {
  key: string;
  rating: number;
}

export function MoodTagPicker({
  selected,
  onToggle,
  ratedFactors = [],
  onRateFactor,
  mode = "all",
}: {
  /** Selected binary tag keys (sent as `tagKeys`). */
  selected: string[];
  onToggle: (tagKey: string) => void;
  /** Current rated-factor scores (sent as `ratedFactors`). */
  ratedFactors?: RatedFactor[];
  /**
   * Sets (or, when `rating === null`, clears) a rated factor's score.
   * Required for the RATED segmented controls to render interactively;
   * when omitted the picker only surfaces binary tags.
   */
  onRateFactor?: (key: string, rating: number | null) => void;
  /**
   * v1.17.0 — which tag kinds to surface. The sectioned add-sheet renders
   * the binary tiles under "More tags" (`mode="binary"`) and the segmented
   * factor ratings under "Factors" (`mode="rated"`) as two separate
   * sections; the default `"all"` keeps the legacy interleaved layout.
   */
  mode?: "all" | "binary" | "rated";
}) {
  const { isAuthenticated } = useAuth();
  const { t } = useTranslations();
  // v1.17 — inline-create sheet state: the group key the tapped "+"
  // tile belongs to, or null when closed.
  const [createGroupKey, setCreateGroupKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.moodTagCatalog(),
    queryFn: async () => {
      return apiGet<CatalogResponse>("/api/mood/tags");
    },
    enabled: isAuthenticated,
    // The catalog only changes on a migration / admin edit.
    staleTime: 60 * 60 * 1000,
  });

  if (isLoading) {
    return <Skeleton className="h-24 w-full rounded-lg" />;
  }

  if (!data || data.categories.length === 0) {
    return null;
  }

  const selectedSet = new Set(selected);
  const ratingByKey = new Map(ratedFactors.map((f) => [f.key, f.rating]));
  const showBinary = mode !== "rated";
  const showRated = mode !== "binary";

  const groupOptions = data.categories.map((category) => ({
    key: category.key,
    name: category.label ?? t(category.labelKey),
  }));
  // The plain read drops empty categories, so before the first custom
  // tag exists there is no Custom node to hang the "+" tile on —
  // synthesize the bootstrap group so inline creation is always
  // reachable.
  const hasCustomGroup = data.categories.some((c) => c.key === "custom");

  return (
    <div className="space-y-4" data-slot="mood-tag-picker">
      {data.categories.map((category) => {
        const CategoryIcon = moodTagIcon(category.icon);
        const binaryTags = showBinary
          ? category.tags.filter((tag) => tag.kind !== "RATED")
          : [];
        const ratedTags = showRated
          ? category.tags.filter((tag) => tag.kind === "RATED")
          : [];
        // Self-gate an empty category (e.g. a RATED-only category when no
        // `onRateFactor` is wired, or a mode that filters all tags out) so
        // the picker never shows a bare heading.
        if (binaryTags.length === 0 && ratedTags.length === 0) return null;
        if (ratedTags.length > 0 && !onRateFactor && binaryTags.length === 0) {
          return null;
        }

        return (
          <div key={category.key} className="space-y-2">
            <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
              <CategoryIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{category.label ?? t(category.labelKey)}</span>
            </div>

            {showBinary && (
              <div className="flex flex-wrap gap-2">
                {binaryTags.map((tag) => {
                  const TagIcon = moodTagIcon(tag.icon);
                  const isActive = selectedSet.has(tag.key);
                  // v1.17 — a custom tag carries its decrypted label;
                  // catalogue tags keep resolving their i18n key.
                  const label = tag.label ?? t(tag.labelKey);
                  return (
                    <button
                      key={tag.key}
                      type="button"
                      onClick={() => onToggle(tag.key)}
                      aria-pressed={isActive}
                      data-slot="mood-tag-tile"
                      className={`flex min-h-16 w-[4.5rem] flex-col items-center justify-center gap-1 rounded-xl border p-2 text-center transition-colors ${
                        isActive
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      <TagIcon className="h-5 w-5" aria-hidden="true" />
                      <span className="text-2xs leading-tight">{label}</span>
                    </button>
                  );
                })}
                <AddTagTile
                  label={t("mood.addTagInline")}
                  onClick={() => setCreateGroupKey(category.key)}
                />
              </div>
            )}

            {ratedTags.length > 0 && onRateFactor && (
              <div className="space-y-2" data-slot="mood-factor-ratings">
                {ratedTags.map((tag) => {
                  const TagIcon = moodTagIcon(tag.icon);
                  const label = tag.label ?? t(tag.labelKey);
                  const current = ratingByKey.get(tag.key);
                  const isBinaryScale = tag.scaleMax - tag.scaleMin === 1;
                  const steps: number[] = [];
                  for (let v = tag.scaleMin; v <= tag.scaleMax; v++) {
                    steps.push(v);
                  }
                  const groupLabelId = `mood-factor-${tag.key}`;
                  return (
                    <div
                      key={tag.key}
                      className="flex items-center justify-between gap-3"
                      data-slot="mood-factor-rating"
                    >
                      <span
                        id={groupLabelId}
                        className="text-foreground/85 flex items-center gap-1.5 text-xs"
                      >
                        <TagIcon className="h-4 w-4" aria-hidden="true" />
                        {label}
                      </span>
                      <div
                        role="radiogroup"
                        aria-labelledby={groupLabelId}
                        className="flex items-center gap-1"
                      >
                        {steps.map((value) => {
                          const isActive = current === value;
                          const optionLabel = isBinaryScale
                            ? value === tag.scaleMax
                              ? t("mood.factorYes")
                              : t("mood.factorNo")
                            : String(value);
                          const a11yLabel = isBinaryScale
                            ? optionLabel
                            : t("mood.factorRatingOption", {
                                label,
                                value: String(value),
                                max: String(tag.scaleMax),
                              });
                          return (
                            <button
                              key={value}
                              type="button"
                              role="radio"
                              aria-checked={isActive}
                              aria-label={a11yLabel}
                              // Re-tap the active step to clear the score.
                              onClick={() =>
                                onRateFactor(tag.key, isActive ? null : value)
                              }
                              // v1.12 — `rounded-lg` aligns the step
                              // radius with the tag tiles and mood faces;
                              // selected-state matches them too.
                              className={`flex h-8 items-center justify-center rounded-lg border px-2 text-xs tabular-nums transition-colors ${
                                isBinaryScale ? "min-w-12" : "min-w-8"
                              } ${
                                isActive
                                  ? "border-primary bg-primary/15 text-primary"
                                  : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                              }`}
                            >
                              {optionLabel}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Bootstrap node for the seeded Custom group: before the first
          custom tag exists the plain read carries no `custom` category,
          so the inline-create entry point renders synthetically. Only the
          binary-tag surfaces it (custom tags are binary). */}
      {showBinary && !hasCustomGroup && (
        <div className="space-y-2" data-slot="mood-tag-custom-bootstrap">
          <div className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <Tag className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("mood.tagCategory.custom")}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            <AddTagTile
              label={t("mood.addTagInline")}
              onClick={() => setCreateGroupKey("custom")}
            />
          </div>
        </div>
      )}

      {createGroupKey !== null && (
        <TagEditorSheet
          open
          onOpenChange={(open) => {
            if (!open) setCreateGroupKey(null);
          }}
          groups={
            hasCustomGroup
              ? groupOptions
              : [
                  ...groupOptions,
                  { key: "custom", name: t("mood.tagCategory.custom") },
                ]
          }
          initialGroupKey={createGroupKey}
          onCreated={(created) => onToggle(created.key)}
        />
      )}
    </div>
  );
}

/**
 * v1.17 — trailing ghost "+" tile: same footprint as a tag tile,
 * dashed border, opens the inline create sheet for its group.
 */
function AddTagTile({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-slot="mood-tag-add-tile"
      className="border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring focus-visible:ring-offset-background flex min-h-16 w-[4.5rem] flex-col items-center justify-center gap-1 rounded-xl border border-dashed p-2 text-center transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      <Plus className="h-5 w-5" aria-hidden="true" />
      <span className="text-2xs leading-tight">{label}</span>
    </button>
  );
}
