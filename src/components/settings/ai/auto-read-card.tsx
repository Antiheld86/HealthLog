"use client";

/* ────────────────────────────────────────────────────────────────
 * Read documents automatically with AI (per-user opt-in).
 *
 * One switch. OFF by default: the vault stays local-first and every external AI
 * read of an uploaded document needs an explicit per-document action. When ON,
 * each newly uploaded document is read and indexed by the configured AI provider
 * with no per-document tap — the "upload and the AI just reads it" flow.
 *
 * Turning it ON reveals a once-shown honesty confirm (vendor-blind) before the
 * setting is written, because the trade — a subscription provider may use the
 * content to improve its models, with no data-processing agreement — must be
 * acknowledged, not buried. Turning it OFF is immediate.
 * ──────────────────────────────────────────────────────────────── */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

interface AutoReadPref {
  documentsAutoAiRead: boolean;
}

export function AutoReadCard() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  // Whether the honesty confirm is currently shown (user flipped the switch ON
  // but has not yet acknowledged the trade). Off→on reveals it; the write only
  // happens on confirm.
  const [pendingEnable, setPendingEnable] = useState(false);

  const { data, isLoading } = useQuery<AutoReadPref>({
    queryKey: queryKeys.documentsAutoAiRead(),
    queryFn: () => apiGet<AutoReadPref>("/api/auth/me/documents-auto-ai-read"),
    staleTime: 60_000,
  });

  const enabled = data?.documentsAutoAiRead ?? false;

  const save = useMutation<AutoReadPref, Error, boolean>({
    mutationFn: (next: boolean) =>
      apiPatch<AutoReadPref>("/api/auth/me/documents-auto-ai-read", {
        documentsAutoAiRead: next,
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.documentsAutoAiRead(), result);
      // Flipping the toggle changes whether an ambient/per-document read
      // egresses without a per-document consent step — refresh the capability
      // probe the vault UI reads.
      queryClient.invalidateQueries({
        queryKey: queryKeys.inboundDocumentAiCapability(),
      });
      setPendingEnable(false);
    },
  });

  function onSwitch(next: boolean) {
    if (next) {
      // Off → on: reveal the honesty confirm; do NOT write yet.
      if (!enabled) setPendingEnable(true);
      return;
    }
    // On → off (or cancel a pending enable): write immediately, hide confirm.
    setPendingEnable(false);
    if (enabled) save.mutate(false);
  }

  const busy = isLoading || save.isPending;
  const checked = enabled || pendingEnable;

  return (
    <div
      data-slot="documents-auto-read-card"
      className="bg-muted/50 space-y-4 rounded-lg p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {t("settings.ai.autoRead.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("settings.ai.autoRead.subLabel")}
          </p>
        </div>
        <Switch
          checked={checked}
          disabled={busy}
          onCheckedChange={onSwitch}
          aria-label={t("settings.ai.autoRead.title")}
          data-testid="documents-auto-read-enable"
        />
      </div>

      {pendingEnable ? (
        <div
          data-slot="documents-auto-read-confirm"
          role="note"
          className="border-border space-y-3 rounded-lg border border-dashed px-3 py-2.5"
        >
          <div className="flex items-start gap-2 text-sm">
            <ShieldAlert
              className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
              aria-hidden
            />
            <p className="min-w-0">{t("settings.ai.autoRead.honesty")}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={save.isPending}
              onClick={() => save.mutate(true)}
              data-slot="documents-auto-read-confirm-cta"
            >
              {t("settings.ai.autoRead.confirm")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-11 sm:min-h-9"
              disabled={save.isPending}
              onClick={() => setPendingEnable(false)}
            >
              {t("settings.ai.autoRead.cancel")}
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
