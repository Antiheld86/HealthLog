"use client";

/**
 * "Gehört zu Termin …" — the incidental link, offered at the moment a document
 * is being looked at rather than as a filing chore afterwards.
 *
 * The rule is not implemented here. It lives in `suggest-window.ts` and is
 * resolved server-side, so this surface, the lab review and the manual lab form
 * cannot answer the same question differently. What this component owns is only
 * how the three verdicts LOOK:
 *
 *   one candidate  → pre-selected, visibly, with one undo;
 *   two or more    → a picker with NOTHING pre-selected;
 *   none           → nothing at all. No empty picker, no "create a visit?" nudge.
 *
 * It never blocks anything, it is never behind an AI call — the match is a
 * date-window query over the person's own rows and resolves on an account with
 * no provider configured — and it renders nothing once the document already
 * names a visit: an offer to file something already filed is noise.
 *
 * The row is a content sentence, not meta, so it is `text-foreground`.
 */
import { CalendarClock, Check, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { encounterKindText } from "@/components/encounters/encounter-labels";
import { useEncounterSuggestion } from "@/hooks/use-encounters";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import type { EncounterKind } from "@/generated/prisma/client";
import type { EncounterSuggestion } from "@/lib/encounters/suggest-window";

export function DocumentEncounterSuggestion({
  anchor,
  alreadyLinked,
  disabled,
  onPick,
  pickedId,
  onUndo,
}: {
  /** `reportDate ?? documentDate`, ISO-8601, or null when the document has none. */
  anchor: string | null;
  /** The document already names a visit — there is nothing to offer. */
  alreadyLinked: boolean;
  disabled?: boolean;
  onPick: (encounterId: string) => void;
  /** The visit this surface has just filed against, for the undo affordance. */
  pickedId: string | null;
  onUndo: () => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const suggestion = useEncounterSuggestion(
    anchor,
    !alreadyLinked && !disabled,
  );

  if (alreadyLinked || disabled) return null;
  const result = suggestion.data;
  if (!result || result.kind === "none") return null;

  const label = (candidate: EncounterSuggestion) =>
    `${
      candidate.practitionerName ??
      encounterKindText(t, candidate.kind as EncounterKind)
    } · ${format.date(candidate.occurredAt)}`;

  // ── One candidate: pre-selected, and undoable in one tap ────────────────
  if (result.kind === "one") {
    const candidate = result.encounter;
    const applied = pickedId === candidate.id;
    return (
      <div
        className="space-y-1.5"
        data-slot="document-encounter-suggestion"
        data-verdict="one"
      >
        <p className="text-foreground flex items-center gap-2 text-sm">
          <CalendarClock className="size-4 shrink-0" aria-hidden />
          {t("documents.detail.visitSuggestion")}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant={applied ? "default" : "outline"}
            size="sm"
            className="min-h-11"
            aria-pressed={applied}
            data-slot="document-encounter-suggestion-apply"
            onClick={() => onPick(candidate.id)}
          >
            <Check
              className={cn("size-4", applied ? "opacity-100" : "opacity-0")}
              aria-hidden
            />
            {label(candidate)}
          </Button>
          {applied ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="min-h-11"
              onClick={onUndo}
            >
              <Undo2 className="size-4" aria-hidden />
              {t("common.undo")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  // ── Two or more: a picker with nothing pre-selected ─────────────────────
  return (
    <div
      className="space-y-1.5"
      data-slot="document-encounter-suggestion"
      data-verdict="many"
    >
      <p className="text-foreground flex items-center gap-2 text-sm">
        <CalendarClock className="size-4 shrink-0" aria-hidden />
        {t("documents.detail.visitSuggestionChoose")}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        {result.encounters.map((candidate) => {
          const applied = pickedId === candidate.id;
          return (
            <Button
              key={candidate.id}
              type="button"
              variant={applied ? "default" : "outline"}
              size="sm"
              className="min-h-11"
              aria-pressed={applied}
              data-slot="document-encounter-suggestion-option"
              onClick={() => (applied ? onUndo() : onPick(candidate.id))}
            >
              {label(candidate)}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
