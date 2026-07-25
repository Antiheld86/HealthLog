"use client";

// v1.17.0 (F4) — shared OAuth integration card for Polar / Oura.
// v1.17.1 — these are now per-user BYO-key integrations (like WHOOP / Fitbit):
// the card renders an optional "your OAuth app credentials" form (driven by the
// `credentials` prop) above the connect button. Credentials resolve DB-first
// then env on the server, so a user who pastes their own client id/secret uses
// their own app while existing env-configured deploys keep working unchanged.
// Mirrors the Nightscout card's self-contained status pattern.

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Link2,
  Loader2,
  RefreshCw,
  Save,
  Unlink,
  type LucideIcon,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import {
  IntegrationStatusPill,
  type IntegrationPillState,
} from "@/components/settings/integration-status-pill";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { apiFetchRaw, apiGet, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";
import {
  IntegrationCardDescription,
  IntegrationRedirectGuide,
  type IntegrationDocsProvider,
} from "./setup-guide-link";

export interface OAuthProviderStatus {
  connected: boolean;
  configured: boolean;
  available: boolean;
  /** Whether the user has stored their own BYO client id/secret pair. */
  hasOwnCredentials?: boolean;
  state?:
    | "connected"
    | "error_transient"
    | "error_reauth"
    | "disconnected"
    | "parked";
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
}

function pillStateFor(
  status: OAuthProviderStatus | undefined,
): IntegrationPillState {
  if (!status?.connected) return "disconnected";
  switch (status.state) {
    case "parked":
      return "parked";
    case "error_reauth":
      return "error";
    case "error_transient":
      return "warning";
    default:
      return "connected";
  }
}

export interface OAuthProviderCardProps {
  /** Lower-case provider key, used for routes + query keys + testids. */
  provider: "polar" | "oura" | "strava";
  /** The query-key array shared by the status read + the invalidations. */
  statusQueryKey: readonly unknown[];
  /** i18n key prefix (e.g. `settings.polar`). */
  i18nPrefix: string;
  /** Distinct card glyph, kept in the same size/treatment as the other cards. */
  icon: LucideIcon;
  /** Where this provider's synced data surfaces (e.g. `/insights/sleep`). */
  dataHref: string;
  /** When set, render a per-user BYO OAuth-credentials form above the connect
   * button. The endpoint is the PUT target (e.g. `/api/polar/credentials`). */
  credentials?: boolean;
  enabled?: boolean;
  /**
   * When provided, the card reads its status from this view-model (sourced off
   * the consolidated `/api/integrations/status` envelope) instead of firing its
   * own `/api/<provider>/status` round-trip. v1.17.1 folds Polar/Oura onto the
   * same envelope WHOOP/Fitbit already use, so the page reads from one source.
   */
  viewModel?: OAuthProviderStatus;
}

export function OAuthProviderCard({
  provider,
  statusQueryKey,
  i18nPrefix,
  icon,
  dataHref,
  credentials = false,
  enabled = true,
  viewModel,
}: OAuthProviderCardProps) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [msg, setMsg] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncMsgType, setSyncMsgType] = useState<"success" | "error" | null>(
    null,
  );
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsMsg, setCredsMsg] = useState<string | null>(null);
  const [credsMsgType, setCredsMsgType] = useState<"success" | "error" | null>(
    null,
  );

  // Read off the consolidated envelope when a view-model is passed; otherwise
  // fall back to the per-card status fetch (still used by any caller that has
  // not been migrated onto the envelope). The fetch is disabled once a
  // view-model is supplied so the page makes one request, not one-per-card.
  const { data: fetchedStatus } = useQuery({
    queryKey: statusQueryKey,
    queryFn: async () => apiGet<OAuthProviderStatus>(`/api/${provider}/status`),
    enabled: enabled && !viewModel,
    refetchOnWindowFocus: true,
  });
  const status = viewModel ?? fetchedStatus;

  // Sync now. Same shape as the WHOOP card's incremental arm, minus the
  // full-history dialog — none of these providers has a full-sync arm to call.
  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    setSyncMsgType(null);
    try {
      const res = await apiFetchRaw(`/api/${provider}/sync`, {
        method: "POST",
      });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(t(`${i18nPrefix}SyncResult`, { count: json.data.imported }));
        setSyncMsgType("success");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({ queryKey: statusQueryKey });
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setSyncMsg(json.error || t(`${i18nPrefix}SyncFailed`));
        setSyncMsgType("error");
      }
    } catch {
      setSyncMsg(t(`${i18nPrefix}SyncFailed`));
      setSyncMsgType("error");
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
      const res = await apiFetchRaw(`/api/${provider}/credentials`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: clientId.trim(),
          clientSecret: clientSecret.trim(),
        }),
      });
      if (res.ok) {
        setCredsMsg(t(`${i18nPrefix}CredentialsSaved`));
        setCredsMsgType("success");
        setClientId("");
        setClientSecret("");
        queryClient.invalidateQueries({ queryKey: statusQueryKey });
        // The card may read off the consolidated envelope — invalidate it too
        // so the saved-credentials state repaints regardless of the source.
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
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

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost(`/api/${provider}/disconnect`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: statusQueryKey });
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  const pillState = pillStateFor(status);
  const errorMessage =
    (pillState === "error" || pillState === "parked") && status?.lastError
      ? status.lastError
      : null;
  const serverUnavailable = status && !status.available;

  function handleConnect() {
    setMsg(null);
    void invalidateKeys(queryClient, measurementDependentKeys);
    window.location.href = `/api/${provider}/connect`;
  }

  return (
    <SettingsCard data-testid={`${provider}-card`}>
      <SettingsCardHeader
        icon={icon}
        title={t(`${i18nPrefix}`)}
        description={
          <IntegrationCardDescription
            i18nPrefix={i18nPrefix}
            provider={provider as IntegrationDocsProvider}
          />
        }
        status={
          <IntegrationStatusPill
            state={pillState}
            lastSyncAt={status?.lastSuccessAt ?? null}
          />
        }
      />

      <hr className="border-border/60 mt-4" />

      <div className="mt-4 space-y-4 pl-7">
        {errorMessage && (
          <p
            role="alert"
            data-testid={`${provider}-error`}
            className="text-destructive text-sm break-words"
          >
            {errorMessage}
          </p>
        )}

        {/* Parked-integration resume CTA. Surfaces only when the row state
            is `parked` (>24h of persistent failures). For an env-based OAuth
            provider there are no stored BYO credentials to re-validate — the
            grant itself has to be re-issued, so "reconnect" re-initiates the
            existing connect flow (`/api/<provider>/connect`); a successful
            callback clears the park. Markup matches the WHOOP card byte for
            byte. */}
        {pillState === "parked" && (
          <div
            data-testid={`${provider}-parked-banner`}
            className="border-warning/30 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-warning min-w-0 text-xs break-words">
              {t("settings.integrationPill.parkedReconnect")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleConnect}
              disabled={serverUnavailable}
              data-testid={`${provider}-resume-button`}
              className="min-h-11"
            >
              <Link2 className="h-3.5 w-3.5" />
              {t("settings.integrationPill.resumeCta")}
            </Button>
          </div>
        )}

        {credentials && (
          <div className="space-y-3" data-testid={`${provider}-credentials`}>
            <h3 className="text-sm font-semibold">
              {t(`${i18nPrefix}Credentials`)}
            </h3>
            {!status?.hasOwnCredentials && (
              <IntegrationRedirectGuide
                provider={provider}
                providerLabel={t(i18nPrefix)}
              />
            )}
            <form onSubmit={handleSaveCredentials} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${provider}-clientid`}>
                    {t(`${i18nPrefix}ClientId`)}
                  </Label>
                  <Input
                    id={`${provider}-clientid`}
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    placeholder={
                      status?.hasOwnCredentials
                        ? t(`${i18nPrefix}CredentialsSavedPlaceholder`)
                        : t(`${i18nPrefix}ClientId`)
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
                  <Label htmlFor={`${provider}-secret`}>
                    {t(`${i18nPrefix}ClientSecret`)}
                  </Label>
                  <PasswordInput
                    id={`${provider}-secret`}
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                    placeholder={
                      status?.hasOwnCredentials
                        ? t(`${i18nPrefix}CredentialsSavedPlaceholder`)
                        : t(`${i18nPrefix}ClientSecret`)
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
                  {t(`${i18nPrefix}SaveCredentials`)}
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
        )}

        {serverUnavailable && (
          <p
            className="text-muted-foreground text-xs"
            data-testid={`${provider}-unavailable`}
          >
            {t(`${i18nPrefix}Unavailable`)}
          </p>
        )}

        {status?.connected ? (
          <>
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={handleSync}
                disabled={syncing}
                data-testid={`${provider}-sync`}
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {t(`${i18nPrefix}Sync`)}
              </Button>
              <TestConnectionButton
                endpoint={`/api/${provider}/test`}
                disabled={!status?.connected}
              />
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive min-h-11"
                    data-testid={`${provider}-disconnect`}
                  >
                    <Unlink className="h-3.5 w-3.5" />
                    {t(`${i18nPrefix}Disconnect`)}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t(`${i18nPrefix}DisconnectTitle`)}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t(`${i18nPrefix}DisconnectDescription`)}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t(`${i18nPrefix}Disconnect`)}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {syncMsg && (
              <p
                role="alert"
                data-testid={`${provider}-sync-result`}
                className={`text-sm ${syncMsgType === "success" ? "text-success" : "text-destructive"}`}
              >
                {syncMsg}
              </p>
            )}
            {/* connect→data loop: a discreet link to where this provider's
                readings now surface — doubles as the "your data is richer"
                cue. */}
            <Link
              href={dataHref}
              data-testid={`${provider}-data-link`}
              className="text-primary inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              {t(`${i18nPrefix}ViewData`)}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            className="min-h-11 w-full sm:w-auto"
            disabled={serverUnavailable}
            onClick={handleConnect}
            data-testid={`${provider}-connect`}
          >
            <Link2 className="h-3.5 w-3.5" />
            {t(`${i18nPrefix}Connect`)}
          </Button>
        )}

        {msg && (
          <p role="alert" className="text-destructive text-sm">
            {msg}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}
