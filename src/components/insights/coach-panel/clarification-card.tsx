"use client";

/**
 * v1.39.4 — the choices for a clarifying question, above the composer.
 * The question itself is the assistant reply; a tap on a choice sends its
 * label with `clarification: { messageId, choiceId }`, and a typed answer
 * goes out with `clarification: { messageId }`.
 *
 * Not built yet: renders nothing.
 */
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

export function CoachClarificationCard(_props: CoachClarificationCardProps) {
  return null;
}
