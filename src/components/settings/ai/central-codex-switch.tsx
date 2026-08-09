"use client";

/* ────────────────────────────────────────────────────────────────
 * Use the server's shared AI access (per-user opt-in).
 *
 * Shown ONLY when the operator has connected a shared central Codex
 * (ChatGPT-subscription) account. OFF by default. Turning it ON reveals a
 * once-shown honesty confirm before the write, because the trade — a shared,
 * signed-in AI account bound by the operator's rate limits, on which the
 * provider may use content to improve its models with no data-processing
 * agreement — must be acknowledged, not buried. Turning it OFF is immediate.
 *
 * Opting in does not egress anything on its own: the shared connection is
 * server-managed external egress, so the existing AI-consent gate still applies
 * before any health data leaves for it.
 * ──────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

import type { InsightsSettings } from "./shared";

interface UseCentralCodexPref {
  useCentralCodex: boolean;
}

export function CentralCodexSwitch({
  settings,
}: {
  settings: InsightsSettings | null | undefined;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Off→on reveals the honesty confirm; the write only happens on confirm.
  const [pendingEnable, setPendingEnable] = useState(false);

  const enabled = settings?.useCentralCodex ?? false;

  const save = useMutation<UseCentralCodexPref, Error, boolean>({
    mutationFn: (next: boolean) =>
      apiPatch<UseCentralCodexPref>("/api/auth/me/use-central-codex", {
        useCentralCodex: next,
      }),
    onSuccess: () => {
      // The opt-in changes which providers can serve this user — refresh the
      // settings summary (which carries the flag) and every insight read.
      queryClient.invalidateQueries({
        queryKey: queryKeys.insightsSettings(),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.insightsRoot() });
      setPendingEnable(false);
    },
  });

  // Only meaningful once the operator has connected the shared account.
  if (!settings?.centralCodexAvailable) return null;

  function onSwitch(next: boolean) {
    if (next) {
      if (!enabled) setPendingEnable(true);
      return;
    }
    setPendingEnable(false);
    if (enabled) save.mutate(false);
  }

  const busy = save.isPending;
  const checked = enabled || pendingEnable;

  return (
    <div
      data-slot="central-codex-switch-card"
      className="bg-muted/50 space-y-4 rounded-lg p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {t("settings.ai.centralCodex.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("settings.ai.centralCodex.subLabel")}
          </p>
        </div>
        <Switch
          checked={checked}
          disabled={busy}
          onCheckedChange={onSwitch}
          aria-label={t("settings.ai.centralCodex.title")}
          data-testid="use-central-codex-enable"
        />
      </div>

      {pendingEnable ? (
        <div
          data-slot="central-codex-confirm"
          role="note"
          className="border-border space-y-3 rounded-lg border border-dashed px-3 py-2.5"
        >
          <div className="flex items-start gap-2 text-sm">
            <ShieldAlert
              className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
              aria-hidden
            />
            <p className="min-w-0">{t("settings.ai.centralCodex.honesty")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={save.isPending}
              onClick={() => save.mutate(true)}
              data-slot="central-codex-confirm-cta"
            >
              {t("settings.ai.centralCodex.confirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11 sm:min-h-9"
              disabled={save.isPending}
              onClick={() => setPendingEnable(false)}
            >
              {t("settings.ai.centralCodex.cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {save.isError ? (
        <p className="text-destructive text-xs">
          {t("settings.ai.errorGeneric")}
        </p>
      ) : null}
    </div>
  );
}
