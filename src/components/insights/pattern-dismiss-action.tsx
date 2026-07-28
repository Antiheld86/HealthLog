"use client";

import { QueryClientContext, type QueryClient } from "@tanstack/react-query";
import { EyeOff, RotateCcw, X } from "lucide-react";
import { useContext, useReducer, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

interface PatternDecisionResponse {
  id: string;
  dismissed: boolean;
}

async function invalidatePatternDecisionQueries(
  queryClient: Pick<QueryClient, "invalidateQueries">,
): Promise<boolean> {
  const results = await Promise.allSettled([
    queryClient.invalidateQueries(
      { queryKey: queryKeys.analytics() },
      { throwOnError: true },
    ),
    queryClient.invalidateQueries(
      {
        queryKey: queryKeys.insightsCorrelations(),
      },
      { throwOnError: true },
    ),
    queryClient.invalidateQueries(
      { queryKey: queryKeys.moodInsights() },
      { throwOnError: true },
    ),
  ]);
  return results.every((result) => result.status === "fulfilled");
}

export async function applyPatternDecisionSuccess(
  queryClient: Pick<QueryClient, "invalidateQueries"> | undefined,
  applyOptimisticState: () => void,
  clearOptimisticState: () => void,
): Promise<void> {
  applyOptimisticState();
  if (!queryClient || (await invalidatePatternDecisionQueries(queryClient))) {
    clearOptimisticState();
  }
}

/**
 * An entry is a local desired state that wins until the mutation's active
 * query invalidations have settled.
 */
export type PatternDismissalOverrideState = Record<string, boolean>;

export type PatternDismissalOverrideAction =
  | {
      type: "optimistic";
      patternId: string;
      dismissed: boolean;
    }
  | {
      type: "settled";
      patternId: string;
      dismissed: boolean;
    };

export function patternDismissalOverrideReducer(
  state: PatternDismissalOverrideState,
  action: PatternDismissalOverrideAction,
): PatternDismissalOverrideState {
  if (action.type === "optimistic") {
    return { ...state, [action.patternId]: action.dismissed };
  }

  if (state[action.patternId] !== action.dismissed) return state;

  const next = { ...state };
  delete next[action.patternId];
  return next;
}

export function resolvePatternDismissed(
  state: PatternDismissalOverrideState,
  patternId: string | null | undefined,
  persisted: boolean,
): boolean {
  if (!patternId) return false;
  return state[patternId] ?? persisted;
}

export function usePatternDismissalOverrides() {
  const [overrides, dispatch] = useReducer(patternDismissalOverrideReducer, {});

  return {
    isDismissed(patternId: string | null | undefined, persisted: boolean) {
      return resolvePatternDismissed(overrides, patternId, persisted);
    },
    setDismissed(patternId: string, dismissed: boolean) {
      dispatch({
        type: "optimistic",
        patternId,
        dismissed,
      });
    },
    clearDismissed(patternId: string, dismissed: boolean) {
      dispatch({
        type: "settled",
        patternId,
        dismissed,
      });
    },
  };
}

export function PatternDismissButton({
  patternId,
  onDismissed,
  onSettled,
  className,
}: {
  patternId: string;
  onDismissed: () => void;
  onSettled: () => void;
  className?: string;
}) {
  const { t } = useTranslations();
  const queryClient = useContext(QueryClientContext);
  const [pending, setPending] = useState(false);

  async function dismiss() {
    setPending(true);
    try {
      await apiPatch<PatternDecisionResponse>(
        `/api/insights/patterns/${patternId}`,
        { dismissed: true },
      );
      await applyPatternDecisionSuccess(queryClient, onDismissed, onSettled);
    } catch {
      toast.error(t("insights.pattern.dismissError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={dismiss}
      className={cn("gap-1.5", className)}
      aria-label={t("insights.pattern.dismiss")}
    >
      <X className="size-3.5" aria-hidden="true" />
      {t("insights.pattern.dismiss")}
    </Button>
  );
}

export function PatternDismissedNotice({
  patternId,
  onRestored,
  onSettled,
  compact = false,
}: {
  patternId: string;
  onRestored: () => void;
  onSettled: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useContext(QueryClientContext);
  const [pending, setPending] = useState(false);

  async function restore() {
    setPending(true);
    try {
      await apiPatch<PatternDecisionResponse>(
        `/api/insights/patterns/${patternId}`,
        { dismissed: false },
      );
      await applyPatternDecisionSuccess(queryClient, onRestored, onSettled);
    } catch {
      toast.error(t("insights.pattern.restoreError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      data-slot="pattern-dismissed"
      role="status"
      className={cn(
        "text-muted-foreground flex items-center justify-between gap-3 text-sm",
        !compact && "rounded-md border px-3 py-2",
      )}
    >
      <span className="flex items-center gap-2">
        <EyeOff className="size-4 shrink-0" aria-hidden="true" />
        {t("insights.pattern.dismissed")}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={restore}
        className="gap-1.5"
      >
        <RotateCcw className="size-3.5" aria-hidden="true" />
        {t("insights.pattern.restore")}
      </Button>
    </div>
  );
}
