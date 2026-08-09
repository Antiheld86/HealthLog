"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
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
import { Button } from "@/components/ui/button";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
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

export function WhoopCard({
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

  // v1.12.1 — read off the consolidated /api/integrations/status
  // envelope; the per-card /api/whoop/status round-trip is gone.
  const status = viewModel;

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost("/api/whoop/disconnect");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.whoop() });
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
        "/api/integrations/whoop/resume",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.whoop() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await apiFetchRaw("/api/whoop/sync", {
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
            t("settings.whoopSyncResult", { count: result.imported }),
          ),
        });
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: queryKeys.whoop() });
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setSyncResult({
          outcome: "failed",
          message: json?.error || t("settings.whoopSyncFailed"),
        });
      }
    } catch {
      setSyncResult({
        outcome: "failed",
        message: t("settings.whoopSyncFailed"),
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
      const res = await apiFetchRaw("/api/whoop/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.whoopCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: queryKeys.whoop() });
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
    <SettingsCard data-testid="whoop-card">
      <SettingsCardHeader
        icon={Activity}
        title={t("settings.whoop")}
        description={
          <IntegrationCardDescription
            i18nPrefix="settings.whoop"
            provider="whoop"
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

      <div className="space-y-4">
        {errorMessage && <IntegrationErrorMessage message={errorMessage} />}
        {/* Parked-integration resume CTA. Surfaces only when the row
            state is `parked` (>24h of persistent failures). The button
            POSTs to /api/integrations/whoop/resume which calls
            `resumeIntegrationFromPark`; on success the per-card status
            invalidates and the pill flips back to connected without a
            page refresh. Wider tap target than the inline action row so
            it stays reachable on a Pixel 5 viewport. */}
        {pillState === "parked" && (
          <div
            data-testid="whoop-parked-banner"
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
              data-testid="whoop-resume-button"
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
            data-testid="whoop-resume-error"
          >
            {t("settings.integrationPill.resumeError")}
          </p>
        )}

        {status?.connected && (
          <MetricFreshnessDisclosure
            entries={viewModel?.metricFreshness}
            idPrefix="whoop"
          />
        )}
        {resume.isSuccess && resume.data?.wasParked && (
          <p
            role="status"
            className="text-success text-xs"
            data-testid="whoop-resume-success"
          >
            {t("settings.integrationPill.resumeSuccess")}
          </p>
        )}

        <div className="space-y-3">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t("settings.whoopCredentials")}
          </h3>
          {!status?.configured && (
            <IntegrationRedirectGuide
              provider="whoop"
              providerLabel={t("settings.whoop")}
            />
          )}
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="whoop-clientid">
                  {t("settings.whoopClientId")}
                </Label>
                <Input
                  id="whoop-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.whoopCredentialsSavedPlaceholder")
                      : t("settings.whoopClientId")
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
                <Label htmlFor="whoop-secret">
                  {t("settings.whoopClientSecret")}
                </Label>
                <PasswordInput
                  id="whoop-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.whoopCredentialsSavedPlaceholderSecret")
                      : t("settings.whoopClientSecret")
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
            <SettingsCardActions>
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
                {t("settings.whoopSaveCredentials")}
              </Button>
            </SettingsCardActions>
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
                {t("settings.whoopSync")}
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
                    {t("settings.whoopFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.whoopFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.whoopFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.whoopSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <TestConnectionButton
                endpoint="/api/integrations/whoop/test"
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
                    {t("settings.whoopDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.whoopDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.whoopDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.whoopDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {status?.backfillCompleted === false && (
              <p className="text-muted-foreground text-xs">
                {t("settings.whoopBackfillInProgress")}
              </p>
            )}
            {syncResult && (
              <WrittenOutcomeLine
                outcome={syncResult.outcome}
                message={syncResult.message}
                testId="whoop-sync-result"
              />
            )}
            {/* connect→data loop: a discreet link to where this provider's
                readings now surface — doubles as the "your data is richer"
                cue. */}
            <Link
              href="/insights/recovery"
              data-testid="whoop-data-link"
              className="text-primary inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              {t("settings.whoopViewData")}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        ) : status?.configured ? (
          <SettingsCardActions>
            <Button
              size="sm"
              className="min-h-11 w-full sm:w-auto"
              data-testid="whoop-connect"
              onClick={() => {
                window.location.href = "/api/whoop/connect";
              }}
            >
              <Link2 className="h-3.5 w-3.5" />
              {t("settings.whoopConnect")}
            </Button>
          </SettingsCardActions>
        ) : (
          <p
            className="text-muted-foreground text-xs"
            data-testid="integration-unavailable"
          >
            {t("settings.whoopNoCredentials")}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
