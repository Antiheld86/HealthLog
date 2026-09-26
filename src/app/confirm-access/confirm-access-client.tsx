"use client";

import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  recentProofErrorMessage,
  useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { apiGet } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";

export function ConfirmAccessClient({ returnTo }: { returnTo: string | null }) {
  const { t } = useTranslations();
  const recentProof = useRecentProof();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!returnTo) return;
    setBusy(true);
    setError(null);
    try {
      // Answers 200 when the session's proof is recent, and otherwise the
      // refusal the hook turns into the re-proof dialog.
      await recentProof.run(() => apiGet("/api/auth/reproof"));
      // A full navigation: the consent is a server page, not an app route.
      window.location.assign(returnTo);
    } catch (err) {
      setError(recentProofErrorMessage(err, t("auth.confirmAccess.failed")));
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-4 px-4 py-10">
      <div className="text-foreground inline-flex items-center gap-2 text-lg font-semibold">
        <ShieldCheck className="h-5 w-5" aria-hidden="true" />
        {t("auth.confirmAccess.title")}
      </div>
      {returnTo ? (
        <>
          <p className="text-sm">{t("auth.confirmAccess.body")}</p>
          <div>
            <Button
              onClick={() => void confirm()}
              disabled={busy}
              className="min-h-11 sm:min-h-9"
            >
              {busy && (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              )}
              {t("auth.confirmAccess.action")}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm">{t("auth.confirmAccess.nothingToConfirm")}</p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {recentProof.dialog}
    </div>
  );
}
