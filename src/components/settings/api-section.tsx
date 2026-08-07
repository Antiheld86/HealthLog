"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Key, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useAuth } from "@/hooks/use-auth";
import { formatDate, formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";

interface ApiTokenInfo {
  id: string;
  name: string;
  permissions: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  revoked: boolean;
}

export function ApiSection() {
  // v1.18.6 (W9) — the visible heading + subtitle now come from the shared
  // `<SettingsSectionFrame>` in the route; this body is the API cards.
  return (
    <div className="space-y-6">
      <ApiEndpointsCard />
      <ApiTokensCard />
    </div>
  );
}

function ApiEndpointsCard() {
  const { t } = useTranslations();

  // v1.4.27 MB5 — dual-render: <md gets a stacked card list, md+
  // keeps the original table. Mobile cards wrap inside their box and
  // never trigger horizontal scroll, mirroring the pattern from
  // `<ApiTokenOverviewSection>`. The endpoint catalogue currently
  // ships a single row but stays array-driven so adding new rows
  // remains a one-line edit on both surfaces.
  const endpoints = [
    {
      method: "POST",
      path: "/api/ingest/medication",
      auth: "Authorization: Bearer hlk_...",
      example: `{ "medicationName": "...", "scheduledFor": "..." }`,
    },
  ];

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Key}
        title={t("settings.apiEndpointsTitle")}
        description={t("settings.apiEndpointsDescription")}
      />

      {/* Desktop table — verbatim layout for md+. */}
      <div className="border-border hidden overflow-x-auto rounded-lg border md:block">
        <table className="w-full min-w-[760px] text-xs md:min-w-0">
          <thead>
            <tr className="bg-muted/40 text-muted-foreground border-b">
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointMethod")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointPath")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointAuth")}
              </th>
              <th className="px-3 py-2 text-left font-medium">
                {t("settings.apiEndpointExample")}
              </th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((endpoint) => (
              <tr key={`${endpoint.method} ${endpoint.path}`}>
                <td className="px-3 py-2 font-medium">{endpoint.method}</td>
                <td className="px-3 py-2 font-mono">{endpoint.path}</td>
                <td className="px-3 py-2 font-mono">{endpoint.auth}</td>
                <td className="px-3 py-2 font-mono">{endpoint.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card list — each endpoint stacks its columns vertically
          with a labelled meta row. No horizontal scroll. */}
      <ul
        className="space-y-2 md:hidden"
        data-testid="settings-api-endpoints-mobile-list"
      >
        {endpoints.map((endpoint) => (
          <li
            key={`${endpoint.method} ${endpoint.path}`}
            className="bg-muted/30 border-border space-y-1.5 rounded-lg border p-3 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {endpoint.method}
              </Badge>
              <code className="font-mono break-all">{endpoint.path}</code>
            </div>
            <div>
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                {t("settings.apiEndpointAuth")}
              </p>
              <code className="font-mono break-all">{endpoint.auth}</code>
            </div>
            <div>
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                {t("settings.apiEndpointExample")}
              </p>
              <code className="block font-mono break-all">
                {endpoint.example}
              </code>
            </div>
          </li>
        ))}
      </ul>
    </SettingsCard>
  );
}

function ApiTokensCard() {
  const { t } = useTranslations();
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const [showRevokedTokens, setShowRevokedTokens] = useState(false);

  const { data: tokens } = useQuery({
    queryKey: queryKeys.tokens(),
    queryFn: async () => {
      return apiGet<ApiTokenInfo[]>("/api/tokens");
    },
    enabled: isAuthenticated,
  });

  async function handleRevoke(tokenId: string) {
    try {
      const res = await apiFetchRaw(`/api/tokens/${tokenId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        toast.error(t("settings.tokenRevokeFailed"));
        return;
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.tokens() });
    } catch {
      toast.error(t("settings.tokenRevokeFailed"));
    }
  }

  const activeTokens = (tokens ?? []).filter((tok) => !tok.revoked);
  const revokedTokens = (tokens ?? []).filter((tok) => tok.revoked);
  const latestActiveUse = activeTokens.reduce<string | null>((latest, tok) => {
    if (!tok.lastUsedAt) return latest;
    if (!latest || new Date(tok.lastUsedAt) > new Date(latest)) {
      return tok.lastUsedAt;
    }
    return latest;
  }, null);

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Key}
        title={t("settings.apiTokens")}
        description={t("settings.apiTokensDescription")}
        status={
          <>
            {activeTokens.length > 0 && (
              <Badge className="border-success/30 bg-success/15 text-success">
                {t("settings.configured")}
              </Badge>
            )}
            {latestActiveUse && (
              <Badge variant="outline" className="text-xs">
                {t("settings.tokenTableLastUsed")}:{" "}
                {formatDateTime(latestActiveUse)}
              </Badge>
            )}
          </>
        }
      />

      <div className="space-y-4">
        {/* Tokens are no longer minted here. The generic mint issued a
            `medication:ingest` token that the ingest endpoint refused (it
            gates on the per-medication grant too) and that every other
            authenticated route accepted. The per-medication API-endpoint
            toggle issues the pair that actually works, scoped to one
            medication. This card lists and revokes. */}
        <p className="text-muted-foreground text-sm">
          {t("settings.tokenMintMovedDescription")}
        </p>

        <div>
          <p className="mb-2 text-sm font-medium">
            {t("settings.activeTokensTitle")}
          </p>
          {/* Desktop table — verbatim layout for md+, hidden on phones. */}
          <div className="border-border hidden overflow-x-auto rounded-lg border md:block">
            <table className="w-full min-w-[860px] text-sm md:min-w-0">
              <thead>
                <tr className="bg-muted/40 text-muted-foreground border-b text-xs">
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableName")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTablePermissions")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableStatus")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableCreated")}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t("settings.tokenTableLastUsed")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("settings.tokenTableActions")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {activeTokens.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-muted-foreground px-3 py-4 text-center text-sm"
                    >
                      {t("settings.noActiveTokens")}
                    </td>
                  </tr>
                )}
                {activeTokens.map((tok, index) => {
                  const isExpired =
                    tok.expiresAt && new Date(tok.expiresAt) < new Date();
                  return (
                    <tr
                      key={tok.id}
                      className={index % 2 === 0 ? "bg-muted/20" : ""}
                    >
                      <td className="px-3 py-2 font-medium">{tok.name}</td>
                      <td className="text-muted-foreground px-3 py-2 text-xs">
                        {tok.permissions.join(", ")}
                      </td>
                      <td className="px-3 py-2">
                        {isExpired ? (
                          <Badge variant="destructive" className="text-xs">
                            {t("settings.tokenExpired")}
                          </Badge>
                        ) : (
                          <Badge className="bg-success/15 text-success text-xs">
                            {t("settings.tokenActive")}
                          </Badge>
                        )}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {formatDate(tok.createdAt)}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {tok.lastUsedAt
                          ? formatDateTime(tok.lastUsedAt)
                          : t("settings.tokenNeverUsed")}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive h-9 w-9"
                              aria-label={t("settings.tokenRevokeAction")}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                {t("settings.tokenRevoke")}
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                {t("settings.tokenRevokeDescription")}
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>
                                {t("common.cancel")}
                              </AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                onClick={() => handleRevoke(tok.id)}
                              >
                                {t("settings.tokenRevoked")}
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list — each row stacks its columns vertically
              with explicit labels so the data is readable inside a
              narrow viewport. The revoke action stays full-width to
              clear the 44pt tap-target floor. */}
          {activeTokens.length === 0 ? (
            <EmptyState
              className="md:hidden"
              size="compact"
              data-testid="settings-api-tokens-active-empty"
              title={t("settings.noActiveTokens")}
            />
          ) : (
            <ul
              className="space-y-2 md:hidden"
              data-testid="settings-api-tokens-mobile-list"
            >
              {activeTokens.map((tok) => {
                const isExpired =
                  tok.expiresAt && new Date(tok.expiresAt) < new Date();
                return (
                  <li
                    key={tok.id}
                    className="bg-muted/30 border-border space-y-2 rounded-lg border p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 text-sm font-medium break-all">
                        {tok.name}
                      </p>
                      {isExpired ? (
                        <Badge variant="destructive" className="text-xs">
                          {t("settings.tokenExpired")}
                        </Badge>
                      ) : (
                        <Badge className="bg-success/15 text-success text-xs">
                          {t("settings.tokenActive")}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium">
                        {t("settings.tokenTablePermissions")}:
                      </span>{" "}
                      {tok.permissions.join(", ")}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium">
                        {t("settings.tokenTableCreated")}:
                      </span>{" "}
                      {formatDate(tok.createdAt)}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      <span className="font-medium">
                        {t("settings.tokenTableLastUsed")}:
                      </span>{" "}
                      {tok.lastUsedAt
                        ? formatDateTime(tok.lastUsedAt)
                        : t("settings.tokenNeverUsed")}
                    </p>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive border-destructive/30 min-h-11 w-full"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t("settings.tokenRevoke")}
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>
                            {t("settings.tokenRevoke")}
                          </AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("settings.tokenRevokeDescription")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>
                            {t("common.cancel")}
                          </AlertDialogCancel>
                          <AlertDialogAction
                            variant="destructive"
                            onClick={() => handleRevoke(tok.id)}
                          >
                            {t("settings.tokenRevoked")}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {revokedTokens.length > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowRevokedTokens((prev) => !prev)}
              className="text-foreground hover:text-primary flex items-center gap-1 text-sm font-medium transition-colors"
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${showRevokedTokens ? "rotate-180" : ""}`}
              />
              {t("settings.revokedTokensTitle", {
                count: revokedTokens.length,
              })}
            </button>
            {showRevokedTokens && (
              <>
                {/* Desktop table — verbatim layout for md+. */}
                <div className="border-border hidden overflow-x-auto rounded-lg border md:block">
                  <table className="w-full min-w-[760px] text-sm md:min-w-0">
                    <thead>
                      <tr className="bg-muted/40 text-muted-foreground border-b text-xs">
                        <th className="px-3 py-2 text-left font-medium">
                          {t("settings.tokenTableName")}
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          {t("settings.tokenTablePermissions")}
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          {t("settings.tokenTableCreated")}
                        </th>
                        <th className="px-3 py-2 text-left font-medium">
                          {t("settings.tokenTableLastUsed")}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-border divide-y">
                      {revokedTokens.map((tok, index) => (
                        <tr
                          key={tok.id}
                          className={index % 2 === 0 ? "bg-muted/20" : ""}
                        >
                          <td className="px-3 py-2 font-medium">{tok.name}</td>
                          <td className="text-muted-foreground px-3 py-2 text-xs">
                            {tok.permissions.join(", ")}
                          </td>
                          <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                            {formatDate(tok.createdAt)}
                          </td>
                          <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                            {tok.lastUsedAt
                              ? formatDateTime(tok.lastUsedAt)
                              : t("settings.tokenNeverUsed")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Mobile card list — stacked meta layout, no
                    horizontal scroll. Revoked tokens are read-only so
                    no action footer is needed. */}
                <ul
                  className="space-y-2 md:hidden"
                  data-testid="settings-api-tokens-revoked-mobile-list"
                >
                  {revokedTokens.map((tok) => (
                    <li
                      key={tok.id}
                      className="bg-muted/30 border-border space-y-1.5 rounded-lg border p-3"
                    >
                      <p className="text-sm font-medium break-all">
                        {tok.name}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        <span className="font-medium">
                          {t("settings.tokenTablePermissions")}:
                        </span>{" "}
                        {tok.permissions.join(", ")}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        <span className="font-medium">
                          {t("settings.tokenTableCreated")}:
                        </span>{" "}
                        {formatDate(tok.createdAt)}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        <span className="font-medium">
                          {t("settings.tokenTableLastUsed")}:
                        </span>{" "}
                        {tok.lastUsedAt
                          ? formatDateTime(tok.lastUsedAt)
                          : t("settings.tokenNeverUsed")}
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
