"use client";

/**
 * v1.39.4 — the stored tables of one Coach message, fetched lazily.
 *
 * A thread can hold many messages with tables, and each table set is
 * decrypted on the server per request, so nothing is fetched until the
 * message scrolls near the viewport: mount the returned `ref` on the
 * element that shows the tables. `enabled` gates the whole read (a message
 * whose provenance lists no tables never asks). Once fetched, the tables are
 * the stored snapshot and do not change, so they stay fresh indefinitely.
 */
import { useEffect, useState, type RefCallback } from "react";
import { useQuery } from "@tanstack/react-query";

import type { CoachResultEntry } from "@/lib/ai/coach/types";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

export function useCoachMessageResults(args: {
  conversationId: string | null;
  messageId: string | null;
  enabled: boolean;
}): {
  ref: RefCallback<HTMLElement>;
  results: CoachResultEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const { conversationId, messageId, enabled } = args;
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [visible, setVisible] = useState(false);

  // Without an observer (an old engine) there is nothing to wait for.
  const canObserve = typeof IntersectionObserver !== "undefined";

  useEffect(() => {
    if (!enabled || visible || !node || !canObserve) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, visible, node, canObserve]);

  const query = useQuery({
    queryKey: queryKeys.coachMessageResults(
      conversationId ?? "",
      messageId ?? "",
    ),
    queryFn: async (): Promise<CoachResultEntry[]> => {
      const data = await apiGet<{ results: CoachResultEntry[] }>(
        `/api/insights/chat/${encodeURIComponent(conversationId ?? "")}/messages/${encodeURIComponent(messageId ?? "")}/results`,
      );
      return data.results;
    },
    enabled:
      enabled &&
      (visible || !canObserve) &&
      conversationId !== null &&
      messageId !== null,
    staleTime: Infinity,
  });

  return {
    ref: setNode,
    results: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
