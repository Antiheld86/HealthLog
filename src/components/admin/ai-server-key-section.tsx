"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet, apiPut } from "@/lib/api/api-fetch";
import { PasswordInput } from "./_shared";

/**
 * v1.16.6 — operator panel for the server-wide AI key.
 *
 * The backing endpoint (`/api/admin/ai-settings`, admin-cookie-only) has
 * existed since the `admin-openai` chain fallback shipped, but it never had
 * an operator UI — configuring the shared key took a manual API call. This
 * card is its home, beside the assistant feature flags.
 *
 * Semantics worth keeping visible to the operator:
 *   - A user's own key (BYOK / Codex OAuth / local) always wins; the server
 *     key sits at the END of the provider chain as the shared fallback.
 *   - Egress over the server key is consent-gated per user
 *     (`ConsentRequiredError` in `src/lib/ai/consent-guard.ts`) — setting a
 *     key here never silently forwards anyone's health data.
 *   - The base URL is locked server-side to HTTPS + a hostname allowlist
 *     (`ADMIN_AI_BASE_URL_ALLOWLIST` extends it).
 */

interface AiServerKeyResponse {
  hasKey: boolean;
  keyPreview: string | null;
  model: string;
  baseUrl: string;
}

export function AiServerKeySection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const { data: settings } = useQuery({
    queryKey: queryKeys.adminAiServerKey(),
    queryFn: () => apiGet<AiServerKeyResponse>("/api/admin/ai-settings"),
  });

  const [keyDraft, setKeyDraft] = useState("");
  const [modelDraft, setModelDraft] = useState<string | null>(null);
  const [baseUrlDraft, setBaseUrlDraft] = useState<string | null>(null);

  const modelValue = modelDraft ?? settings?.model ?? "";
  const baseUrlValue = baseUrlDraft ?? settings?.baseUrl ?? "";
  const configured = settings?.hasKey ?? false;

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiPut<AiServerKeyResponse>("/api/admin/ai-settings", payload),
    onSuccess: () => {
      setKeyDraft("");
      setModelDraft(null);
      setBaseUrlDraft(null);
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminAiServerKey(),
      });
      toast.success(t("admin.aiServerKey.saved"));
    },
    onError: (error: unknown) => {
      toast.error(
        error instanceof Error ? error.message : t("admin.aiServerKey.error"),
      );
    },
  });

  function handleSave() {
    const payload: Record<string, unknown> = {
      model: modelValue,
      baseUrl: baseUrlValue,
    };
    if (keyDraft.trim().length > 0) {
      payload.apiKey = keyDraft.trim();
    }
    save.mutate(payload);
  }

  function handleRemove() {
    save.mutate({ apiKey: "" });
  }

  return (
    <SettingsCard data-slot="admin-ai-server-key">
      <SettingsCardHeader
        icon={KeyRound}
        title={t("admin.aiServerKey.title")}
        description={t("admin.aiServerKey.description")}
        status={
          <Badge variant={configured ? "default" : "outline"}>
            {configured
              ? t("admin.aiServerKey.statusConfigured")
              : t("admin.aiServerKey.statusNotConfigured")}
          </Badge>
        }
      />

      <div className="space-y-4">
        <div className="space-y-2 text-sm">
          <p>{t("admin.aiServerKey.byokHint")}</p>
          <p>{t("admin.aiServerKey.consentHint")}</p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="admin-ai-server-key-input">
            {t("admin.aiServerKey.keyLabel")}
          </Label>
          <PasswordInput
            id="admin-ai-server-key-input"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            placeholder={
              configured && settings?.keyPreview
                ? t("admin.aiServerKey.keyPlaceholderSet", {
                    preview: settings.keyPreview,
                  })
                : t("admin.aiServerKey.keyPlaceholder")
            }
            autoComplete="off"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="admin-ai-server-key-model">
              {t("admin.aiServerKey.modelLabel")}
            </Label>
            <Input
              id="admin-ai-server-key-model"
              value={modelValue}
              onChange={(e) => setModelDraft(e.target.value)}
              placeholder="gpt-4o"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="admin-ai-server-key-base-url">
              {t("admin.aiServerKey.baseUrlLabel")}
            </Label>
            <Input
              id="admin-ai-server-key-base-url"
              value={baseUrlValue}
              onChange={(e) => setBaseUrlDraft(e.target.value)}
              placeholder="https://api.openai.com/v1"
            />
          </div>
        </div>

        <SettingsCardActions>
          {configured && (
            <ConfirmButton
              slot="admin-ai-server-key-remove"
              variant="outline"
              size="sm"
              label={t("admin.aiServerKey.remove")}
              title={t("admin.aiServerKey.removeTitle")}
              body={t("admin.aiServerKey.removeBody")}
              confirmLabel={t("admin.aiServerKey.removeConfirm")}
              pending={save.isPending}
              onConfirm={handleRemove}
            />
          )}
          <Button
            size="sm"
            className="min-h-11 sm:min-h-9"
            onClick={handleSave}
            disabled={save.isPending}
            data-slot="admin-ai-server-key-save"
          >
            {save.isPending && (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("admin.aiServerKey.save")}
          </Button>
        </SettingsCardActions>
      </div>
    </SettingsCard>
  );
}
