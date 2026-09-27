"use client";

/**
 * v1.39.4 — up to three follow-up chips under the latest assistant reply.
 * A tap sends the chip's label as the message with
 * `followUp: { messageId, id }`; the server resolves what the chip asks for.
 *
 * Not built yet: renders nothing.
 */
import type { CoachFollowUp } from "@/lib/ai/coach/types";

export interface CoachFollowUpChipsProps {
  followUps: CoachFollowUp[];
  /** The assistant message that offered the chips. */
  messageId: string;
  /** True while a turn is in flight. */
  disabled: boolean;
  onSelect: (followUp: CoachFollowUp, messageId: string) => void;
}

export function CoachFollowUpChips(_props: CoachFollowUpChipsProps) {
  return null;
}
