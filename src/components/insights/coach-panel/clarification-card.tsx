"use client";

/**
 * v1.39.4 — the choices for a clarifying question, above the composer.
 * The question itself is the assistant reply in the thread, so the card
 * does not repeat it: a short heading, the choices, and a meta line saying a
 * typed answer works too. A tap on a choice sends its label with
 * `clarification: { messageId, choiceId }`; a typed answer goes out with
 * `clarification: { messageId }`.
 *
 * Announced politely when it appears and never takes focus: the person may
 * already be typing.
 */
import { MessageCircleQuestionMark } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { COACH_CLARIFY_UI_KEYS } from "@/lib/ai/coach/dialog-keys";
import type {
  CoachClarification,
  CoachClarificationChoice,
} from "@/lib/ai/coach/types";

export interface CoachClarificationCardProps {
  clarification: CoachClarification;
  /** The assistant message that asked. */
  messageId: string;
  /** True while a turn is in flight. */
  disabled: boolean;
  onChoose: (choice: CoachClarificationChoice) => void;
}

export function CoachClarificationCard({
  clarification,
  messageId,
  disabled,
  onChoose,
}: CoachClarificationCardProps) {
  const { t } = useTranslations();
  // The catalog string in the reader's locale when the bundle has it, the
  // server's rendering when it does not.
  const choiceLabel = (choice: CoachClarificationChoice) => {
    const local = t(choice.labelKey);
    return local === choice.labelKey ? choice.label : local;
  };
  const { choices } = clarification;
  const hint =
    choices.length === 0
      ? t(COACH_CLARIFY_UI_KEYS.contextHint)
      : clarification.freeText
        ? t(COACH_CLARIFY_UI_KEYS.freeTextHint)
        : null;

  return (
    <Card
      data-slot="coach-clarification-card"
      data-message-id={messageId}
      aria-live="polite"
      aria-label={t(COACH_CLARIFY_UI_KEYS.cardLabel)}
      role="region"
      className="gap-2 py-3 md:py-4"
    >
      <div className="flex items-center gap-2 px-4 md:px-6">
        <MessageCircleQuestionMark
          aria-hidden="true"
          className="text-foreground size-4 shrink-0"
        />
        <p className="text-sm font-medium">
          {t(COACH_CLARIFY_UI_KEYS.cardLabel)}
        </p>
      </div>
      {choices.length > 0 ? (
        <div
          role="group"
          aria-label={t(COACH_CLARIFY_UI_KEYS.choicesLabel)}
          className="flex flex-wrap gap-2 px-4 md:px-6"
        >
          {choices.map((choice) => (
            <Button
              key={choice.id}
              type="button"
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={disabled}
              data-choice-id={choice.id}
              onClick={() => onChoose(choice)}
            >
              {choiceLabel(choice)}
            </Button>
          ))}
        </div>
      ) : null}
      {hint ? (
        <p className="text-muted-foreground px-4 text-xs md:px-6">{hint}</p>
      ) : null}
    </Card>
  );
}
