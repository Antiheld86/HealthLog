"use client";

/**
 * "Import from Paperless-ngx / Papra": the button that opens the document
 * picker (#1038), for every place a document can be added or linked.
 *
 * Renders nothing unless the person, in their own record, has at least one
 * usable connection: no connection, a delegate or guardian, the module off, or
 * the operator's list unset all leave no trace, because a button that can only
 * lead to a refusal advertises a feature that is not there. Connecting happens
 * in Settings, not here.
 */
import { Import } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import type { InboundDocumentKindValue } from "@/lib/validations/inbound-documents";

import {
  DocumentSourcePicker,
  type DocumentPickerLink,
} from "./document-source-picker";
import { systemName, useDocumentSourcesStatus } from "./use-document-sources";

export function ImportFromSourceButton({
  link,
  kind,
  onImported,
  className,
}: {
  link?: DocumentPickerLink;
  kind?: InboundDocumentKindValue;
  onImported?: (documentIds: string[]) => void;
  className?: string;
}) {
  const { t } = useTranslations();
  const { connected } = useDocumentSourcesStatus();
  const [open, setOpen] = useState(false);

  if (connected.length === 0) return null;

  const label =
    connected.length === 1
      ? t("documents.sourcePicker.openNamed", {
          name: systemName(connected[0]),
        })
      : t("documents.sourcePicker.open");

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={className}
        onClick={() => setOpen(true)}
        data-slot="document-source-open"
      >
        <Import className="size-4" aria-hidden />
        {label}
      </Button>
      <DocumentSourcePicker
        open={open}
        onOpenChange={setOpen}
        systems={connected}
        link={link}
        kind={kind}
        onImported={onImported}
      />
    </>
  );
}
