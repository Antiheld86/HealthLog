"use client";

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
  pillStateFor,
  pillFailurePropsFor,
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
  CallbackMismatchNotice,
  IntegrationCardDescription,
  IntegrationRedirectGuide,
} from "./setup-guide-link";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";

export function WithingsCard({
  viewModel,
  callbackUrl,
}: {
  viewModel: IntegrationStatusViewModel | undefined;
  /** Server-resolved OAuth callback URL; see `getIntegrationCallbackUrls`. */
  callbackUrl: IntegrationCallbackUrls["withings"];
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

  // v1.12.1 — the Withings status is read off the consolidated
  // /api/integrations/status envelope (the `viewModel` prop). The
  // per-card /api/withings/status round-trip is gone; the envelope
  // carries every field this card renders (connected / configured /
  // last-sync / activity scope).
  const status = viewModel;

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost("/api/withings/disconnect");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  // v1.4.43 W14 — clear a parked integration via the resume endpoint.
  // The CTA is rendered inside the parked banner below; success
  // invalidates both the per-card status (so the pill flips back to
  // connected immediately) and the cross-integration envelope (so any
  // other view picks up the change on its next focus).
  const resume = useMutation({
    mutationFn: async () => {
      return apiPost<{ resumed: boolean; wasParked: boolean }>(
        "/api/integrations/withings/resume",
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  async function handleSync(fullSync = false) {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await apiFetchRaw("/api/withings/sync", {
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
            fullSync
              ? t("settings.withingsFullSyncResult", { count: result.imported })
              : t("settings.withingsSyncResult", { count: result.imported }),
          ),
        });
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setSyncResult({
          outcome: "failed",
          message: json?.error || t("settings.withingsSyncFailed"),
        });
      }
    } catch {
      setSyncResult({
        outcome: "failed",
        message: t("settings.withingsSyncFailed"),
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
      const res = await apiFetchRaw("/api/withings/credentials", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });

      if (res.ok) {
        setCredsMsg(t("settings.withingsCredentialsSaved"));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: queryKeys.withings() });
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

  // The pill state derives from the cross-integration status
  // envelope. `legacyLastSyncedAt` is the connection row's own
  // last-sync timestamp (carried in the same envelope) so the pill
  // still paints a fresh "X min ago" right after a manual sync once
  // the envelope refetches. When the envelope hasn't answered yet we
  // fall back to "disconnected" so the card never renders status-less.
  // The server resolves the verdict; the card only projects it. `connected`
  // rides into that resolution, so a disconnected provider still lands on the
  // "Not connected" pill without a second local rule here.
  const pillState = pillStateFor(viewModel);
  const pillLastSyncAt = pillTimestampFor(viewModel);
  // v1.4.43 W14 — `parked` and `error` both want the underlying error
  // message surfaced under the pill (the pill says "what" — the
  // message says "why"). Other states leave the inline line off.
  const errorMessage =
    (pillState === "error" ||
      pillState === "parked" ||
      pillState === "warning") &&
    viewModel?.lastError
      ? viewModel.lastError
      : null;

  return (
    <SettingsCard data-testid="withings-card">
      <SettingsCardHeader
        icon={Link2}
        title={t("settings.withings")}
        description={
          <IntegrationCardDescription
            i18nPrefix="settings.withings"
            provider="withings"
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
        {/* v1.4.25 W5d — Withings activity-scope reconnect banner.
            Only paints when (a) the user has an active Withings
            connection (so the credentials are already saved + a token
            exists) AND (b) the persisted scope is missing
            `user.activity`. Reconnecting takes the user through the
            standard /api/withings/connect → Withings → callback flow;
            the callback persists the upgraded scope and the banner
            vanishes on the next status poll. */}
        {status?.connected && status?.hasActivityScope === false && (
          <a
            href="/api/withings/connect"
            data-testid="withings-reconnect-banner"
            className="border-warning/30 bg-warning/10 text-foreground hover:bg-warning/20 block rounded-md border px-3 py-2 text-sm transition-colors"
          >
            <span className="font-medium">
              {t("settings.integrations.withings.reconnect.banner.title")}
            </span>
            <span className="text-muted-foreground block text-xs">
              {t("settings.integrations.withings.reconnect.banner.body")}
            </span>
            <span className="text-primary mt-1 inline-block text-xs font-medium">
              {t("settings.integrations.withings.reconnect.banner.action")}
              {" →"}
            </span>
          </a>
        )}
        {/* v1.4.43 W14 — parked-integration resume CTA. Surfaces only
            when the row state is `parked` (>24h of persistent
            failures). The button POSTs to /api/integrations/withings/
            resume which calls `resumeIntegrationFromPark`; on success
            the per-card status invalidates and the pill flips back to
            connected without a page refresh. The button is the
            primary action the user can take from this card — wider
            tap target than the inline action row so it's reachable
            on a Pixel 5 viewport. */}
        {pillState === "parked" && (
          <div
            data-testid="withings-parked-banner"
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
              data-testid="withings-resume-button"
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
            data-testid="withings-resume-error"
          >
            {t("settings.integrationPill.resumeError")}
          </p>
        )}

        {status?.connected && (
          <MetricFreshnessDisclosure
            entries={viewModel?.metricFreshness}
            idPrefix="withings"
          />
        )}
        {resume.isSuccess && resume.data?.wasParked && (
          <p
            role="status"
            className="text-success text-xs"
            data-testid="withings-resume-success"
          >
            {t("settings.integrationPill.resumeSuccess")}
          </p>
        )}
        <div className="space-y-3">
          <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {t("settings.withingsCredentials")}
          </h3>
          {!status?.configured && (
            <IntegrationRedirectGuide
              provider="withings"
              providerLabel={t("settings.withings")}
              callbackUrl={callbackUrl}
            />
          )}
          <form onSubmit={handleSaveCredentials} className="space-y-3">
            {/* v1.4.27 MB7 / CF-53 — the credentials grid drops from
                a 3-column row (client-id / secret / save) to a
                2-column row of inputs at `sm:`, with the Save button
                lifted out into its own row below. The previous
                "invisible Label" hack to align the button with the
                input baselines fell apart on Galaxy Fold; lifting
                the button into a dedicated `flex justify-end` row
                gives it consistent placement on every viewport and
                lets the input pair span the full width. */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="w-clientid">
                  {t("settings.withingsClientId")}
                </Label>
                <Input
                  id="w-clientid"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholder")
                      : t("settings.withingsClientId")
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
                <Label htmlFor="w-secret">
                  {t("settings.withingsClientSecret")}
                </Label>
                <PasswordInput
                  id="w-secret"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    status?.configured
                      ? t("settings.withingsCredentialsSavedPlaceholderSecret")
                      : t("settings.withingsClientSecret")
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
                {t("settings.withingsSaveCredentials")}
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
            {/* v1.4.27 MB7 / CF-57 — the action row already wraps via
                `flex-wrap`, but on Pixel 5 the four AlertDialog +
                test-connection triggers each took a fractional slot
                that read jagged. Force each button to a `min-w-[10rem]`
                on `<sm` so they stack two per row at most and fill
                their column cleanly. Tablet+ keeps the inline row. */}
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
                {t("settings.withingsSync")}
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
                    {t("settings.withingsFullSync")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsFullSyncTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsFullSyncDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleSync(true)}>
                      {t("settings.withingsSynchronize")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <TestConnectionButton
                endpoint="/api/integrations/withings/test"
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
                    {t("settings.withingsDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.withingsDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.withingsDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.withingsDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {syncResult && (
              <WrittenOutcomeLine
                outcome={syncResult.outcome}
                message={syncResult.message}
                testId="withings-sync-result"
              />
            )}
            {/* connect→data loop: a discreet link to where this provider's
                readings now surface — doubles as the "your data is richer"
                cue. */}
            <Link
              href="/measurements"
              data-testid="withings-data-link"
              className="text-primary inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              {t("settings.withingsViewData")}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        ) : status?.configured ? (
          <SettingsCardActions>
            <Button
              size="sm"
              className="min-h-11 w-full sm:w-auto"
              data-testid="withings-connect"
              onClick={() => {
                window.location.href = "/api/withings/connect";
              }}
            >
              <Link2 className="h-3.5 w-3.5" />
              {t("settings.withingsConnect")}
            </Button>
          </SettingsCardActions>
        ) : (
          <p
            className="text-muted-foreground text-xs"
            data-testid="integration-unavailable"
          >
            {t("settings.withingsNoCredentials")}
          </p>
        )}
      </div>
      <CallbackMismatchNotice
        provider={t("settings.withings")}
        callbackUrl={callbackUrl}
      />
    </SettingsCard>
  );
}
