"use client";

/**
 * `<EncryptionSection>` — admin view of encryption coverage + key-rotation
 * status, with a guarded rotation trigger.
 *
 * Reads `GET /api/admin/encryption/status` (per-column rows-per-key-id, legacy
 * counts, overall rotation progress). NEVER surfaces key material — only key
 * ids (operator labels) and row counts. The rotation trigger POSTs to
 * `/api/admin/encryption/rotate`, which is step-up gated server-side; a 401
 * here means the admin needs a fresh second factor (or has none enrolled, in
 * which case the documented CLI is the path).
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, RotateCw, ShieldCheck } from "lucide-react";
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
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { apiFetchRaw, apiGet } from "@/lib/api/api-fetch";
import { getApiErrorMessage } from "./_shared";

interface ColumnScan {
  model: string;
  field: string;
  kind: "string" | "bytes";
  total: number;
  byKeyId: Record<string, number>;
  legacy: number;
}

interface EncryptionStatus {
  activeKeyId: string;
  configuredKeyCount: number;
  rotationComplete: boolean;
  totalRows: number;
  activeRows: number;
  staleRows: number;
  columns: ColumnScan[];
  rotation: {
    state: "idle" | "running" | "completed" | "failed";
    lastRequestedAt: string | null;
    lastCompletedAt: string | null;
    lastResult: { scanned: number; rotated: number; errors: number } | null;
  };
}

export function EncryptionSection() {
  const { t } = useTranslations();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: queryKeys.adminEncryptionStatus(),
    queryFn: async (): Promise<EncryptionStatus> => {
      return apiGet<EncryptionStatus>("/api/admin/encryption/status", {
        credentials: "include",
      });
    },
    staleTime: 15_000,
  });

  const rotate = useMutation({
    mutationFn: async () => {
      const res = await apiFetchRaw("/api/admin/encryption/rotate", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        if (res.status === 401) {
          throw new Error(t("admin.section.encryption.stepUpNeeded"));
        }
        throw new Error(await getApiErrorMessage(res));
      }
      return res.json();
    },
    onSuccess: () => {
      toast.success(t("admin.section.encryption.rotateEnqueued"));
      queryClient.invalidateQueries({
        queryKey: queryKeys.adminEncryptionStatus(),
      });
    },
    onError: (err: Error) => {
      toast.error(err.message || t("admin.section.encryption.rotateFailed"));
    },
  });

  if (statusQuery.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
        {t("admin.section.encryption.loading")}
      </div>
    );
  }

  if (statusQuery.isError || !statusQuery.data) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t("admin.section.encryption.loadError")}
      </p>
    );
  }

  const s = statusQuery.data;
  const running = s.rotation.state === "running" || rotate.isPending;
  // Only the rows that share a coverage view need the per-column table; sort
  // stale-first so an operator sees what still needs rotating.
  const columns = [...s.columns].sort((a, b) => b.legacy - a.legacy);

  return (
    <div className="space-y-6">
      {/* ── Coverage summary ───────────────────────────────────────── */}
      <SettingsCard>
        <SettingsCardHeader
          icon={ShieldCheck}
          title={t("admin.section.encryption.coverageTitle")}
          description={t("admin.section.encryption.coverageDescription")}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Stat
            label={t("admin.section.encryption.activeKeyId")}
            value={s.activeKeyId}
          />
          <Stat
            label={t("admin.section.encryption.configuredKeys")}
            value={String(s.configuredKeyCount)}
          />
          <Stat
            label={t("admin.section.encryption.totalRows")}
            value={s.totalRows.toLocaleString()}
          />
          <Stat
            label={t("admin.section.encryption.staleRows")}
            value={s.staleRows.toLocaleString()}
          />
        </div>
        {s.rotationComplete ? (
          <Badge className="border-success/40 bg-success/15 text-success">
            {t("admin.section.encryption.safeToDropLegacy")}
          </Badge>
        ) : (
          <Badge variant="secondary">
            {t("admin.section.encryption.rotationIncomplete", {
              count: s.staleRows,
            })}
          </Badge>
        )}
      </SettingsCard>

      {/* ── Rotation status + trigger ──────────────────────────────── */}
      <SettingsCard>
        <SettingsCardHeader
          icon={KeyRound}
          title={t("admin.section.encryption.rotationTitle")}
          description={t("admin.section.encryption.rotationDescription")}
        />
        <div className="text-muted-foreground space-y-1 text-sm">
          <p>
            {t("admin.section.encryption.rotationState")}:{" "}
            <span className="text-foreground font-medium">
              {t(`admin.section.encryption.state.${s.rotation.state}`)}
            </span>
          </p>
          {s.rotation.lastResult && (
            <p>
              {t("admin.section.encryption.lastRun", {
                scanned: s.rotation.lastResult.scanned,
                rotated: s.rotation.lastResult.rotated,
                errors: s.rotation.lastResult.errors,
              })}
            </p>
          )}
        </div>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              disabled={running}
              data-testid="admin-encryption-rotate"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <RotateCw className="h-3.5 w-3.5" />
              )}
              {t("admin.section.encryption.rotateNow")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("admin.section.encryption.rotateConfirmTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("admin.section.encryption.rotateConfirmDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("admin.section.encryption.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction onClick={() => rotate.mutate()}>
                {t("admin.section.encryption.rotateConfirm")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <p className="text-muted-foreground text-xs">
          {t("admin.section.encryption.cliNote")}
        </p>
      </SettingsCard>

      {/* ── Per-column coverage table ──────────────────────────────── */}
      <SettingsCard>
        <SettingsCardHeader
          icon={ShieldCheck}
          title={t("admin.section.encryption.columnsTitle")}
          description={t("admin.section.encryption.columnsDescription")}
        />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left">
                <th className="py-2 pr-3 font-medium">
                  {t("admin.section.encryption.colColumn")}
                </th>
                <th className="py-2 pr-3 font-medium">
                  {t("admin.section.encryption.colTotal")}
                </th>
                <th className="py-2 pr-3 font-medium">
                  {t("admin.section.encryption.colActive")}
                </th>
                <th className="py-2 font-medium">
                  {t("admin.section.encryption.colStale")}
                </th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c) => {
                const active = c.byKeyId[s.activeKeyId] ?? 0;
                const stale = c.total - active;
                return (
                  <tr key={`${c.model}.${c.field}`} className="border-b">
                    <td className="py-2 pr-3 font-mono text-xs">
                      {c.model}.{c.field}
                    </td>
                    <td className="py-2 pr-3">{c.total.toLocaleString()}</td>
                    <td className="py-2 pr-3">{active.toLocaleString()}</td>
                    <td className="py-2">
                      {stale > 0 ? (
                        <Badge variant="secondary">
                          {stale.toLocaleString()}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SettingsCard>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/40 rounded-lg px-3 py-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="text-foreground font-mono text-sm font-medium">{value}</p>
    </div>
  );
}
