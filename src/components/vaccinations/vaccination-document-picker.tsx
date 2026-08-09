"use client";

/**
 * The from-the-record document link: attach the scanned page a dose was
 * transcribed from. The shared {@link EntityLinkPicker} — an inline summary
 * (removable chips + an add button) over a searchable, month-grouped sheet.
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

import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";
import {
  EntityLinkPicker,
  type EntityLinkOption,
} from "@/components/links/entity-link-picker";

const PICKER_FETCH_LIMIT = 200;

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
        `/api/documents/inbound?sort=documentDate&order=desc&limit=${PICKER_FETCH_LIMIT}`,
      ),
  });

  if (!enabled) return null;

  const options: EntityLinkOption[] = (documents.data?.documents ?? []).map(
    (doc) => {
      const date = doc.documentDate ?? doc.reportDate ?? doc.createdAt;
      return {
        id: doc.id,
        label: doc.title ?? doc.filename ?? doc.id,
        dateLabel: date ? format.date(date) : null,
        group: date
          ? {
              key: date.slice(0, 7),
              label: `${format.monthShort(date)} ${date.slice(0, 4)}`,
            }
          : null,
      };
    },
  );

  return (
    <div className="border-t pt-4" data-slot="vaccination-document-picker">
      <EntityLinkPicker
        icon={FolderOpen}
        title={t("vaccinations.form.linkDocuments")}
        slot="vaccination-document"
        pending={documents.isPending}
        selected={documentIds}
        onChange={onChange}
        options={options}
        searchPlaceholder={t("links.picker.searchPlaceholder")}
        emptyLabel={t("vaccinations.form.linkNothingToOffer")}
      />
    </div>
  );
}
