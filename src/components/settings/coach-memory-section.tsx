"use client";

/**
 * v1.11.2 — Settings → AI "What the Coach remembers" panel.
 *
 * Surfaces the durable `CoachFact` rows the assistant has stored about
 * the user (the v1.11.1 routes already ship the data), grouped by
 * category, each with a relative "learned <when>" stamp and a "forget"
 * control. A bulk "forget everything" action clears the lot.
 *
 *   GET    /api/insights/coach/facts        → { data: { facts: [...] } }
 *   DELETE /api/insights/coach/facts/{id}   → { data: { deleted } }
 *   DELETE /api/insights/coach/facts        → { data: { cleared } }
 *
 * Reads unwrap `(await res.json()).data` per the envelope convention;
 * every read/write routes its key through `queryKeys.coachFacts()` so
 * a forget invalidates the list. Gated on `!user.disableCoach` so the
 * panel mirrors the rest of the Coach surface — hiding the Coach hides
 * its memory controls too.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Loader2, Trash2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDateOrRelative } from "@/lib/format";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";

/** Closed enum mirrored from the server `CoachFact.category` column. */
const FACT_CATEGORIES = [
  "preference",
  "condition",
  "goal",
  "constraint",
  "context",
] as const;
type FactCategory = (typeof FACT_CATEGORIES)[number];

interface CoachFact {
  id: string;
  category: FactCategory;
  text: string;
  confidence: number;
  createdAt: string;
}

const CATEGORY_LABEL_KEY: Record<FactCategory, string> = {
  preference: "settings.ai.coachMemory.categoryPreference",
  condition: "settings.ai.coachMemory.categoryCondition",
  goal: "settings.ai.coachMemory.categoryGoal",
  constraint: "settings.ai.coachMemory.categoryConstraint",
  context: "settings.ai.coachMemory.categoryContext",
};

async function fetchFacts(): Promise<CoachFact[]> {
  const data = await apiGet<{ facts?: CoachFact[] } | undefined>(
    "/api/insights/coach/facts",
  );
  return data?.facts ?? [];
}

export function CoachMemorySection({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.coachFacts(),
    queryFn: fetchFacts,
    enabled: isAuthenticated,
  });

  const forgetOne = useMutation({
    mutationKey: queryKeys.coachFacts(),
    mutationFn: async (id: string) => {
      await apiDelete(`/api/insights/coach/facts/${encodeURIComponent(id)}`);
      return id;
    },
    onSuccess: () => {
      toast.success(t("settings.ai.coachMemory.forgotToast"));
      queryClient.invalidateQueries({ queryKey: queryKeys.coachFacts() });
    },
    onError: () => {
      toast.error(t("settings.ai.coachMemory.forgotError"));
    },
  });

  const forgetAll = useMutation({
    mutationKey: queryKeys.coachFacts(),
    mutationFn: async () => {
      const data = await apiDelete<{ cleared?: number } | undefined>(
        "/api/insights/coach/facts",
      );
      return data?.cleared ?? 0;
    },
    onSuccess: (cleared) => {
      toast.success(
        t("settings.ai.coachMemory.clearedToast", { count: cleared }),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.coachFacts() });
    },
    onError: () => {
      toast.error(t("settings.ai.coachMemory.clearError"));
    },
  });

  const facts = useMemo(() => query.data ?? [], [query.data]);

  // Group by category in the canonical category order so the panel
  // reads the same way every render regardless of insertion order.
  const grouped = useMemo(() => {
    return FACT_CATEGORIES.map((category) => ({
      category,
      items: facts.filter((f) => f.category === category),
    })).filter((g) => g.items.length > 0);
  }, [facts]);

  return (
    <SettingsCard
      as="section"
      aria-labelledby="settings-ai-coach-memory-title"
      data-testid="settings-coach-memory-card"
    >
      <SettingsCardHeader
        icon={Brain}
        titleId="settings-ai-coach-memory-title"
        title={t("settings.ai.coachMemory.title")}
        description={t("settings.ai.coachMemory.description")}
      />
      <p className="text-sm">{t("settings.ai.coachMemory.detail")}</p>

      {query.isError && (
        <p
          role="status"
          aria-live="polite"
          className="text-destructive text-sm"
        >
          {t("settings.ai.coachMemory.loadError")}
        </p>
      )}

      {!query.isError && facts.length === 0 ? (
        <EmptyState
          data-testid="settings-coach-memory-empty"
          variant="plain"
          size="compact"
          title={t("settings.ai.coachMemory.empty")}
        />
      ) : (
        <div className="space-y-4">
          {grouped.map((group) => (
            <div key={group.category} className="space-y-2">
              <h3
                data-testid={`settings-coach-memory-group-${group.category}`}
                className="text-muted-foreground text-xs font-medium tracking-wide uppercase"
              >
                {t(CATEGORY_LABEL_KEY[group.category])}
              </h3>
              <ul className="space-y-2">
                {group.items.map((fact) => (
                  <li
                    key={fact.id}
                    data-testid="settings-coach-memory-fact"
                    className="border-border bg-background flex items-start justify-between gap-3 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <p className="text-sm break-words">{fact.text}</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {t("settings.ai.coachMemory.learnedPrefix", {
                          when: formatDateOrRelative(fact.createdAt, t),
                        })}
                      </p>
                    </div>
                    <ConfirmButton
                      slot="settings-coach-memory-forget"
                      variant="ghost"
                      size="sm"
                      className="min-h-11 sm:min-h-9"
                      ariaLabel={t("settings.ai.coachMemory.forgetAria")}
                      icon={<Trash2 className="size-4" aria-hidden />}
                      label={t("settings.ai.coachMemory.forget")}
                      title={t("settings.ai.coachMemory.forgetTitle")}
                      body={t("settings.ai.coachMemory.forgetBody")}
                      confirmLabel={t("settings.ai.coachMemory.forgetConfirm")}
                      disabled={!isAuthenticated}
                      // v1.11.2 — per-id pending: only the row being
                      // deleted disables/spins. `forgetOne.variables` holds
                      // the id passed to the in-flight `mutate()`, so a
                      // single shared mutation no longer greys out every
                      // other row's forget button during one delete.
                      pending={
                        forgetOne.isPending && forgetOne.variables === fact.id
                      }
                      onConfirm={() => forgetOne.mutate(fact.id)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <p className="text-muted-foreground border-border border-t pt-3 text-xs">
        {t("settings.ai.coachMemory.summaryNote")}
      </p>
      <SettingsCardActions>
        {facts.length > 0 ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11 sm:min-h-9"
                data-testid="settings-coach-memory-forget-all"
                disabled={!isAuthenticated || forgetAll.isPending}
              >
                {forgetAll.isPending ? (
                  <Loader2
                    className="size-4 animate-spin motion-reduce:animate-none"
                    aria-hidden
                  />
                ) : (
                  <Trash2 className="size-4" aria-hidden />
                )}
                {t("settings.ai.coachMemory.forgetAll")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.ai.coachMemory.forgetAllConfirmTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.ai.coachMemory.forgetAllConfirmBody")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("settings.ai.coachMemory.cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  data-testid="settings-coach-memory-forget-all-confirm"
                  disabled={forgetAll.isPending}
                  aria-busy={forgetAll.isPending || undefined}
                  onClick={() => forgetAll.mutate()}
                >
                  {forgetAll.isPending && (
                    <Loader2 className="mr-1 size-3.5 animate-spin motion-reduce:animate-none" />
                  )}
                  {t("settings.ai.coachMemory.forgetAllConfirmAction")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </SettingsCardActions>
    </SettingsCard>
  );
}
