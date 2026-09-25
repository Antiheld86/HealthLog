"use client";

import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useGrantDocumentReadingConsent } from "@/hooks/use-grant-document-reading-consent";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The consent question, asked where a document is about to be read.
 *
 * Shown in place of a document-reading action while its capability reports
 * `consent_required`: the chain would send the document to a service outside
 * this server and no receipt covers that yet. One sentence says what would
 * happen, one button grants exactly that (`ai_extraction`), and the action
 * appears once `/api/auth/me` confirms it. Withdrawing stays in Settings → AI.
 */
export function DocumentReadingConsentPrompt({
  className,
}: {
  className?: string;
}) {
  const { t } = useTranslations();
  const grant = useGrantDocumentReadingConsent();
  return (
    <div
      data-slot="document-reading-consent"
      className={
        className ??
        "border-border flex flex-col items-start gap-2 rounded-lg border border-dashed px-3 py-2.5"
      }
    >
      <p className="text-foreground flex items-start gap-2 text-sm">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>{t("documents.readingConsent.body")}</span>
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11 sm:min-h-9"
        disabled={grant.isPending}
        onClick={() => grant.mutate()}
        data-slot="document-reading-consent-grant"
      >
        {t("documents.readingConsent.grant")}
      </Button>
      {grant.isError ? (
        <p role="alert" className="text-destructive text-xs">
          {t("documents.readingConsent.error")}
        </p>
      ) : null}
    </div>
  );
}
