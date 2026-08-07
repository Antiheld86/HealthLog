"use client";

// v1.12.0 — Fitbit (Fitbit & Pixel) card. Mirrors the WHOOP card: a
// BYO-key credentials form first, then an OAuth connect, then the
// sync/test/disconnect action row + parked-resume banner. v1.12.1 — status
// reads off the consolidated /api/integrations/status envelope (the per-card
// /api/fitbit/status round-trip is gone); the pill/error/parked state comes off
// the same view-model like WHOOP.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  HeartPulse,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Unlink,
} from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { TagChip } from "@/components/ui/tag-chip";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { IntegrationStatusPill } from "@/components/settings/integration-status-pill";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
import { WrittenOutcomeLine } from "@/components/outcome/written-outcome-line";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

import {
  IntegrationErrorMessage,
  pillFailurePropsFor,
  pillStateFor,
  pillTimestampFor,
  type IntegrationStatusViewModel,
} from "./shared";
import { MetricFreshnessDisclosure } from "./metric-freshness-disclosure";
import {
  readSyncOutcome,
  useSyncOutcomeMessage,
  type SyncOutcomeState,
} from "./sync-outcome";
import {
  IntegrationCardDescription,
  IntegrationRedirectGuide,
} from "./setup-guide-link";

export function FitbitCard({
  viewModel,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
}) {
  const { t } = useTranslations();
  const describeSyncOutcome = useSyncOutcomeMessage();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncOutcomeState | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const queryClient = useQueryClient();

  const status = viewModel;

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost("/api/fitbit/disconnect");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.fitbit() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  // Clear a parked integration via the resume endpoint. The CTA is
  // rendered inside the parked banner below; success invalidates both
  // the per-card status (so the pill flips back to connected
  // immediately) and the cross-integration envelope (so any other view
  // picks up the change on its next focus).
  const resume = useMutation({
    mutationFn: async () => {
      return apiPost<{ resumed: boolean; wasParked: boolean }>(
        "/api/integrations/fitbit/resume",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.fitbit() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await apiFetchRaw("/api/fitbit/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullSync }),
      });
      const json = await res.json();
      const result = res.ok ? readSyncOutcome(json) : null;
      if (result) {
        // The tone comes off what the run wrote, not off `res.ok`.
        setSyncResult({
          outcome: result.outcome,
          message: describeSyncOutcome(
            result,
            t("settings.fitbitSyncResult", { count: result.imported }),
          ),
        });
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: queryKeys.fitbit() });
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setSyncResult({
          outcome: "failed",
          message: json?.error || t("settings.fitbitSyncFailed"),
        });
      }
    } catch {
      setSyncResult({
        outcome: "failed",
        message: t("settings.fitbitSyncFailed"),
      });
    } finally {
      setSyncing(false);
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);
    setCredsMsgType(null);

    try {
      const res = await apiFetchRaw("/api/fitbit/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.fitbitCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: queryKeys.fitbit() });
      } else {
        try {
          const json = await res.json();
          setCredsMsg(json.error || t("settings.savingError"));
        } catch {
          setCredsMsg(t("settings.savingError"));
        }
        setCredsMsgType("error");
      }
    } catch {
      setCredsMsg(t("common.networkError"));
      setCredsMsgType("error");
    }
    setCredsSaving(false);
  }

  // The server resolves the verdict; the card only projects it. `connected`
  // rides into that resolution, so a disconnected provider still lands on the
  // "Not connected" pill without a second local rule here.
  const pillState = pillStateFor(viewModel);
  const pillLastSyncAt = pillTimestampFor(viewModel);
  const errorMessage =
    (pillState === "error" ||
      pillState === "parked" ||
      pillState === "warning") &&
    viewModel?.lastError
      ? viewModel.lastError
      : null;

  return (
    <SettingsCard data-testid="fitbit-card">
      <SettingsCardHeader
        icon={HeartPulse}
        title={t("settings.fitbit")}
        titleAccessory={
          <>
            <TagChip>{t("settings.fitbitTag")}</TagChip>
            <Badge
              variant="outline"
              data-testid="fitbit-experimental-badge"
              className="border-warning/50 text-warning"
            >
              {t("settings.fitbitExperimentalBadge")}
            </Badge>
          </>
        }
        description={
          <IntegrationCardDescription
            i18nPrefix="settings.fitbit"
            provider="fitbit"
          />
        }
        status={
          <IntegrationStatusPill
            state={pillState}
            lastSyncAt={pillLastSyncAt}
            {...pillFailurePropsFor(viewModel)}
          />
        }
      />

      <hr data-testid="integration-card-divider" className="border-border/60" />

      <div className="space-y-4">
        {errorMessage && <IntegrationErrorMessage message={errorMessage} />}
        {/* Parked-integration resume CTA. Surfaces only when the row
            state is `parked` (>24h of persistent failures). The button
            POSTs to /api/integrations/fitbit/resume which calls
            `resumeIntegrationFromPark`; on success the per-card status
            invalidates and the pill flips back to connected without a
            page refresh. */}
        {pillState === "parked" && (
          <div
            data-testid="fitbit-parked-banner"
            className="border-warning/30 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-warning min-w-0 text-xs break-words">
              {t("settings.integrationPill.parkedReconnect")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => resume.mutate()}
              disabled={resume.isPending}
              data-testid="fitbit-resume-button"
              className="min-h-11"
            >
              {resume.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              {t("settings.integrationPill.resumeCta")}
            </Button>
          </div>
        )}
        {resume.isError && (
          <p
            role="alert"
            className="text-destructive text-sm"
            data-testid="fitbit-resume-error"
          >
            {t("settings.integrationPill.resumeError")}
          </p>
        )}

        {status?.connected && (
          <MetricFreshnessDisclosure
            entries={viewModel?.metricFreshness}
            idPrefix="fitbit"
          />
        )}
        {resume.isSuccess && resume.data?.wasParked && (
          <p
            role="status"
            className="text-success text-xs"
            data-testid="fitbit-resume-success"
          >
            {t("settings.integrationPill.resumeSuccess")}
          </p>
        )}

        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {t("settings.fitbitCredentials")}
          </h3>
          {!status?.configured && (
            <IntegrationRedirectGuide
              provider="fitbit"
              providerLabel={t("settings.fitbit")}
            />
          )}
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="fitbit-clientid">
                  {t("settings.fitbitClientId")}
                </Label>
                <Input
                  id="fitbit-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.fitbitCredentialsSavedPlaceholder")
                      : t("settings.fitbitClientId")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="next"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fitbit-secret">
                  {t("settings.fitbitClientSecret")}
                </Label>
                <PasswordInput
                  id="fitbit-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.fitbitCredentialsSavedPlaceholderSecret")
                      : t("settings.fitbitClientSecret")
                  }
                  maxLength={200}
                  autoComplete="off"
                  inputMode="text"
                  spellCheck={false}
                  autoCapitalize="none"
                  enterKeyHint="done"
                />
              </div>
            </div>
            <p className="text-muted-foreground text-xs">
              {t("settings.integrationCredentialsHint")}
            </p>
            <div className="flex justify-end">
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="min-h-11 w-full sm:w-auto"
                disabled={
                  credsSaving || !clientId.trim() || !clientSecret.trim()
                }
              >
                {credsSaving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {t("settings.fitbitSaveCredentials")}
              </Button>
            </div>
            {credsMsg && (
              <p
                role="alert"
                className={`text-sm ${credsMsgType === "success" ? "text-success" : "text-destructive"}`}
              >
                {credsMsg}
              </p>
            )}
          </form>
        </div>

        {status?.connected ? (
          <>
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <Button
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => handleSync(false)}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {t("settings.fitbitSync")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    disabled={syncing}
                  >
                    {syncing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {t("settings.fitbitFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.fitbitFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.fitbitFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.fitbitSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <TestConnectionButton
                endpoint="/api/integrations/fitbit/test"
                disabled={!status?.connected}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive min-h-11"
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    {t("settings.fitbitDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.fitbitDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.fitbitDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.fitbitDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {status?.backfillCompleted === false && (
              <p className="text-muted-foreground text-xs">
                {t("settings.fitbitBackfillInProgress")}
              </p>
            )}
            {syncResult && (
              <WrittenOutcomeLine
                outcome={syncResult.outcome}
                message={syncResult.message}
                testId="fitbit-sync-result"
              />
            )}
            {/* connect→data loop: a discreet link to where this provider's
                readings now surface — doubles as the "your data is richer"
                cue. */}
            <Link
              href="/insights/sleep"
              data-testid="fitbit-data-link"
              className="text-primary inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              {t("settings.fitbitViewData")}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        ) : status?.configured ? (
          <Button
            variant="outline"
            onClick={() => {
              window.location.href = "/api/fitbit/connect";
            }}
          >
            <Link2 className="h-4 w-4" />
            {t("settings.fitbitConnect")}
          </Button>
        ) : (
          <div className="bg-muted/50 text-muted-foreground rounded-lg p-3 text-sm">
            {t("settings.fitbitNoCredentials")}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
