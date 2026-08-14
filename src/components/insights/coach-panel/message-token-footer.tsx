"use client";

import { useTranslations } from "@/lib/i18n/context";

/**
 * v1.18.9 — quiet per-message token-usage caption under an assistant
 * bubble. Server-authoritative: it renders the count the server reported
 * (`done.usage.totalTokens` for the live turn, `CoachMessageDTO.tokensUsed`
 * on reload), never a client-side recomputation. No cost — BYOK users pay
 * the provider directly and a price table would only drift.
 *
 * Renders nothing when there is no count (user turns, refusals, in-flight
 * bubbles, and pre-feature persisted rows all carry null).
 */
export interface MessageTokenFooterProps {
  tokens: number | null | undefined;
  /** Provider model name (e.g. `gpt-4o`); appended when present. */
  model?: string | null;
}

export function MessageTokenFooter({ tokens, model }: MessageTokenFooterProps) {
  const { t } = useTranslations();
  if (tokens == null) return null;

  const label = model
    ? t("insights.coach.tokensUsedWithModel", { count: tokens, model })
    : t("insights.coach.tokensUsed", { count: tokens });

  return (
    <p
      data-slot="coach-token-footer"
      className="text-muted-foreground text-xs tabular-nums"
    >
      {label}
    </p>
  );
}
