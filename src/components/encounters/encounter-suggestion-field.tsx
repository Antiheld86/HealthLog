"use client";

/**
 * "Gehört zu Termin …" — the one rendering of the suggestion, for all three
 * moments that ask it.
 *
 * The RULE is not here. It lives in `src/lib/encounters/suggest-window.ts` and
 * is resolved server-side, so a document arriving in the vault, a lab panel
 * committed from an extraction and a panel typed by hand cannot answer the same
 * question differently. What this component owns is only how the three verdicts
 * look, and it owns that once:
 *
 *   one candidate  → pre-selected, visibly, with one undo;
 *   two or more    → a picker with NOTHING pre-selected;
 *   none           → nothing at all. No empty picker, no "create a visit?" nudge.
 *
 * The middle branch is the point. Pre-selecting the first of two is the failure
 * that teaches a person to stop reading suggestions, and the component cannot
 * do it: the "many" verdict carries no pre-selection and this file never picks
 * one.
 *
 * It never blocks a save — every caller treats the value as optional — and it
 * is never behind an AI call: the match is a date-window query over the
 * person's own rows and resolves on an account with no provider configured.
 *
 * Controlled. The caller owns where the chosen id goes: straight into a PATCH
 * on a document, or into the body of a lab write that has not happened yet.
 */
import { CalendarClock, Check, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useEncounterSuggestion } from "@/hooks/use-encounters";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { EncounterKind } from "@/generated/prisma/client";
import type { EncounterSuggestion } from "@/lib/encounters/suggest-window";
import { encounterKindText } from "./encounter-labels";

export function EncounterSuggestionField({
  anchor,
  value,
  onChange,
  disabled,
  slot = "encounter-suggestion",
}: {
  /** The date to resolve around, ISO-8601. `null` means there is nothing to ask. */
  anchor: string | null;
  /** The visit currently chosen here, or null. */
  value: string | null;
  onChange: (encounterId: string | null) => void;
  disabled?: boolean;
  /** `data-slot` prefix, so a caller's tests can address its own instance. */
  slot?: string;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const suggestion = useEncounterSuggestion(anchor, !disabled);

  if (disabled) return null;
  const result = suggestion.data;
  if (!result || result.kind === "none") return null;

  const label = (candidate: EncounterSuggestion) =>
    `${
      candidate.practitionerName ??
      encounterKindText(t, candidate.kind as EncounterKind)
    } · ${format.date(candidate.occurredAt)}`;

  const candidates =
    result.kind === "one" ? [result.encounter] : result.encounters;

  return (
    <div
      className="space-y-1.5"
      data-slot={slot}
      data-verdict={result.kind}
      // The count is on the element so a test can prove the rule reached the
      // surface rather than inferring it from how many buttons rendered.
      data-candidates={candidates.length}
    >
      {/* A content sentence, not meta (§3): it is the offer itself. */}
      <p className="text-foreground flex items-center gap-2 text-sm">
        <CalendarClock className="size-4 shrink-0" aria-hidden />
        {t(
          result.kind === "one"
            ? "encounters.suggestion.single"
            : "encounters.suggestion.choose",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {candidates.map((candidate) => {
          const chosen = value === candidate.id;
          return (
            <Button
              key={candidate.id}
              type="button"
              variant={chosen ? "default" : "outline"}
              size="sm"
              className="min-h-11"
              aria-pressed={chosen}
              data-slot={`${slot}-option`}
              onClick={() => onChange(chosen ? null : candidate.id)}
            >
              {result.kind === "one" ? (
                <Check
                  className={cn("size-4", chosen ? "opacity-100" : "opacity-0")}
                  aria-hidden
                />
              ) : null}
              {label(candidate)}
            </Button>
          );
        })}
        {value !== null ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-11"
            data-slot={`${slot}-undo`}
            onClick={() => onChange(null)}
          >
            <Undo2 className="size-4" aria-hidden />
            {t("common.undo")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
