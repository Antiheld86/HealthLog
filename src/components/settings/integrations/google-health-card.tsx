"use client";

// v1.27.0 — Google Health (Fitbit + Pixel Watch + Fitbit Air) card. Reads
// Fitbit and Pixel Watch data through the successor Google Health API — a
// separate, coexisting integration from the classic `fitbit` transport, which
// sunsets Sept 2026. Mirrors the Fitbit card anatomy: a BYO Google-Cloud
// client-id/secret form first, then an OAuth connect, then the
// sync/test/disconnect action row + parked-resume banner. Status reads off the
// consolidated /api/integrations/status envelope (no per-card round-trip).
//
// One thing this card carries that the classic Fitbit card does not: a distinct
// RE-CONSENT CTA. Google expires the refresh token after 7 days while the
// operator's OAuth client stays in "Testing" publishing mode (the CASA-free
// path), so a connected user is periodically pushed back through OAuth. When the
// envelope reports `needsReauth`, the card surfaces a clear "Reconnect" banner
// separate from the connect/disconnect state.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Unlink,
  Watch,
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
import { SettingsCardActions } from "@/components/settings/_card-actions";
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
  completedGoogleHealthResourceCount,
  failedGoogleHealthResources,
  googleHealthReasonCode,
  readGoogleHealthProgress,
  type GoogleHealthProgress,
} from "./google-health-progress-view";
import {
  readSyncOutcome,
  useSyncOutcomeMessage,
  type SyncOutcomeResource,
  type SyncOutcomeState,
} from "./sync-outcome";
import {
  CallbackMismatchNotice,
  IntegrationCardDescription,
} from "./setup-guide-link";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";

export function GoogleHealthCard({
  viewModel,
  callbackUrl,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
  /** Server-resolved OAuth callback URL; see `getIntegrationCallbackUrls`. */
  callbackUrl: IntegrationCallbackUrls["google-health"];
}) {
  const { t } = useTranslations();
  const describeSyncOutcome = useSyncOutcomeMessage();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncOutcomeState | null>(null);
  const [syncProgress, setSyncProgress] = useState<GoogleHealthProgress | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const queryClient = useQueryClient();

  const status = viewModel;

  function invalidateCommittedWorkout(resources: SyncOutcomeResource[]) {
    const workoutCommitted = resources.some(
      (resource) =>
        resource.resource === "workout" &&
        typeof resource.written === "number" &&
        resource.written > 0,
    );
    if (!workoutCommitted) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.workouts() });
    // prettier-ignore
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboardSnapshot() });
    queryClient.invalidateQueries({ queryKey: queryKeys.analytics() });
  }

  async function pollSyncStatus(
    maxAttempts = 20,
  ): Promise<GoogleHealthProgress | null> {
    let latest: GoogleHealthProgress | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await apiFetchRaw("/api/google-health/sync/status");
        const progress = readGoogleHealthProgress(await response.json());
        if (response.ok && progress) {
          latest = progress;
          setSyncProgress(progress);
          if (progress.state !== "in_progress") return progress;
        }
      } catch {
        // The POST may have committed even when its response was lost. Keep
        // this bounded poll best-effort; the status CTA can retry it.
      }
      if (attempt + 1 < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 750));
      }
    }
    return latest;
  }

  function showProgress(progress: GoogleHealthProgress): void {
    setSyncProgress(progress);
    invalidateCommittedWorkout(progress.resources);
    if (progress.state === "in_progress") {
      setSyncResult(null);
      return;
    }
    const failed =
      progress.state === "failed" || progress.state === "interrupted";
    const outcome =
      progress.state === "partial" || progress.state === "truncated"
        ? "partial"
        : failed
          ? "failed"
          : progress.imported > 0
            ? "success"
            : "empty";
    const resolved = {
      imported: progress.imported,
      failed: failed || outcome === "partial",
      outcome,
    } as const;
    setSyncResult({
      outcome: resolved.outcome,
      message: describeSyncOutcome(
        resolved,
        t("settings.googleHealthSyncResult", { count: progress.imported }),
      ),
    });
  }

  function progressFromOutcome(
    result: ReturnType<typeof readSyncOutcome>,
  ): GoogleHealthProgress | null {
    if (!result?.resources) return null;
    return {
      state:
        result.outcome === "failed"
          ? "failed"
          : result.outcome === "partial"
            ? "partial"
            : result.outcome === "empty"
              ? "zero"
              : "complete",
      imported: result.imported,
      resources: result.resources,
    };
  }

  async function refreshSyncStatus() {
    setSyncing(true);
    try {
      const progress = await pollSyncStatus(4);
      if (progress) showProgress(progress);
      else {
        setSyncResult({
          outcome: "failed",
          message: t("settings.googleHealthSyncFailed"),
        });
      }
    } finally {
      setSyncing(false);
    }
  }

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost("/api/google-health/disconnect");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.googleHealth() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  // Clear a parked integration via the resume endpoint. The CTA is rendered
  // inside the parked banner below; success invalidates both the per-card
  // status and the cross-integration envelope so any other view picks up the
  // change on its next focus.
  const resume = useMutation({
    mutationFn: async () => {
      return apiPost<{ resumed: boolean; wasParked: boolean }>(
        "/api/integrations/google-health/resume",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.googleHealth() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncResult(null);
    setSyncProgress(null);
    try {
      const res = await apiFetchRaw("/api/google-health/sync", {
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
            t("settings.googleHealthSyncResult", { count: result.imported }),
          ),
        });
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: queryKeys.googleHealth() });
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
        const progress =
          readGoogleHealthProgress(json) ?? progressFromOutcome(result);
        if (progress) showProgress(progress);
      } else {
        const progress = await pollSyncStatus();
        if (progress) {
          showProgress(progress);
        } else {
          setSyncResult({
            outcome: "failed",
            message: json?.error || t("settings.googleHealthSyncFailed"),
          });
        }
      }
    } catch {
      const progress = await pollSyncStatus();
      if (progress) {
        showProgress(progress);
      } else {
        setSyncResult({
          outcome: "failed",
          message: t("settings.googleHealthSyncFailed"),
        });
      }
    } finally {
      setSyncing(false);
    }
  }

  function resourceLabel(resource: string): string {
    switch (resource) {
      case "workout":
        return t("settings.googleHealthResource.workout");
      case "sleep":
        return t("settings.googleHealthResource.sleep");
      case "bounded-metrics":
        return t("settings.googleHealthResource.boundedMetrics");
      case "activity":
        return t("settings.googleHealthResource.activity");
      case "dense-heart-rate":
        return t("settings.googleHealthResource.heartRate");
      default:
        return t("settings.googleHealthResource.other");
    }
  }

  function resourceFailureMessage(resource: SyncOutcomeResource): string {
    switch (googleHealthReasonCode(resource)) {
      case "collection_failed":
        return t("settings.googleHealthReason.collectionFailed");
      case "token_failed":
        return t("settings.googleHealthReason.tokenFailed");
      case "upsert_failed":
        return t("settings.googleHealthReason.upsertFailed");
      case "rollup_failed":
        return t("settings.googleHealthReason.rollupFailed");
      case "existing_page_limit":
        return t("settings.googleHealthReason.pageLimit");
      default:
        return t("settings.googleHealthReason.generic");
    }
  }

  async function handleSaveCredentials(e: React.FormEvent) {
    e.preventDefault();
    setCredsSaving(true);
    setCredsMsg(null);
    setCredsMsgType(null);

    try {
      const res = await apiFetchRaw("/api/google-health/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.googleHealthCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: queryKeys.googleHealth() });
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
  // The re-consent banner only makes sense while the connection still exists —
  // a disconnected card has no token to renew. `needsReauth` is the 7-day
  // Testing-mode expiry (or a revoked grant) surfaced by the status route.
  const showReauth = Boolean(status?.connected && status?.needsReauth);
  const resourceFailures = failedGoogleHealthResources(syncProgress);
  const completedResources = completedGoogleHealthResourceCount(syncProgress);

  return (
    <SettingsCard data-testid="google-health-card">
      <SettingsCardHeader
        icon={Watch}
        title={t("settings.googleHealth")}
        titleAccessory={
          <>
            <TagChip>{t("settings.googleHealthTag")}</TagChip>
            <Badge
              variant="outline"
              data-testid="google-health-beta-badge"
              className="border-warning/50 text-warning"
            >
              {t("settings.googleHealthBetaBadge")}
            </Badge>
          </>
        }
        description={
          <IntegrationCardDescription
            i18nPrefix="settings.googleHealth"
            provider="google-health"
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

        {/* Re-consent CTA — distinct from parked/disconnected. Google expires
            the refresh token after 7 days in "Testing" publishing mode (the
            CASA-free path), so a connected user is periodically pushed back
            through OAuth. Re-running connect mints a fresh grant. */}
        {showReauth && (
          <div
            data-testid="google-health-reauth-banner"
            className="border-warning/30 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-warning min-w-0 text-xs break-words">
              {t("settings.googleHealthReauthBanner")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                window.location.href = "/api/google-health/connect";
              }}
              data-testid="google-health-reconnect-button"
              className="min-h-11"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("settings.googleHealthReconnect")}
            </Button>
          </div>
        )}

        {/* Parked-integration resume CTA — surfaces only when the row state is
            `parked` (>24h of persistent failures). */}
        {pillState === "parked" && (
          <div
            data-testid="google-health-parked-banner"
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
              data-testid="google-health-resume-button"
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
            data-testid="google-health-resume-error"
          >
            {t("settings.integrationPill.resumeError")}
          </p>
        )}

        {status?.connected && (
          <MetricFreshnessDisclosure
            entries={viewModel?.metricFreshness}
            idPrefix="google-health"
          />
        )}
        {resume.isSuccess && resume.data?.wasParked && (
          <p
            role="status"
            className="text-success text-xs"
            data-testid="google-health-resume-success"
          >
            {t("settings.integrationPill.resumeSuccess")}
          </p>
        )}

        <div className="space-y-3">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t("settings.googleHealthCredentials")}
          </h3>
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="google-health-clientid">
                  {t("settings.googleHealthClientId")}
                </Label>
                <Input
                  id="google-health-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.googleHealthCredentialsSavedPlaceholder")
                      : t("settings.googleHealthClientId")
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
                <Label htmlFor="google-health-secret">
                  {t("settings.googleHealthClientSecret")}
                </Label>
                <PasswordInput
                  id="google-health-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t(
                          "settings.googleHealthCredentialsSavedPlaceholderSecret",
                        )
                      : t("settings.googleHealthClientSecret")
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
                {t("settings.googleHealthSaveCredentials")}
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
                onClick={() => {
                  if (syncProgress?.state === "in_progress") {
                    void refreshSyncStatus();
                  } else {
                    void handleSync(false);
                  }
                }}
                disabled={syncing}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {syncProgress?.state === "in_progress"
                  ? t("settings.googleHealthSyncCheckStatus")
                  : t("settings.googleHealthSync")}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="min-h-11"
                    disabled={syncing || syncProgress?.state === "in_progress"}
                  >
                    {syncing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    {t("settings.googleHealthFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.googleHealthFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.googleHealthFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.googleHealthSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <TestConnectionButton
                endpoint="/api/integrations/google-health/test"
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
                    {t("settings.googleHealthDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.googleHealthDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.googleHealthDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.googleHealthDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {status?.backfillCompleted === false && (
              <p className="text-muted-foreground text-xs">
                {t("settings.googleHealthBackfillInProgress")}
              </p>
            )}
            {syncProgress?.state === "in_progress" && (
              <p
                role="status"
                aria-live="polite"
                className="text-muted-foreground text-xs"
                data-testid="google-health-sync-progress"
              >
                {t("settings.googleHealthSyncInProgress", {
                  count: syncProgress.imported,
                  completed: completedResources,
                  total: syncProgress.resources.length,
                })}
              </p>
            )}
            {syncResult && (
              <WrittenOutcomeLine
                outcome={syncResult.outcome}
                message={syncResult.message}
                testId="google-health-sync-result"
              />
            )}
            {resourceFailures.length > 0 && (
              <div
                role="alert"
                data-testid="google-health-resource-failures"
                className="border-warning/30 bg-warning/10 rounded-md border px-3 py-2"
              >
                <p className="text-foreground text-xs font-medium">
                  {t("settings.googleHealthResourceFailuresTitle")}
                </p>
                <ul className="text-muted-foreground mt-1 space-y-1 text-xs">
                  {resourceFailures.map((resource) => (
                    <li key={resource.resource}>
                      <span className="text-foreground font-medium">
                        {resourceLabel(resource.resource)}
                      </span>
                      {": "}
                      {resourceFailureMessage(resource)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {/* connect→data loop: a discreet link to where this provider's
                readings now surface — doubles as the "your data is richer"
                cue. */}
            <Link
              href="/insights/steps"
              data-testid="google-health-data-link"
              className="text-primary inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              {t("settings.googleHealthViewData")}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        ) : status?.configured ? (
          <SettingsCardActions>
            <Button
              size="sm"
              className="min-h-11 w-full sm:w-auto"
              data-testid="googlehealth-connect"
              onClick={() => {
                window.location.href = "/api/google-health/connect";
              }}
            >
              <Link2 className="h-3.5 w-3.5" />
              {t("settings.googleHealthConnect")}
            </Button>
          </SettingsCardActions>
        ) : (
          <p
            className="text-muted-foreground text-xs"
            data-testid="integration-unavailable"
          >
            {t("settings.googleHealthNoCredentials")}
          </p>
        )}
      </div>
      <CallbackMismatchNotice
        provider={t("settings.googleHealth")}
        callbackUrl={callbackUrl}
      />
    </SettingsCard>
  );
}
