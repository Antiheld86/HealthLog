/**
 * The public clinician view.
 *
 * A pure server component: it receives an already-resolved, owner-scoped
 * {@link DoctorReportData} plus a server-side translator and renders a
 * read-only clinical summary. NO client hooks, NO session, NO AI or coach, NO
 * markdown — every value renders as escaped React text.
 *
 * Layout: provenance header (with the two machine-format downloads) → the
 * measurement groups in selection order → glucose → medications and adherence
 * → a FENCED, muted wellness card carrying the load-bearing "descriptive, not
 * a clinical assessment" disclaimer → the attached documents.
 *
 * The section components live in `./report-sections`, the document list in
 * `./documents-list`, the downloads in `./download-actions`.
 */
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { makeFormatters } from "@/lib/format-locale";
import type { Locale } from "@/lib/i18n/config";
import type { ShareViewDocument } from "@/lib/clinician-share/share-view-data";
import type { ReportSelection } from "@/lib/report-selection/selection";
import { PageHeader } from "@/components/ui/page-header";
import { DocumentEntry } from "./documents-list";
import { ShareDownloadActions } from "./download-actions";
import {
  AllergiesSection,
  AnamnesisSection,
  GlucoseSection,
  MeasurementGroups,
  MedicationsSection,
  Section,
  StatRow,
  WellnessSection,
} from "./report-sections";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

interface ClinicianViewProps {
  t: Translate;
  /** Owner-set label for the share (e.g. a clinic note). */
  label: string;
  /** ISO expiry instant — surfaced so the clinician knows the link lifetime. */
  expiresAt: string;
  /**
   * The owner-scoped report payload, or `null` for a documents-only share.
   * When `null` NO health metric is rendered — only the header, the
   * disclaimer, and the attached documents.
   */
  report: DoctorReportData | null;
  /** The link's frozen selection, resolved. */
  selection: ReportSelection;
  /**
   * A documents-only link. Hides the reporting-period line (there is no
   * report) and, together with a `null` report, keeps every health section off
   * the page.
   */
  documentOnly?: boolean;
  /**
   * The frozen document set on this link (metadata only — never bytes). Each
   * entry points at the token-scoped serve route, the one decrypt path.
   */
  documents?: ShareViewDocument[];
  /** The raw share token from the path — used to build serve-route URLs. */
  token?: string;
  /** Viewer locale (byte formatting only). Defaults to English. */
  locale?: Locale;
  /**
   * Issue #490 — the share OWNER's profile timezone. Period start/end and the
   * expiry date render in this zone so the dates agree with the patient-tz
   * aggregation behind the stats (and with the doctor-report PDF).
   */
  timezone?: string;
}

export function ClinicianView({
  t,
  label,
  expiresAt,
  report,
  selection,
  documents = [],
  documentOnly = false,
  token = "",
  locale = "en",
  timezone,
}: ClinicianViewProps) {
  // Owner-tz, locale-aware date rendering (issue #490) — `makeFormatters`
  // guards the zone and falls back to Europe/Berlin on garbage/absence.
  const fmt = makeFormatters(locale, timezone);
  const fmtDate = (iso: string) => fmt.date(new Date(iso));
  const fmtNum = (n: number) => Math.round(n * 100) / 100;

  return (
    <main
      id="main-content"
      className="mx-auto min-h-dvh w-full max-w-3xl px-4 py-8"
    >
      {/* ── Provenance header ───────────────────────────────────────── */}
      <header className="mb-6 space-y-1.5">
        <PageHeader title={t("clinicianView.title")} description={label} />
        {report && !documentOnly ? (
          <p className="text-muted-foreground mt-3 text-sm">
            {t("clinicianView.period", {
              start: fmtDate(report.period.start),
              end: fmtDate(report.period.end),
            })}
          </p>
        ) : null}
        <p className="text-muted-foreground mt-1 text-xs">
          {t("clinicianView.expires", { date: fmtDate(expiresAt) })}
        </p>
        {report && !documentOnly && token ? (
          <ShareDownloadActions t={t} token={token} />
        ) : null}
        <p className="border-border bg-muted/40 text-muted-foreground mt-3 rounded-md border p-3 text-xs">
          {t("clinicianView.provenance")}
        </p>
      </header>

      <div className="space-y-4">
        {report ? (
          <>
            <MeasurementGroups t={t} report={report} fmtNum={fmtNum} />
            {report.bmi !== null && report.bmi !== undefined ? (
              <Section title={t("clinicianView.bmiSection")}>
                <StatRow
                  label={t("clinicianView.bmi")}
                  value={String(fmtNum(report.bmi))}
                />
              </Section>
            ) : null}
            <GlucoseSection t={t} report={report} fmtNum={fmtNum} />
            <MedicationsSection t={t} report={report} selection={selection} />
            <AllergiesSection t={t} report={report} selection={selection} />
            <AnamnesisSection t={t} report={report} selection={selection} />
            <WellnessSection t={t} report={report} fmtNum={fmtNum} />
          </>
        ) : null}

        {/* ── Shared documents ────────────────────────────────────── */}
        {documents.length > 0 && token ? (
          <Section title={t("clinicianView.documents.title")}>
            <p className="text-muted-foreground mb-3 text-xs">
              {t("clinicianView.documents.exifNote")}
            </p>
            <ul className="space-y-3">
              {documents.map((doc) => (
                <DocumentEntry
                  key={doc.id}
                  t={t}
                  doc={doc}
                  token={token}
                  locale={locale}
                />
              ))}
            </ul>
          </Section>
        ) : null}
      </div>

      <footer className="border-border text-muted-foreground mt-8 border-t pt-4 text-center text-xs">
        {t("clinicianView.footer")}
      </footer>
    </main>
  );
}
