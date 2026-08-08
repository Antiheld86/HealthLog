"use client";

/**
 * The catalogue arm of the identity pair.
 *
 * Searches the static antigen catalogue by its localised display name and by
 * the generic synonyms shipped with each entry — never a trade name, because
 * none exist in the catalogue; a person who types a brand matches nothing here
 * and falls back to the free-text arm, which is exactly where a Pass's own
 * wording belongs. Picking an entry sets `antigenSlug`; it never touches what
 * the person typed in the free-text field.
 *
 * The list is a static import, so the search is an in-memory filter with no
 * round trip and no provider dependency. Grouped by category so a lifetime Pass
 * (childhood through travel) reads in the order a person recognises.
 */
import { useMemo, useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  VACCINE_CATALOG,
  type VaccineSeed,
} from "@/lib/vaccinations/vaccine-catalog";
import { CatalogInfo } from "./catalog-info";

export function CatalogPicker({
  value,
  onChange,
  disabled,
}: {
  /** The chosen catalogue slug, or null. */
  value: string | null;
  onChange: (slug: string | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");

  const name = (slug: string) => t(`vaccinations.catalog.${slug}`);

  const matches = useMemo(() => {
    const needle = term.trim().toLowerCase();
    const scored = VACCINE_CATALOG.filter((entry) => {
      if (!needle) return true;
      if (name(entry.slug).toLowerCase().includes(needle)) return true;
      if (entry.slug.includes(needle)) return true;
      return (entry.synonyms ?? []).some((s) =>
        s.toLowerCase().includes(needle),
      );
    });
    return scored;
    // `name` closes over `t`, which is stable per locale; term drives the recompute.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, t]);

  const selected: VaccineSeed | undefined = value
    ? VACCINE_CATALOG.find((entry) => entry.slug === value)
    : undefined;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              // `role="combobox"` is not a name-from-content role, so the
              // visible placeholder span does not name the control for a screen
              // reader and the wrapping field label targets an id this button
              // does not carry. Name it explicitly with the field's own label.
              aria-label={t("vaccinations.form.catalogLabel")}
              disabled={disabled}
              data-slot="vaccination-catalog-trigger"
              className="min-h-11 min-w-0 flex-1 justify-between font-normal"
            >
              <span
                className={cn(
                  "truncate",
                  selected ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {selected
                  ? name(selected.slug)
                  : t("vaccinations.form.catalogNone")}
              </span>
              <ChevronsUpDown
                className="size-4 shrink-0 opacity-50"
                aria-hidden
              />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-2">
            <Input
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder={t("vaccinations.form.catalogSearch")}
              aria-label={t("vaccinations.form.catalogSearch")}
              data-slot="vaccination-catalog-search"
            />
            <div className="mt-2 max-h-56 space-y-1 overflow-y-auto overscroll-contain">
              {matches.length === 0 ? (
                <p className="text-muted-foreground px-2 py-3 text-sm">
                  {t("vaccinations.form.catalogNoMatch")}
                </p>
              ) : (
                matches.map((entry) => (
                  <button
                    key={entry.slug}
                    type="button"
                    data-slot="vaccination-catalog-option"
                    data-catalog-slug={entry.slug}
                    onClick={() => {
                      onChange(entry.slug);
                      setOpen(false);
                    }}
                    className="hover:bg-muted/60 flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm"
                  >
                    <Check
                      className={cn(
                        "size-4 shrink-0",
                        entry.slug === value ? "opacity-100" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    <span className="text-foreground min-w-0 flex-1 truncate">
                      {name(entry.slug)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </PopoverContent>
        </Popover>

        {selected ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label={t("vaccinations.form.catalogClear")}
            onClick={() => onChange(null)}
          >
            <X className="size-4" aria-hidden />
          </Button>
        ) : null}
      </div>

      {/* Rung 1: the catalogue's sourced sentences for the chosen entry. */}
      {selected ? <CatalogInfo slug={selected.slug} /> : null}
    </div>
  );
}
