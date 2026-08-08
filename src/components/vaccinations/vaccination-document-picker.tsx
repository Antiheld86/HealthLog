"use client";

/**
 * The from-the-record document link: attach the scanned page a dose was
 * transcribed from.
 *
 * **The gate blanks the block, it does not post-filter it.** When the
 * `inboundDocuments` module is off, this renders nothing — no heading, no empty
 * list — because an empty picker for a switched-off module advertises a feature
 * that is not there. The same shape the visit form's link pickers use.
 *
 * Nothing here can block a save: the list starts empty and stays valid empty,
 * and linking is optional, capped and idempotent behind the link facade.
 */
import { useQuery } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

const OPTION_LIMIT = 25;

interface DocumentListPage {
  documents: InboundDocumentDto[];
}

export function VaccinationDocumentPicker({
  enabled,
  documentIds,
  onChange,
}: {
  /** The `inboundDocuments` module flag — false blanks the block entirely. */
  enabled: boolean;
  documentIds: string[];
  onChange: (documentIds: string[]) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();

  const documents = useQuery({
    queryKey: queryKeys.inboundDocumentPicker("vaccination-form"),
    enabled,
    queryFn: () =>
      apiGet<DocumentListPage>(
        `/api/documents/inbound?sort=documentDate&order=desc&limit=${OPTION_LIMIT}`,
      ),
  });

  if (!enabled) return null;

  const toggle = (id: string) =>
    onChange(
      documentIds.includes(id)
        ? documentIds.filter((entry) => entry !== id)
        : [...documentIds, id],
    );

  const options = (documents.data?.documents ?? []).map((doc) => ({
    id: doc.id,
    label: doc.title ?? doc.filename ?? doc.id,
    date: doc.documentDate ?? doc.reportDate ?? doc.createdAt,
  }));

  return (
    <div
      className="space-y-2 border-t pt-4"
      data-slot="vaccination-document-picker"
    >
      <div className="flex items-center gap-2">
        <FolderOpen className="text-foreground size-4 shrink-0" aria-hidden />
        <span className="text-sm font-medium">
          {t("vaccinations.form.linkDocuments")}
        </span>
        {documentIds.length > 0 ? (
          <Badge variant="outline" className="ml-auto">
            {documentIds.length}
          </Badge>
        ) : null}
      </div>
      {documents.isPending ? (
        <Skeleton className="h-9 w-full rounded-md" />
      ) : options.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("vaccinations.form.linkNothingToOffer")}
        </p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto overscroll-contain">
          {options.map((option) => {
            const on = documentIds.includes(option.id);
            return (
              <li key={option.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  data-slot="vaccination-document-option"
                  onClick={() => toggle(option.id)}
                  className={cn(
                    "border-border hover:bg-muted/50 focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-2 rounded-md border px-3 text-left focus-visible:ring-[3px] focus-visible:outline-none",
                    on && "border-primary/40 bg-primary/5",
                  )}
                >
                  <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                    {option.label}
                  </span>
                  {option.date ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {format.date(option.date)}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
