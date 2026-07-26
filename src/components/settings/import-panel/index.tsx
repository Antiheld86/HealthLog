"use client";

/**
 * v1.15.7 — Settings → Export & Import → Import area.
 *
 * Web UI for the three import backends. Each source is a self-contained
 * card under this directory:
 *
 *   1. Apple Health `export.zip`  — `apple-health-import-card.tsx`
 *      (multipart POST + status poll).
 *   2. Generic JSON import        — `json-import-card.tsx`
 *      (file/paste, client-side parseability guard).
 *   3. CSV import                 — `csv-import-card.tsx`
 *      (file/paste, dry-run preview).
 *
 * Both controls surface rate-limit (429) and error states cleanly and
 * announce progress to assistive tech via `aria-live` regions.
 */

import { useTranslations } from "@/lib/i18n/context";
import { AppleHealthImportCard } from "./apple-health-import-card";
import { JsonImportCard } from "./json-import-card";
import { CsvImportCard } from "./csv-import-card";
import { DoseHistoryImportCard } from "./dose-history-import-card";

export {
  EXAMPLE_IMPORT,
  EXAMPLE_CSV,
  parseImportJson,
} from "./import-examples";

export function ImportPanel() {
  const { t } = useTranslations();
  return (
    <section
      aria-labelledby="settings-section-import-title"
      className="space-y-3"
    >
      <div className="space-y-1">
        <h2
          id="settings-section-import-title"
          className="text-base font-semibold tracking-tight"
        >
          {t("settings.sections.export.import.heading")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("settings.sections.export.import.description")}
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <AppleHealthImportCard />
        <JsonImportCard />
        <CsvImportCard />
        <DoseHistoryImportCard />
      </div>
    </section>
  );
}
