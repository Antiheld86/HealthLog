"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BookOpenCheck, Loader2, Trash2 } from "lucide-react";

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
import { SettingsInfoTile } from "@/components/settings/_info-tile";
import { SettingsCardActions } from "@/components/settings/_card-actions";
import { Switch } from "@/components/ui/switch";
import { ResearchModeAcknowledgmentDialog } from "@/components/medications/research-mode-acknowledgment-dialog";
import { formatDateTime } from "@/lib/format";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  type ResearchModeStatus,
  researchModeGateState,
} from "@/lib/medications/research-mode-types";
import { apiFetchRaw } from "@/lib/api/api-fetch";

/**
 * Settings → Advanced.
 *
 * v1.4.16 phase B7: every export path (CSV, JSON, doctor-report PDF)
 * moved out into the dedicated `<ExportSection>` under `/settings/export`.
 * What stays here is the irreversible danger-zone — the "wipe all my
 * data" surface that should never live next to a single-click export
 * button.
 *
 * v1.4.25 W19c-Frontend adds the Research Mode toggle on this page.
 * Research Mode and the data-reset are both opt-in / version-gated
 * controls; they share a semantic shelf even though they touch
 * different parts of the user record. Toggle ON opens the
 * acknowledgment dialog (the user reads + confirms before the server
 * stamps the version). Toggle OFF fires DELETE directly. A separate
 * amber banner above the toggle catches the version-mismatch case
 * (server bumped the disclaimer while the user was still
 * acknowledged) and surfaces a Re-acknowledge CTA that re-opens the
 * dialog.
 */
export function AdvancedSection() {
  // v1.18.6 (W9) — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` in the route; this body is the advanced cards.
  // v1.18.6.1 — the guided tour replay card was removed: the tour now exists
  // only as the first-time auto-start after onboarding. This page is the
  // research-mode + data/account destructive controls.
  return (
    <div className="space-y-6">
      <ResearchModeCard />
      <DataResetCard />
      <AccountDeleteCard />
    </div>
  );
}

/**
 * v1.4.25 W21 Fix-N (simp-H3) — pull the nested ternary that decided
 * the toggle's caption out of the JSX. The four-way ladder (loading /
 * enabled-open / enabled-stale / disabled) is dense to read inline,
 * and the surface stays open to a fifth state ("never queried") when
 * we wire the offline shell in v1.4.26.
 */
function researchModeStatusLabel(
  status: ResearchModeStatus | null | undefined,
  isLoading: boolean,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  if (isLoading) return t("common.loading");
  const gate = researchModeGateState(status);
  if (gate === "off") return t("settings.researchMode.disabledStatus");
  if (gate === "stale") return t("settings.researchMode.enabledStaleStatus");
  return t("settings.researchMode.acknowledgedOn", {
    date: status?.acknowledgedAt ? formatDateTime(status.acknowledgedAt) : "—",
  });
}

function ResearchModeCard() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const { data: status, isLoading } = useQuery<ResearchModeStatus | null>({
    queryKey: queryKeys.researchMode(),
    queryFn: async () => {
      const res = await apiFetchRaw("/api/auth/me/research-mode");
      if (!res.ok) return null;
      const json = await res.json();
      return json.data as ResearchModeStatus;
    },
    staleTime: 60 * 1000,
  });

  const gateState = researchModeGateState(status);
  const showRePrompt = gateState === "stale";
  // The Switch's `checked` mirrors the server flag exactly — even when
  // the version is stale we keep the toggle "on" so the user sees that
  // their previous choice is preserved; the banner above the toggle
  // explains why the chart isn't painting.
  const switchChecked = !!status?.enabled;

  async function handleToggle(next: boolean) {
    if (toggleBusy) return;
    setErrorMessage(null);
    if (next) {
      // Toggle ON → open the acknowledgment dialog. The dialog owns
      // the POST; on success it invalidates the `research-mode` query
      // and the toggle reflects the new state.
      setDialogOpen(true);
      return;
    }
    // Toggle OFF → fire DELETE directly.
    setToggleBusy(true);
    try {
      const res = await apiFetchRaw("/api/auth/me/research-mode", {
        method: "DELETE",
      });
      if (!res.ok) {
        setErrorMessage(t("settings.researchMode.disableError"));
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.researchMode() });
    } catch {
      setErrorMessage(t("settings.researchMode.disableError"));
    } finally {
      setToggleBusy(false);
    }
  }

  return (
    <SettingsCard data-slot="settings-research-mode-card">
      <SettingsCardHeader
        icon={BookOpenCheck}
        title={t("settings.researchMode.sectionTitle")}
        description={t("settings.researchMode.subtitle")}
      />

      {showRePrompt && (
        <SettingsInfoTile
          icon={AlertTriangle}
          tone="warning"
          role="alert"
          data-slot="settings-research-mode-reprompt"
          title={t("settings.researchMode.rePromptTitle")}
        >
          <p>{t("settings.researchMode.rePromptBody")}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2 min-h-11 sm:min-h-9"
            onClick={() => setDialogOpen(true)}
            data-slot="settings-research-mode-reprompt-cta"
          >
            {t("settings.researchMode.rePromptCta")}
          </Button>
        </SettingsInfoTile>
      )}

      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            {t("settings.researchMode.toggleLabel")}
          </p>
          <p
            className="text-muted-foreground text-xs"
            data-slot="settings-research-mode-status"
          >
            {researchModeStatusLabel(status, isLoading, t)}
          </p>
        </div>
        <Switch
          checked={switchChecked}
          disabled={isLoading || toggleBusy}
          onCheckedChange={(next) => {
            void handleToggle(next);
          }}
          aria-label={t("settings.researchMode.toggleLabel")}
          data-slot="settings-research-mode-toggle"
        />
      </div>

      {errorMessage && (
        <p
          role="alert"
          className="text-destructive text-sm"
          data-slot="settings-research-mode-error"
        >
          {errorMessage}
        </p>
      )}

      <ResearchModeAcknowledgmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        currentDisclaimerVersion={status?.currentDisclaimerVersion ?? null}
      />
    </SettingsCard>
  );
}

function DataResetCard() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  async function handleDeleteAllData() {
    if (deleting) return;
    setDeleting(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await apiFetchRaw("/api/settings/data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.error || t("settings.dangerZoneDeleteFailed"));
        setMsgType("error");
        return;
      }

      await queryClient.invalidateQueries();
      setMsg(t("settings.dangerZoneSuccess"));
      setMsgType("success");
      setConfirmOpen(false);
    } catch {
      setMsg(t("settings.dangerZoneDeleteFailed"));
      setMsgType("error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <SettingsCard data-slot="settings-data-reset-card">
      {/* v1.4.43 QoL (L5) — dropped the `AlertTriangle` icon and
          neutralised the title colour so the danger-zone shaping is
          GitHub-style (red CTA only) rather than red-on-red-on-red.
          The protective gate (confirmation dialog) is unchanged; this
          is purely a visual-tone fix per the v1.4.43 audit. */}
      <SettingsCardHeader
        icon={Trash2}
        title={t("settings.dangerZone")}
        description={t("settings.dangerZoneDescription")}
      />

      {msg && (
        <p
          role="alert"
          className={`mt-3 text-sm ${msgType === "success" ? "text-success" : "text-destructive"}`}
        >
          {msg}
        </p>
      )}
      <SettingsCardActions>
        <AlertDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            // Hold the dialog open while the destructive mutation is in
            // flight so the in-dialog pending state stays visible and a
            // stray backdrop tap can't dismiss it mid-request.
            if (deleting) return;
            setConfirmOpen(open);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              className="min-h-11 w-full shrink-0 sm:min-h-9 sm:w-auto"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t("settings.dangerZone")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.dangerZoneConfirm")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.dangerZoneConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(e) => {
                  e.preventDefault();
                  void handleDeleteAllData();
                }}
                disabled={deleting}
                aria-busy={deleting || undefined}
                data-slot="settings-data-reset-confirm"
              >
                {deleting && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("settings.finalDelete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingsCardActions>
    </SettingsCard>
  );
}

/**
 * v1.4.43 QoL (M3) — separate destructive action for the full account
 * delete. Pre-fix, the only "danger zone" CTA wiped the user's health
 * data but left the user row, passkeys, audit log, and sessions
 * intact — half of what a user reading "Danger Zone" expects per
 * GDPR Article 17. The route `DELETE /api/settings/account` already
 * cascades User + passkeys + audit log + sessions (and is rate-limited
 * by the API handler); this card is its UI front door.
 *
 * Visually the card mirrors the data-reset shaping (neutral title,
 * red CTA only) but the dialog copy is explicit: this deletes the
 * account, not just the data, and the user will be signed out
 * immediately.
 */
function AccountDeleteCard() {
  const { t } = useTranslations();
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgType, setMsgType] = useState<"success" | "error" | null>(null);

  async function handleDeleteAccount() {
    if (deleting) return;
    setDeleting(true);
    setMsg(null);
    setMsgType(null);
    try {
      const res = await apiFetchRaw("/api/settings/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE_ACCOUNT" }),
      });
      if (!res.ok) {
        try {
          const json = await res.json();
          setMsg(json.error || t("settings.deleteAccountFailed"));
        } catch {
          setMsg(t("settings.deleteAccountFailed"));
        }
        setMsgType("error");
        setDeleting(false);
        return;
      }
      setMsg(t("settings.deleteAccountSuccess"));
      setMsgType("success");
      // The route destroyed every session before deleting the row;
      // give the toast a beat to paint, then bounce to the login page.
      // Leave `deleting` set so the confirm button keeps its pending
      // state through the redirect — the row is gone, nothing to undo.
      setTimeout(() => {
        window.location.href = "/auth/login";
      }, 1_500);
    } catch {
      setMsg(t("settings.deleteAccountFailed"));
      setMsgType("error");
      setDeleting(false);
    }
  }

  return (
    <SettingsCard data-slot="settings-account-delete-card">
      <SettingsCardHeader
        icon={Trash2}
        title={t("settings.deleteAccountCardTitle")}
        description={t("settings.deleteAccountCardDescription")}
      />

      {msg && (
        <p
          role="alert"
          className={`mt-3 text-sm ${msgType === "success" ? "text-success" : "text-destructive"}`}
        >
          {msg}
        </p>
      )}
      <SettingsCardActions>
        <AlertDialog
          open={confirmOpen}
          onOpenChange={(open) => {
            // Hold the dialog open while the irreversible delete runs so
            // the pending state stays on screen and a stray dismissal
            // can't fire a second request.
            if (deleting) return;
            setConfirmOpen(open);
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              className="min-h-11 w-full shrink-0 sm:min-h-9 sm:w-auto"
              data-slot="settings-account-delete-trigger"
            >
              {deleting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Trash2 className="h-3.5 w-3.5" />
              )}
              {t("settings.deleteAccountCta")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.deleteAccountConfirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.deleteAccountConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={(e) => {
                  e.preventDefault();
                  void handleDeleteAccount();
                }}
                disabled={deleting}
                aria-busy={deleting || undefined}
                data-slot="settings-account-delete-confirm"
              >
                {deleting && (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                )}
                {t("settings.deleteAccountFinal")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SettingsCardActions>
    </SettingsCard>
  );
}
