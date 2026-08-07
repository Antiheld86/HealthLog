"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Label } from "@/components/ui/label";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ApiError,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
} from "@/lib/api/api-fetch";
import { isConflict } from "@/lib/api/optimistic-token";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  ALCOHOL_PATTERN_VALUES,
  HEALTH_PROFILE_FACT_KINDS,
  SHIFT_SCHEDULE_VALUES,
  SMOKING_STATUS_VALUES,
  type HealthProfileFactKind,
  type HealthProfileFactValue,
} from "@/lib/validations/health-profile-facts";

interface FactDto {
  id: string;
  kind: HealthProfileFactKind;
  value: HealthProfileFactValue | null;
  unreadable: boolean;
  validFrom: string;
  validUntil: string | null;
  provenance: "USER_REPORTED" | "USER_CORRECTION";
  supersededByRevisionId: string | null;
  createdAt: string;
}

interface FactsData {
  current: Record<HealthProfileFactKind, FactDto | null>;
  history: FactDto[];
}

interface RemovedFactDto {
  id: string;
  kind: HealthProfileFactKind;
  removedAt: string;
}

const VALUES: Record<HealthProfileFactKind, readonly string[]> = {
  SMOKING_STATUS: SMOKING_STATUS_VALUES,
  ALCOHOL_PATTERN: ALCOHOL_PATTERN_VALUES,
  SHIFT_SCHEDULE: SHIFT_SCHEDULE_VALUES,
};

function isStaleFactTarget(error: unknown): boolean {
  return (
    isConflict(error) || (error instanceof ApiError && error.status === 404)
  );
}

const KIND_LABEL: Record<HealthProfileFactKind, string> = {
  SMOKING_STATUS: "records.profileFacts.smokingLabel",
  ALCOHOL_PATTERN: "records.profileFacts.alcoholLabel",
  SHIFT_SCHEDULE: "records.profileFacts.shiftLabel",
};

export function HealthProfileFactsManager() {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<
    Partial<Record<HealthProfileFactKind, string>>
  >({});

  const query = useQuery({
    queryKey: queryKeys.healthProfileFacts(),
    queryFn: () => apiGet<FactsData>("/api/anamnesis/facts"),
  });

  const save = useMutation({
    mutationKey: queryKeys.healthProfileFacts(),
    mutationFn: async (input: {
      kind: HealthProfileFactKind;
      value: string;
      current: FactDto | null;
    }) => {
      if (input.current) {
        return apiPatch<FactDto>(`/api/anamnesis/facts/${input.current.id}`, {
          value: input.value,
        });
      }
      return apiPost<FactDto>("/api/anamnesis/facts", {
        kind: input.kind,
        value: input.value,
      });
    },
    onSuccess: (_data, input) => {
      setDrafts((current) => ({ ...current, [input.kind]: undefined }));
      toastWrittenOutcome("success", t("records.profileFacts.savedToast"));
      queryClient.invalidateQueries({
        queryKey: queryKeys.healthProfileFacts(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.insightsAdvisor(),
      });
    },
    onError: (error) => {
      if (isStaleFactTarget(error)) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.healthProfileFacts(),
        });
      }
      toast.error(t("records.profileFacts.saveError"));
    },
  });

  const remove = useMutation({
    mutationKey: queryKeys.healthProfileFacts(),
    mutationFn: (current: FactDto) =>
      apiDelete<RemovedFactDto>(`/api/anamnesis/facts/${current.id}`),
    onSuccess: (removed) => {
      setDrafts((current) => ({ ...current, [removed.kind]: undefined }));
      queryClient.setQueryData<FactsData>(
        queryKeys.healthProfileFacts(),
        (facts) =>
          facts
            ? {
                current: {
                  ...facts.current,
                  [removed.kind]: null,
                },
                history: facts.history.map((revision) =>
                  revision.id === removed.id
                    ? { ...revision, validUntil: removed.removedAt }
                    : revision,
                ),
              }
            : facts,
      );
      toastWrittenOutcome(
        "success",
        t("records.profileFacts.removedToast", {
          kind: t(KIND_LABEL[removed.kind]),
        }),
      );
      queryClient.invalidateQueries({
        queryKey: queryKeys.healthProfileFacts(),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.insightsAdvisor(),
      });
    },
    onError: (error, current) => {
      if (isStaleFactTarget(error)) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.healthProfileFacts(),
        });
      }
      toast.error(
        t("records.profileFacts.removeError", {
          kind: t(KIND_LABEL[current.kind]),
        }),
      );
    },
  });

  if (query.isError) {
    return (
      <QueryErrorCard
        title={t("records.profileFacts.loadError")}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const disabled = query.isLoading || save.isPending || remove.isPending;
  const closedHistory = (query.data?.history ?? []).filter(
    (revision) => revision.validUntil !== null,
  );

  return (
    <div className="space-y-6" data-slot="health-profile-facts-manager">
      <div className="grid gap-4 md:grid-cols-3">
        {HEALTH_PROFILE_FACT_KINDS.map((kind) => {
          const current = query.data?.current[kind] ?? null;
          const value = drafts[kind] ?? current?.value ?? "";
          const dirty =
            drafts[kind] !== undefined && drafts[kind] !== current?.value;
          return (
            <div key={kind} className="space-y-2">
              <Label htmlFor={`health-profile-fact-${kind}`}>
                {t(KIND_LABEL[kind])}
              </Label>
              <Select
                value={value}
                disabled={disabled}
                onValueChange={(next) =>
                  setDrafts((old) => ({ ...old, [kind]: next }))
                }
              >
                <SelectTrigger id={`health-profile-fact-${kind}`}>
                  <SelectValue
                    placeholder={
                      current?.unreadable
                        ? t("records.profileFacts.unreadable")
                        : t("records.profileFacts.notRecorded")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {VALUES[kind].map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`records.profileFacts.values.${kind}.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* One action row per entry (UI-STANDARDS §11 + the action-row
                  rule): right-aligned, primary last, the quiet destructive
                  beside it. Two full-width stacked blocks — a grey disabled
                  slab over a red-outlined one — carried the same visual weight
                  as the field they belong to and ran into each other when
                  scanned, which is what "Save" directly above "Remove smoking
                  status" read as. */}
              <div className="flex items-center justify-end gap-2 pt-1">
                {current ? (
                  <ConfirmButton
                    // Short label inside the row; the full phrase stays the
                    // accessible name, because "Remove" on its own is
                    // ambiguous once three of them are on screen.
                    label={t("records.profileFacts.removeShort")}
                    ariaLabel={t("records.profileFacts.remove", {
                      kind: t(KIND_LABEL[kind]),
                    })}
                    title={t("records.profileFacts.removeConfirmTitle", {
                      kind: t(KIND_LABEL[kind]),
                    })}
                    body={t("records.profileFacts.removeConfirmDescription")}
                    confirmLabel={t("records.profileFacts.remove", {
                      kind: t(KIND_LABEL[kind]),
                    })}
                    onConfirm={() => remove.mutate(current)}
                    pending={
                      remove.isPending && remove.variables?.id === current.id
                    }
                    disabled={disabled}
                    variant="ghost"
                    size="sm"
                    className="text-destructive min-h-11 sm:min-h-9"
                    icon={<Trash2 className="size-4" aria-hidden />}
                    slot={`health-profile-fact-remove-${kind}`}
                  />
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  disabled={disabled || !dirty || !value}
                  onClick={() => save.mutate({ kind, value, current })}
                >
                  {save.isPending && save.variables?.kind === kind && (
                    <Loader2
                      className="size-4 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                  )}
                  {t("records.profileFacts.save")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {closedHistory.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">
            {t("records.profileFacts.historyTitle")}
          </h3>
          <ul className="divide-border divide-y text-sm">
            {closedHistory.map((revision) => (
              <li
                key={revision.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span>
                  {t(KIND_LABEL[revision.kind])}:{" "}
                  {revision.unreadable
                    ? t("records.profileFacts.unreadable")
                    : revision.value
                      ? t(
                          `records.profileFacts.values.${revision.kind}.${revision.value}`,
                        )
                      : t("records.profileFacts.notRecorded")}
                </span>
                <span className="text-muted-foreground text-xs">
                  {fmt.dateTime(revision.validFrom)}
                  {revision.validUntil ? (
                    <>
                      {" "}
                      {t("records.profileFacts.to")}{" "}
                      {fmt.dateTime(revision.validUntil)}
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
