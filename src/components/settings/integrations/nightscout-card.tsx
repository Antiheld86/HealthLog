"use client";

// v1.17.0 — Nightscout CGM integration card. Unlike WHOOP / Fitbit (OAuth,
// BYO-key), Nightscout is a URL + token the self-hoster pastes once: the user
// runs their own instance and HealthLog pulls continuous glucose off it. The
// card reads the consolidated `/api/integrations/status` envelope like every
// sibling — it was the last card firing its own status round-trip, and the
// last place a fourth status dialect could hide. Warm copy, mobile-first, the
// private-network opt-in toggle maps to `nightscoutAllowPrivateHost`.

import { useRef, useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  Droplet,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { TagChip } from "@/components/ui/tag-chip";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { IntegrationStatusPill } from "@/components/settings/integration-status-pill";
import { TestConnectionButton } from "@/components/settings/test-connection-button";
import { apiFetchRaw, apiPost } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import {
  invalidateKeys,
  measurementDependentKeys,
  queryKeys,
} from "@/lib/query-keys";

import { MetricFreshnessDisclosure } from "./metric-freshness-disclosure";
import {
  IntegrationErrorMessage,
  pillStateForVerdict,
  pillTimestampFor,
  type IntegrationStatusViewModel,
} from "./shared";
import { IntegrationCardDescription } from "./setup-guide-link";

export function NightscoutCard({
  viewModel,
}: {
  viewModel?: IntegrationStatusViewModel;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [allowPrivateHost, setAllowPrivateHost] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [syncMsgType, setSyncMsgType] = useState<"success" | "error" | null>(
    null,
  );

  const status = viewModel;

  const formRef = useRef<HTMLFormElement | null>(null);

  const disconnect = useMutation({
    mutationFn: async () => {
      await apiPost("/api/nightscout/disconnect");
    },
    onSuccess: () => {
      setUrl("");
      setToken("");
      setAllowPrivateHost(false);
      // The card reads the consolidated envelope, so that is the one key a
      // disconnect has to invalidate for the pill to flip back.
      queryClient.invalidateQueries({
        queryKey: queryKeys.integrationsStatus(),
      });
    },
  });

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await apiFetchRaw("/api/nightscout/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          token: token.trim(),
          allowPrivateHost,
        }),
      });
      if (res.ok) {
        setMsg(t("settings.nightscoutConnected"));
        setMsgType("success");
        setToken("");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        let detail = t("settings.nightscoutConnectFailed");
        try {
          const json = await res.json();
          if (json.error) detail = json.error;
        } catch {
          // keep the generic message
        }
        setMsg(detail);
        setMsgType("error");
      }
    } catch {
      setMsg(t("common.networkError"));
      setMsgType("error");
    }
    setSaving(false);
  }

  // Sync now. Same shape as the WHOOP card's incremental arm, minus the
  // full-history dialog — Nightscout has no full-sync arm to call.
  async function handleSync() {
    setSyncing(true);
    setSyncMsg(null);
    setSyncMsgType(null);
    try {
      const res = await apiFetchRaw("/api/nightscout/sync", { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        setSyncMsg(
          t("settings.nightscoutSyncResult", { count: json.data.imported }),
        );
        setSyncMsgType("success");
        void invalidateKeys(queryClient, measurementDependentKeys);
        queryClient.invalidateQueries({
          queryKey: queryKeys.integrationsStatus(),
        });
      } else {
        setSyncMsg(json.error || t("settings.nightscoutSyncFailed"));
        setSyncMsgType("error");
      }
    } catch {
      setSyncMsg(t("settings.nightscoutSyncFailed"));
      setSyncMsgType("error");
    } finally {
      setSyncing(false);
    }
  }

  const pillState = pillStateForVerdict(status?.syncHealth?.verdict);
  // `warning` joins the set now that a transient failure paints amber rather
  // than red — the detail belongs on this line, not in a colour that tells the
  // user to reconnect against something reconnecting cannot fix.
  const errorMessage =
    (pillState === "error" ||
      pillState === "parked" ||
      pillState === "warning") &&
    status?.lastError
      ? status.lastError
      : null;

  return (
    <SettingsCard data-testid="nightscout-card">
      <SettingsCardHeader
        icon={Droplet}
        title={t("settings.nightscout")}
        titleAccessory={<TagChip>{t("settings.nightscoutTag")}</TagChip>}
        description={
          <IntegrationCardDescription
            i18nPrefix="settings.nightscout"
            provider="nightscout"
          />
        }
        status={
          <IntegrationStatusPill
            state={pillState}
            lastSyncAt={pillTimestampFor(status)}
          />
        }
      />

      <hr
        data-testid="integration-card-divider"
        className="border-border/60 mt-4"
      />

      <div className="mt-4 space-y-4 pl-7">
        {errorMessage && <IntegrationErrorMessage message={errorMessage} />}

        {/* Parked-integration resume CTA. Surfaces only when the row state
            is `parked` (>24h of persistent failures). Nightscout has no OAuth
            redirect — the user re-validates by re-submitting the connect form,
            so "reconnect" scrolls the form into view + focuses the URL field.
            Markup matches the WHOOP card byte for byte. */}
        {pillState === "parked" && (
          <div
            data-testid="nightscout-parked-banner"
            className="border-warning/30 bg-warning/10 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
          >
            <span className="text-warning min-w-0 text-xs break-words">
              {t("settings.integrationPill.parkedReconnect")}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                formRef.current?.scrollIntoView({
                  behavior: "smooth",
                  block: "center",
                });
                formRef.current
                  ?.querySelector<HTMLInputElement>("#nightscout-url")
                  ?.focus();
              }}
              data-testid="nightscout-resume-button"
              className="min-h-11"
            >
              <Link2 className="h-3.5 w-3.5" />
              {t("settings.integrationPill.resumeCta")}
            </Button>
          </div>
        )}

        {status?.connected && (
          <MetricFreshnessDisclosure
            entries={status.metricFreshness}
            idPrefix="nightscout"
          />
        )}

        <form ref={formRef} onSubmit={handleConnect} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="nightscout-url">
              {t("settings.nightscoutUrl")}
            </Label>
            <Input
              id="nightscout-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={
                status?.configured
                  ? t("settings.nightscoutUrlSavedPlaceholder")
                  : "https://your-site.up.railway.app"
              }
              maxLength={2048}
              autoComplete="off"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="none"
              enterKeyHint="next"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nightscout-token">
              {t("settings.nightscoutToken")}
            </Label>
            <PasswordInput
              id="nightscout-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={
                status?.hasToken
                  ? t("settings.nightscoutTokenSavedPlaceholder")
                  : t("settings.nightscoutTokenOptional")
              }
              maxLength={512}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="none"
              enterKeyHint="done"
            />
            <p className="text-muted-foreground text-xs">
              {t("settings.nightscoutTokenHelp")}
            </p>
          </div>

          <div className="border-border/60 flex items-start justify-between gap-3 rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="nightscout-private" className="text-sm">
                {t("settings.nightscoutPrivateHost")}
              </Label>
              <p className="text-muted-foreground text-xs">
                {t("settings.nightscoutPrivateHostHelp")}
              </p>
            </div>
            <Switch
              id="nightscout-private"
              checked={allowPrivateHost}
              onCheckedChange={setAllowPrivateHost}
            />
          </div>

          <div className="flex justify-end">
            <Button
              type="submit"
              variant="outline"
              size="sm"
              className="min-h-11 w-full sm:w-auto"
              disabled={saving || !url.trim()}
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : status?.connected ? (
                <Save className="h-3.5 w-3.5" />
              ) : (
                <Link2 className="h-3.5 w-3.5" />
              )}
              {status?.connected
                ? t("settings.nightscoutUpdate")
                : t("settings.nightscoutConnect")}
            </Button>
          </div>

          {msg && (
            <p
              role="alert"
              className={`text-sm ${msgType === "success" ? "text-success" : "text-destructive"}`}
            >
              {msg}
            </p>
          )}
        </form>

        {status?.connected && (
          <>
            <div className="flex flex-wrap items-start gap-2 [&>*]:min-w-[10rem] sm:[&>*]:min-w-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={handleSync}
                disabled={syncing}
                data-testid="nightscout-sync"
              >
                {syncing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {t("settings.nightscoutSync")}
              </Button>
              <TestConnectionButton
                endpoint="/api/nightscout/test"
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
                    {t("settings.nightscoutDisconnect")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("settings.nightscoutDisconnectTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("settings.nightscoutDisconnectDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      onClick={() => disconnect.mutate()}
                    >
                      {t("settings.nightscoutDisconnect")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
            {syncMsg && (
              <p
                role="alert"
                data-testid="nightscout-sync-result"
                className={`text-sm ${syncMsgType === "success" ? "text-success" : "text-destructive"}`}
              >
                {syncMsg}
              </p>
            )}
            {/* connect→data loop: a discreet link to where the glucose
                readings now surface — doubles as the "your data is richer"
                cue. */}
            <Link
              href="/insights/blood-glucose"
              data-testid="nightscout-data-link"
              className="text-primary inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
            >
              {t("settings.nightscoutViewData")}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </>
        )}
      </div>
    </SettingsCard>
  );
}
