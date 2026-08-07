"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Loader2,
  Pencil,
  Trash2,
  Usb,
  X,
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
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { ApiError, apiDelete, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { describePasskeyError } from "@/lib/passkey-errors";
import { formatDate } from "@/lib/format";

export interface WebauthnKeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function describeStepUp(
  err: unknown,
  fallback: string,
  stepUpMsg: string,
): string {
  if (err instanceof ApiError) {
    const code = err.meta?.errorCode;
    if (
      err.status === 401 &&
      typeof code === "string" &&
      code.startsWith("auth.stepup")
    ) {
      return stepUpMsg;
    }
    return err.message || fallback;
  }
  return fallback;
}

export function SecurityKeysCard({ keys }: { keys: WebauthnKeyInfo[] }) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const add = useMutation({
    mutationFn: async () => {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options, challengeId } = await apiPost<{
        options: Parameters<typeof startRegistration>[0]["optionsJSON"];
        challengeId: string;
      }>("/api/auth/me/mfa/webauthn/register/options");
      const credential = await startRegistration({ optionsJSON: options });
      await apiPost("/api/auth/me/mfa/webauthn/register/verify", {
        challengeId,
        credential,
      });
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message || t("settings.security.keys.addFailed"));
      } else {
        const { key, params } = describePasskeyError(err);
        setError(t(key, params));
      }
    },
  });

  const rename = useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) => {
      await apiPatch(`/api/auth/me/mfa/webauthn/${id}`, { name });
    },
    onSuccess: () => {
      setEditingId(null);
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? err.message
          : t("settings.security.keys.renameFailed"),
      ),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiDelete(`/api/auth/me/mfa/webauthn/${id}`);
    },
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.mfaStatus() });
    },
    onError: (err) =>
      setError(
        describeStepUp(
          err,
          t("settings.security.keys.removeFailed"),
          t("settings.security.stepUpRequired"),
        ),
      ),
  });

  return (
    <SettingsCard>
      <SettingsCardHeader
        icon={Usb}
        title={t("settings.security.keys.title")}
        description={t("settings.security.keys.description")}
      />

      <div>
        {keys.length === 0 ? (
          <EmptyState
            variant="plain"
            size="compact"
            title={t("settings.security.keys.empty")}
          />
        ) : (
          <ul className="space-y-2" data-testid="security-keys-list">
            {keys.map((key) => (
              <SettingsCard as="li" key={key.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {editingId === key.id ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          rename.mutate({ id: key.id, name: editName.trim() });
                        }}
                      >
                        <Input
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          maxLength={64}
                          aria-label={t("settings.security.keys.nameLabel")}
                          autoFocus
                        />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11 shrink-0 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                          disabled={
                            rename.isPending || editName.trim().length === 0
                          }
                          aria-label={t("common.save")}
                        >
                          {rename.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                          ) : (
                            <Check className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="min-h-11 min-w-11 shrink-0 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                          onClick={() => setEditingId(null)}
                          aria-label={t("common.cancel")}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </form>
                    ) : (
                      <>
                        <p className="truncate text-sm font-medium">
                          {key.name}
                        </p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {key.lastUsedAt
                            ? t("settings.security.keys.lastUsed", {
                                date: formatDate(key.lastUsedAt),
                              })
                            : t("settings.security.keys.neverUsed")}
                          {" · "}
                          {t("settings.security.keys.added", {
                            date: formatDate(key.createdAt),
                          })}
                        </p>
                      </>
                    )}
                  </div>

                  {editingId !== key.id && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="min-h-11 min-w-11 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                        onClick={() => {
                          setEditingId(key.id);
                          setEditName(key.name);
                        }}
                        aria-label={t("settings.security.keys.rename")}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-destructive min-h-11 min-w-11 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
                            disabled={remove.isPending}
                            aria-label={t("settings.security.keys.remove")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>
                              {t("settings.security.keys.remove")}
                            </AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("settings.security.keys.removeConfirm")}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>
                              {t("common.cancel")}
                            </AlertDialogCancel>
                            <AlertDialogAction
                              variant="destructive"
                              disabled={remove.isPending}
                              aria-busy={remove.isPending || undefined}
                              onClick={() => remove.mutate(key.id)}
                            >
                              {remove.isPending && (
                                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                              )}
                              {t("common.delete")}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  )}
                </div>
              </SettingsCard>
            ))}
          </ul>
        )}

        <div className="mt-4">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={() => add.mutate()}
            disabled={add.isPending}
          >
            {add.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Usb className="h-4 w-4" />
            )}
            {t("settings.security.keys.add")}
          </Button>
        </div>

        {error && (
          <div
            role="alert"
            className="text-destructive mt-3 flex items-center gap-2 text-sm"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}
