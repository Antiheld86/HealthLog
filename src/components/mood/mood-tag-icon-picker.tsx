"use client";

import { useId, useMemo, useState } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import { foldForMatch } from "@/lib/i18n/fold-for-match";
import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import {
  MOOD_TAG_ICON_CATALOG,
  type MoodTagIconCatalogEntry,
} from "@/lib/mood/icon-catalog";
import { isMoodTagIconName, moodTagIcon } from "./mood-tag-icons";

/**
 * v1.17 — searchable icon picker over the shared curated catalog
 * (`src/lib/mood/icon-catalog.ts`: the server half feeds the custom-tag
 * icon allowlist, this client half renders the searchable grid). Search
 * filters on the icon name plus its English keyword aids; the grid is
 * sub-headed by catalog group and behaves as one ARIA radiogroup with a
 * roving tab stop, so Arrow keys walk the filtered set and Enter/Space
 * picks the focused tile. Tile selection language matches the mood-tag
 * tiles (`border-primary bg-primary/15 text-primary`).
 */

/** i18n keys for the catalog's fixed group headers. */
const ICON_GROUP_LABEL_KEYS: Record<string, string> = {
  emotions: "mood.manage.iconGroupEmotions",
  activities: "mood.manage.iconGroupActivities",
  health: "mood.manage.iconGroupHealth",
  food: "mood.manage.iconGroupFood",
  weather: "mood.manage.iconGroupWeather",
  places: "mood.manage.iconGroupPlaces",
  misc: "mood.manage.iconGroupMisc",
};

/**
 * Pure search filter — name, keyword, and translated group-header match.
 * Exported for unit tests. Entries the client bundle cannot draw are
 * excluded up front so the picker never offers a fallback-glyph tile.
 *
 * `groupLabels` maps a catalog group to the header the picker is CURRENTLY
 * rendering above it, so the words on screen in the reader's language are also
 * the words the box searches. Without it the only searchable text was the
 * English Lucide name and the English keyword aids, and a German reader who
 * typed what the picker itself had just shown them ("Gesundheit") got an empty
 * grid and "no icons found" — an empty table, with nothing to say it was the
 * language rather than the query.
 *
 * That is a partial close, stated rather than papered over: the per-icon
 * keywords ("happy", "gym", "coffee") stay English, so searching for "Herz" or
 * "kawa" still finds nothing. Translating them is ~80 icons times three aids
 * times six languages of new content, which is a decision about content rather
 * than about this filter. Omit the argument and the behaviour is the old one.
 *
 * Both sides go through `foldForMatch`, so accents and hyphens cannot make a
 * reader miss a header they can see.
 */
export function filterIconCatalog(
  catalog: readonly MoodTagIconCatalogEntry[],
  query: string,
  groupLabels: Readonly<Record<string, string>> = {},
): MoodTagIconCatalogEntry[] {
  const drawable = catalog.filter((entry) => isMoodTagIconName(entry.name));
  const needle = foldForMatch(query);
  if (needle.length === 0) return drawable;
  return drawable.filter(
    (entry) =>
      foldForMatch(entry.name).includes(needle) ||
      entry.keywords.some((keyword) =>
        foldForMatch(keyword).includes(needle),
      ) ||
      foldForMatch(groupLabels[entry.group] ?? "").includes(needle),
  );
}

export interface MoodTagIconPickerProps {
  /** Currently selected icon name (null → nothing selected yet). */
  value: string | null;
  onChange: (iconName: string) => void;
}

export function MoodTagIconPicker({ value, onChange }: MoodTagIconPickerProps) {
  const { t } = useTranslations();
  const [query, setQuery] = useState("");
  const groupLabelId = useId();

  // The headers the grid is about to render, so the search box matches the
  // words the reader can see rather than only their English source.
  const groupLabels = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(ICON_GROUP_LABEL_KEYS).map(([group, key]) => [
          group,
          t(key),
        ]),
      ),
    [t],
  );

  const filtered = useMemo(
    () => filterIconCatalog(MOOD_TAG_ICON_CATALOG, query, groupLabels),
    [query, groupLabels],
  );

  // One flat roving radiogroup across the (filtered) grid; the group
  // sub-headers are presentation only.
  const selectedIndex = filtered.findIndex((entry) => entry.name === value);
  const { getRadioProps } = useRovingRadioGroup({
    count: filtered.length,
    selectedIndex,
    onSelect: (index) => {
      const entry = filtered[index];
      if (entry) onChange(entry.name);
    },
  });

  // Group the filtered list while preserving catalog order; remember
  // each entry's flat index for the roving wiring.
  const groups: {
    group: string;
    entries: { entry: MoodTagIconCatalogEntry; index: number }[];
  }[] = [];
  filtered.forEach((entry, index) => {
    const last = groups[groups.length - 1];
    if (last && last.group === entry.group) {
      last.entries.push({ entry, index });
    } else {
      groups.push({ group: entry.group, entries: [{ entry, index }] });
    }
  });

  return (
    <div className="space-y-3" data-slot="mood-tag-icon-picker">
      <span id={groupLabelId} className="sr-only">
        {t("mood.manage.iconPickerTitle")}
      </span>
      <div className="relative">
        <Search
          className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("mood.manage.iconSearchPlaceholder")}
          aria-label={t("mood.manage.iconSearchPlaceholder")}
          className="px-9"
          autoComplete="off"
          autoCapitalize="none"
        />
        {query.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setQuery("")}
            aria-label={t("mood.manage.iconSearchClear")}
            className="absolute top-1/2 right-1 h-8 w-8 -translate-y-1/2"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-start gap-2 py-2 text-sm">
          <span>{t("mood.manage.iconSearchEmpty")}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setQuery("")}
          >
            {t("mood.manage.iconSearchClear")}
          </Button>
        </div>
      ) : (
        <div
          role="radiogroup"
          aria-labelledby={groupLabelId}
          className="max-h-64 space-y-3 overflow-y-auto pr-1"
        >
          {groups.map(({ group, entries }) => (
            <div key={group} className="space-y-1.5">
              <p className="text-muted-foreground text-xs font-medium">
                {t(ICON_GROUP_LABEL_KEYS[group] ?? "mood.manage.iconGroupMisc")}
              </p>
              <div className="flex flex-wrap gap-2">
                {entries.map(({ entry, index }) => {
                  const Icon = moodTagIcon(entry.name);
                  const isActive = entry.name === value;
                  return (
                    <button
                      key={entry.name}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      aria-label={entry.name}
                      title={entry.name}
                      data-slot="mood-icon-tile"
                      data-icon={entry.name}
                      onClick={() => onChange(entry.name)}
                      {...getRadioProps(index)}
                      className={`focus-visible:ring-ring focus-visible:ring-offset-background flex h-11 w-11 items-center justify-center rounded-xl border transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none ${
                        isActive
                          ? "border-primary bg-primary/15 text-primary"
                          : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
                      }`}
                    >
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
