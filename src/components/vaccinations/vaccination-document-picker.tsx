"use client";

/**
 * The from-the-record document link: attach the scanned page a dose was
 * transcribed from. The shared {@link EntityLinkPicker} — an inline summary
 * (removable chips + an add button) over a searchable, month-grouped sheet.
 *
 * The whole vault is offered, not only the pages dated near the dose: one
 * childhood record commonly covers a dozen doses given years apart, and it
 * belongs on every one of them. The pages dated within the upload
 * suggestion's window of this dose sit on top as suggestions.
 *
 * **The gate blanks the block, it does not post-filter it.** When the
 * `inboundDocuments` module is off, this renders nothing — no heading, no empty
 * list — because an empty picker for a switched-off module advertises a feature
 * that is not there. The same shape the visit form's link pickers use.
 *
 * Nothing here can block a save: the list starts empty and stays valid empty,
 * and linking is optional, capped and idempotent behind the link facade.
 */
import { FolderOpen } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";
import { EntityLinkPicker } from "@/components/links/entity-link-picker";
import { useVaultDocumentOptions } from "@/components/links/vault-document-options";

export function VaccinationDocumentPicker({
  enabled,
  anchor,
  documentIds,
  onChange,
}: {
  /** The `inboundDocuments` module flag — false blanks the block entirely. */
  enabled: boolean;
  /** The dose's own date (ISO), for the suggestions on top. */
  anchor: string | null;
  documentIds: string[];
  onChange: (documentIds: string[]) => void;
}) {
  const { t } = useTranslations();
  const vault = useVaultDocumentOptions({ enabled, anchor });

  if (!enabled) return null;

  return (
    <div className="border-t pt-4" data-slot="vaccination-document-picker">
      <EntityLinkPicker
        icon={FolderOpen}
        title={t("vaccinations.form.linkDocuments")}
        slot="vaccination-document"
        pending={vault.pending}
        error={vault.error}
        errorLabel={t("links.picker.loadError")}
        onRetry={vault.retry}
        selected={documentIds}
        onChange={onChange}
        options={vault.options}
        searchPlaceholder={t("links.picker.searchPlaceholder")}
        emptyLabel={t("vaccinations.form.linkNothingToOffer")}
      />
    </div>
  );
}
