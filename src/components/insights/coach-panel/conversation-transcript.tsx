"use client";

import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations } from "@/lib/i18n/context";

import { useCoachConversation } from "./use-coach";

/**
 * One stored conversation, read back as plain text while the Coach itself is
 * unavailable. The messages render as React text children, like every other
 * Coach surface.
 */
export function ConversationTranscript({ id }: { id: string }) {
  const { t } = useTranslations();
  const { data, isLoading, isError, refetch } = useCoachConversation(id);
  if (isLoading) {
    return (
      <p className="text-muted-foreground px-3 pb-3 text-xs">
        {t("common.loading")}
      </p>
    );
  }
  if (isError || !data) {
    return (
      <QueryErrorRow
        className="mx-3 mb-3"
        onRetry={() => void refetch()}
        slot="coach-conversations-transcript-error"
      />
    );
  }
  return (
    <ol
      data-slot="coach-conversations-transcript"
      className="flex flex-col gap-3 px-3 pb-3"
    >
      {data.messages.map((message) => (
        <li key={message.id} className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs font-medium">
            {message.role === "user"
              ? t("insights.coach.transcriptYou")
              : t("insights.coach.transcriptCoach")}
          </span>
          <p className="text-foreground text-sm whitespace-pre-wrap">
            {message.content}
          </p>
        </li>
      ))}
    </ol>
  );
}
