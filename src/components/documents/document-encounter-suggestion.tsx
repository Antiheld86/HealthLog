"use client";

/**
 * The document moment of the visit suggestion.
 *
 * The rule and the rendering both live elsewhere — `suggest-window.ts` on the
 * server and `EncounterSuggestionField` in the browser — so this file is only
 * the wiring: which date to anchor on, and where the chosen id goes.
 *
 * The anchor is `reportDate ?? documentDate`. `reportDate` is what the model
 * transcribed off the letter itself and is never inferred, so it is the truer
 * of the two; `documentDate` is the person's own filing date and is the
 * fallback.
 *
 * Both DTO fields are date-only (`YYYY-MM-DD`), but the suggest endpoint takes
 * a full instant — the same shape the two lab moments already hand it. So the
 * date is lifted to noon UTC here, exactly as the OCR review does: the rule is
 * a ±7-day window, so the time of day never changes the verdict, and noon keeps
 * a viewer's local midnight from rounding the day either way. Passing the bare
 * date instead is what made this suggestion silently never appear — the API
 * answered 422 and the field rendered nothing.
 *
 * It renders nothing once the document already names a visit that this session
 * did not choose: an offer to file something already filed is noise.
 */
import { EncounterSuggestionField } from "@/components/encounters/encounter-suggestion-field";

export function DocumentEncounterSuggestion({
  anchor,
  alreadyLinked,
  disabled,
  value,
  onChange,
}: {
  anchor: string | null;
  alreadyLinked: boolean;
  disabled?: boolean;
  value: string | null;
  onChange: (encounterId: string | null) => void;
}) {
  if (alreadyLinked) return null;
  const instant = anchor ? `${anchor}T12:00:00.000Z` : null;
  return (
    <EncounterSuggestionField
      anchor={instant}
      value={value}
      onChange={onChange}
      disabled={disabled}
      slot="document-encounter-suggestion"
    />
  );
}
