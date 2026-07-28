"use client";

import { EyeOff, RotateCcw, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

interface PatternDecisionResponse {
  id: string;
  dismissed: boolean;
}

export function PatternDismissButton({
  patternId,
  onDismissed,
  className,
}: {
  patternId: string;
  onDismissed: () => void;
  className?: string;
}) {
  const { t } = useTranslations();
  const [pending, setPending] = useState(false);

  async function dismiss() {
    setPending(true);
    try {
      await apiPatch<PatternDecisionResponse>(
        `/api/insights/patterns/${patternId}`,
        { dismissed: true },
      );
      onDismissed();
    } catch {
      toast.error(t("insights.pattern.dismissError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={dismiss}
      className={cn("gap-1.5", className)}
      aria-label={t("insights.pattern.dismiss")}
    >
      <X className="size-3.5" aria-hidden="true" />
      {t("insights.pattern.dismiss")}
    </Button>
  );
}

export function PatternDismissedNotice({
  patternId,
  onRestored,
  compact = false,
}: {
  patternId: string;
  onRestored: () => void;
  compact?: boolean;
}) {
  const { t } = useTranslations();
  const [pending, setPending] = useState(false);

  async function restore() {
    setPending(true);
    try {
      await apiPatch<PatternDecisionResponse>(
        `/api/insights/patterns/${patternId}`,
        { dismissed: false },
      );
      onRestored();
    } catch {
      toast.error(t("insights.pattern.restoreError"));
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      data-slot="pattern-dismissed"
      role="status"
      className={cn(
        "text-muted-foreground flex items-center justify-between gap-3 text-sm",
        !compact && "rounded-md border px-3 py-2",
      )}
    >
      <span className="flex items-center gap-2">
        <EyeOff className="size-4 shrink-0" aria-hidden="true" />
        {t("insights.pattern.dismissed")}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={restore}
        className="gap-1.5"
      >
        <RotateCcw className="size-3.5" aria-hidden="true" />
        {t("insights.pattern.restore")}
      </Button>
    </div>
  );
}
