"use client";

import type { ReactNode } from "react";
import { AlertTriangle, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * Read-failure card for list / data surfaces.
 *
 * Mirrors `<ChartErrorState>`'s shape + tone (AlertTriangle, a title line, a
 * muted description, an optional Retry button) but renders inside a `Card` so
 * a list page can tell "load failed" apart from an honest empty state — a
 * failed query must never fall through to the "no data yet" copy. Defaults are
 * the generic `common.*` strings so a caller can drop it in with just
 * `onRetry`; a surface with its own "couldn't load X" string passes it through
 * `title` / `description`.
 */
export function QueryErrorCard({
  title,
  description,
  onRetry,
  retryLabel,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  const { t } = useTranslations();
  return (
    <Card data-slot="query-error-card" className={cn(className)}>
      <CardContent
        role="alert"
        className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center"
      >
        <AlertTriangle
          className="text-muted-foreground h-8 w-8"
          aria-hidden="true"
        />
        <p className="text-sm font-medium">{title ?? t("common.loadFailed")}</p>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
        {onRetry ? (
          // The slot is the accessibility suite's handle on the one control
          // this card offers: the error state has to be recoverable by
          // keyboard, and asserting that against viewport text would pin the
          // copy instead of the affordance.
          <Button
            data-slot="query-error-retry"
            variant="outline"
            size="sm"
            onClick={onRetry}
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            {retryLabel ?? t("common.retry")}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
