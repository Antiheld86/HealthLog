"use client";

/**
 * v1.15.20 — Settings → AI "About me" panel (free text only).
 * v1.16.0 — structured self-context: alongside the free text the user
 * notes allergies / intolerances. All fields are encrypted at rest;
 * age/gender stay on the profile and are merged into the prompt
 * server-side — the panel says so instead of asking again.
 *
 * v1.25.12 — the pre-existing / chronic conditions and the "what should the
 * Coach watch" focus moved out of this panel into Settings → Anamnese, where
 * they sit with allergies + family history as one medical history. Editing them
 * has a single home there now; this panel keeps the free-text note and the
 * allergies line. The store is unchanged — every field is still part of the
 * `/api/coach/about-me` payload; the PUT here simply omits the two conditions
 * fields, which are preserved server-side.
 *
 *   GET /api/coach/about-me — full structured payload + pending questions
 *   PUT /api/coach/about-me — writes aboutMe (empty string clears) + allergies;
 *     conditions / coachFocus are omitted here and left untouched
 *
 * After a save the server derives up to 3 clarifying questions (AI
 * when a provider + budget allow, deterministic hints otherwise); the
 * panel surfaces them in a quiet callout and the Coach composer
 * renders them as tappable chips.
 *
 * Plain text only — every value renders exclusively through inputs and
 * React text children; no markdown anywhere.
 *
 * The "Clear" control writes `aboutMe: ""` and nothing else. It used to send
 * `allergies: ""` alongside, so one untargeted tap wiped the allergy line as
 * well — while the toast it raised said "About-me note cleared", which is what
 * the control looks like it does and what a person reading it expects. The
 * allergy line is the entry a clinician reads first, so the control is scoped
 * rather than merely gated: the field is omitted from the payload, and the PUT
 * leaves an omitted field untouched by contract. Clearing allergies is done in
 * the allergies field itself, which is a deliberate act on the thing being
 * emptied. The confirmation on top of that guards the note.
 */
import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Loader2,
  MessageCircleQuestion,
  NotebookPen,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { QueryErrorRow } from "@/components/ui/query-error-row";
import { SettingsInfoTile } from "@/components/settings/_info-tile";
import { Label } from "@/components/ui/label";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { withBaseToken, isConflict } from "@/lib/api/optimistic-token";

const FALLBACK_MAX_CHARS = 4000;
const FALLBACK_FIELD_MAX_CHARS = 500;

interface AboutMeData {
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
  pendingQuestions: string[];
  updatedAt: string | null;
  maxChars: number;
  fieldMaxChars: number;
}

type StructuredKey = "allergies";

async function fetchAboutMe(): Promise<AboutMeData> {
  return apiGet<AboutMeData>("/api/coach/about-me");
}

const FIELD_CLASSES =
  "border-input bg-background placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-1 focus-visible:outline-none";

export function AboutMeSection({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [drafts, setDrafts] = useState<{
    aboutMe: string | null;
    allergies: string | null;
  }>({ aboutMe: null, allergies: null });

  const query = useQuery({
    queryKey: queryKeys.coachAboutMe(),
    queryFn: fetchAboutMe,
    enabled: isAuthenticated,
  });

  const saved = {
    aboutMe: query.data?.aboutMe ?? "",
    allergies: query.data?.allergies ?? "",
  };
  const maxChars = query.data?.maxChars ?? FALLBACK_MAX_CHARS;
  const fieldMaxChars = query.data?.fieldMaxChars ?? FALLBACK_FIELD_MAX_CHARS;
  const pendingQuestions = query.data?.pendingQuestions ?? [];

  const value = {
    aboutMe: drafts.aboutMe ?? saved.aboutMe,
    allergies: drafts.allergies ?? saved.allergies,
  };
  const dirty =
    value.aboutMe !== saved.aboutMe || value.allergies !== saved.allergies;
  // The clear control only ever touches the note, so it only appears when
  // there is a note to clear.
  const hasNote = saved.aboutMe.length > 0;

  // Quiet completeness meter: one segment per answered field. Reads
  // the SAVED state (not the draft) so it only moves on persistence.
  const answered = [saved.allergies, saved.aboutMe].filter(
    (v) => v.length > 0,
  ).length;

  const save = useMutation({
    mutationKey: queryKeys.coachAboutMe(),
    // Send only the two fields this panel owns. `conditions` / `coachFocus`
    // are omitted so the server preserves them (they are edited under Anamnese).
    // v1.32.21 (R5a) — echo the base token this edit was based on so a
    // concurrent write to the same self-context (another tab, or Coach adopt)
    // 409s instead of silently overwriting the newer state.
    // `allergies` is optional on purpose: the clear control omits it so the
    // stored allergy line survives, per the PUT's omitted-field contract.
    mutationFn: async (input: { aboutMe: string; allergies?: string }) => {
      return apiPut<AboutMeData>(
        "/api/coach/about-me",
        withBaseToken(input, query.data?.updatedAt ?? undefined),
      );
    },
    onSuccess: (next) => {
      const cleared = !next.aboutMe;
      toast.success(
        cleared
          ? t("settings.ai.aboutMe.clearedToast")
          : t("settings.ai.aboutMe.savedToast"),
      );
      setDrafts({ aboutMe: null, allergies: null });
      queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.coachAboutMeQuestions(),
      });
    },
    onError: (err) => {
      // v1.32.21 (R5a) — explicit-Save disposition: a 409 means the stored
      // self-context advanced since this edit was based. Refetch so the token
      // advances, KEEP the drafts so the user can re-save, nudge gently.
      if (isConflict(err)) {
        queryClient.invalidateQueries({ queryKey: queryKeys.coachAboutMe() });
        toast.message(t("common.conflictReloaded"));
        return;
      }
      toast.error(t("settings.ai.aboutMe.saveError"));
    },
  });

  const disabled = !isAuthenticated || query.isLoading || save.isPending;

  function structuredField(
    key: StructuredKey,
    label: string,
    placeholder: string,
  ) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`settings-about-me-${key}`}>{label}</Label>
        <textarea
          id={`settings-about-me-${key}`}
          data-testid={`settings-about-me-${key}`}
          className={cn(FIELD_CLASSES, "min-h-16 resize-y")}
          rows={2}
          value={value[key]}
          maxLength={fieldMaxChars}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
        />
      </div>
    );
  }

  return (
    <SettingsCard
      as="section"
      aria-labelledby="settings-ai-about-me-title"
      data-testid="settings-about-me-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SettingsCardHeader
          icon={NotebookPen}
          title={t("settings.ai.aboutMe.title")}
          titleId="settings-ai-about-me-title"
          description={t("settings.ai.aboutMe.description")}
        />
        {/* Completeness — two quiet segments, no percentage shouting. */}
        <div
          className="flex items-center gap-1.5"
          aria-label={t("settings.ai.aboutMe.completeness", {
            answered,
            total: 2,
          })}
          title={t("settings.ai.aboutMe.completeness", {
            answered,
            total: 2,
          })}
        >
          {[0, 1].map((i) => (
            <span
              key={i}
              aria-hidden="true"
              className={cn(
                "h-1 w-5 rounded-full transition-colors",
                i < answered ? "bg-primary" : "bg-border",
              )}
            />
          ))}
        </div>
      </div>

      <div>
        {structuredField(
          "allergies",
          t("settings.ai.aboutMe.allergiesLabel"),
          t("settings.ai.aboutMe.allergiesPlaceholder"),
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="settings-about-me-freetext">
          {t("settings.ai.aboutMe.freeTextLabel")}
        </Label>
        <textarea
          id="settings-about-me-freetext"
          data-testid="settings-about-me-textarea"
          className={cn(FIELD_CLASSES, "min-h-36 resize-y")}
          value={value.aboutMe}
          maxLength={maxChars}
          placeholder={t("settings.ai.aboutMe.placeholder")}
          disabled={disabled}
          onChange={(e) =>
            setDrafts((d) => ({ ...d, aboutMe: e.target.value }))
          }
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p
          data-testid="settings-about-me-count"
          className="text-muted-foreground text-xs tabular-nums"
        >
          {t("settings.ai.aboutMe.charCount", {
            used: value.aboutMe.length,
            max: maxChars,
          })}
        </p>
        <div className="flex items-center gap-2">
          {hasNote && (
            <ConfirmButton
              slot="settings-about-me-clear"
              label={t("settings.ai.aboutMe.clear")}
              icon={<Trash2 className="size-4" aria-hidden />}
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              title={t("settings.ai.aboutMe.clearTitle")}
              body={t("settings.ai.aboutMe.clearBody")}
              confirmLabel={t("settings.ai.aboutMe.clearConfirm")}
              disabled={!isAuthenticated}
              pending={save.isPending}
              onConfirm={() => save.mutate({ aboutMe: "" })}
            />
          )}
          <Button
            type="button"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-testid="settings-about-me-save"
            disabled={!isAuthenticated || save.isPending || !dirty}
            onClick={() => save.mutate(value)}
          >
            {save.isPending && (
              <Loader2
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden
              />
            )}
            {t("settings.ai.aboutMe.save")}
          </Button>
        </div>
      </div>

      {pendingQuestions.length > 0 && (
        <SettingsInfoTile
          icon={MessageCircleQuestion}
          tone="primary"
          data-testid="settings-about-me-questions"
          title={t("settings.ai.aboutMe.questionsTitle")}
        >
          <ul className="list-disc space-y-1 pl-6">
            {pendingQuestions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs">
            <Link
              href="/coach"
              className="text-primary underline-offset-4 hover:underline"
            >
              {t("settings.ai.aboutMe.questionsOpenCoach")}
            </Link>
          </p>
        </SettingsInfoTile>
      )}

      {query.isError && (
        <QueryErrorRow
          message={t("settings.ai.aboutMe.loadError")}
          onRetry={() => query.refetch()}
        />
      )}

      <p className="text-muted-foreground border-border border-t pt-3 text-xs">
        {t("settings.ai.aboutMe.hint")} {t("settings.ai.aboutMe.profileHint")}
      </p>

      {/* v1.25.12 — cross-link to the Anamnese (medical-history) home, where the
          chronic conditions the Coach watches now live alongside allergies +
          family history as one coherent medical history. */}
      <p className="text-muted-foreground text-xs">
        {t("settings.ai.aboutMe.recordsLink")}{" "}
        <Link
          href="/settings/anamnesis"
          className="text-primary underline-offset-4 hover:underline"
        >
          {t("settings.ai.aboutMe.recordsLinkCta")}
        </Link>
      </p>
    </SettingsCard>
  );
}
