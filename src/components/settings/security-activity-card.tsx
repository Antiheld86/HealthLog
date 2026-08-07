"use client";

/**
 * v1.23 — Settings → account → "Security activity".
 *
 * A read-only feed of the user's recent account-security events (sign-ins, MFA
 * changes, password changes, session revocations, exports, deletions) from the
 * shared `GET /api/auth/me/security-activity` endpoint. Each row shows a
 * readable action label, the resolved location, the masked IP, and the time.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Loader2, ShieldCheck } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { EmptyState } from "@/components/ui/empty-state";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { cn } from "@/lib/utils";

interface ActivityRow {
  action: string;
  createdAt: string;
  location: string | null;
  ipMasked: string | null;
  carrier: string | null;
}

/** Map an audit action onto a stable, translatable label key. */
function actionLabelKey(action: string): string {
  if (action === "auth.login.new_device")
    return "settings.security.action.newDevice";
  if (action === "auth.login.failed")
    return "settings.security.action.loginFailed";
  if (action.startsWith("auth.login") || action === "auth.register")
    return "settings.security.action.login";
  if (action.startsWith("auth.password"))
    return "settings.security.action.passwordChange";
  if (action.startsWith("auth.mfa")) return "settings.security.action.mfa";
  if (action.startsWith("auth.session"))
    return "settings.security.action.sessionRevoke";
  if (action.startsWith("auth.token") || action.startsWith("auth.bearer"))
    return "settings.security.action.token";
  if (action === "user.account.delete")
    return "settings.security.action.accountDelete";
  if (action === "user.data.clear") return "settings.security.action.dataClear";
  if (action.includes("export")) return "settings.security.action.export";
  return "settings.security.action.other";
}

export function SecurityActivityCard({
  isAuthenticated,
}: {
  isAuthenticated: boolean;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  // Collapsed by default — the feed opens only on demand, keeping the security
  // surface skimmable. UI-only state; nothing is persisted across reloads.
  const [open, setOpen] = useState(false);
  const regionId = useId();

  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.securityActivity(),
    queryFn: () =>
      apiGet<{ events: ActivityRow[] }>("/api/auth/me/security-activity"),
    enabled: isAuthenticated,
  });

  const events = data?.events ?? [];

  return (
    <SettingsCard data-slot="settings-security-activity-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        data-slot="settings-security-activity-toggle"
        className="hover:bg-muted/40 focus-visible:ring-ring/50 -m-2 mb-2 flex w-full items-start gap-2 rounded-md p-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <ShieldCheck
          className="text-muted-foreground mt-0.5 h-5 w-5 shrink-0"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">
            {t("settings.security.activityTitle")}
          </h2>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
              open && "rotate-180",
            )}
          />
        </div>
      </button>
      <div id={regionId} hidden={!open} className="space-y-4">
        <p className="text-muted-foreground text-xs">
          {t("settings.security.activityDescription")}
        </p>

        {isLoading && (
          <Loader2 className="text-muted-foreground h-5 w-5 animate-spin motion-reduce:animate-none" />
        )}

        {isError && (
          <p role="alert" className="text-destructive text-sm">
            {t("settings.security.activityLoadError")}
          </p>
        )}

        {!isLoading && !isError && events.length === 0 && (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("settings.security.activityEmpty")}
          />
        )}

        {events.length > 0 && (
          <ul className="divide-border divide-y">
            {events.map((e, idx) => (
              <li
                key={`${e.action}-${e.createdAt}-${idx}`}
                className="flex items-center justify-between gap-3 py-2"
                data-slot="security-activity-row"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="truncate text-sm font-medium">
                    {t(actionLabelKey(e.action))}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {[
                      e.location ?? t("settings.security.unknownLocation"),
                      e.ipMasked,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <p className="text-muted-foreground shrink-0 text-xs">
                  {fmt.dateTime(e.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  );
}
