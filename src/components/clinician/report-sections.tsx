/**
 * The health sections of the clinician view, grouped the way the owner chose
 * them.
 *
 * The measurement list used to be a flat `Object.entries(report.stats)` with a
 * humanised-enum fallback for any type the ten-entry label map missed, so a
 * clinician read rows called "Phq9 score" and "Audio exposure headphone" in
 * one undifferentiated column. It now renders in the same twelve groups the
 * selection panel shows, with the real localised labels, so the page and the
 * PDF describe the record in the same order.
 *
 * A pure server component: no client hooks, no session, no markdown — every
 * value renders as escaped React text.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import type { DoctorReportData } from "@/lib/doctor-report-data";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";
import {
  isStructuredLeafId,
  REPORT_GROUPS,
} from "@/lib/report-selection/catalogue";
import type { ReportSelection } from "@/lib/report-selection/selection";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/** Human-readable display per persisted wellness-score type (i18n key suffix). */
const WELLNESS_KEY: Record<string, string> = {
  RECOVERY_SCORE: "recovery",
  STRESS_SCORE: "stress",
  STRAIN_SCORE: "strain",
};

/** Render a single labelled stat row. */
export function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-border/40 flex items-baseline justify-between gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground text-sm">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border bg-card rounded-lg border p-4 md:p-6">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

/**
 * The measurement groups that carry data, in selection order. The aggregator
 * has already applied the selection, so a type missing from `report.stats` is
 * one that was withheld or has no reading.
 */
export function MeasurementGroups({
  t,
  report,
  fmtNum,
}: {
  t: Translate;
  report: DoctorReportData;
  fmtNum: (n: number) => number;
}) {
  const groups = REPORT_GROUPS.map((group) => ({
    labelKey: group.labelKey,
    rows: group.leaves
      .filter((leaf): leaf is MeasurementType => !isStructuredLeafId(leaf))
      .map((type) => ({ type, stat: report.stats[type] }))
      .filter((row) => row.stat !== undefined && row.stat.count > 0),
  })).filter((group) => group.rows.length > 0);

  if (groups.length === 0) return null;

  return (
    <>
      {groups.map((group) => (
        <Section key={group.labelKey} title={t(group.labelKey)}>
          {group.rows.map(({ type, stat }) => (
            <StatRow
              key={type}
              label={t(MEASUREMENT_TYPE_LABEL_KEYS[type])}
              value={t("clinicianView.statSummary", {
                latest: fmtNum(stat!.latest),
                avg: fmtNum(stat!.avg),
                min: fmtNum(stat!.min),
                max: fmtNum(stat!.max),
              })}
            />
          ))}
        </Section>
      ))}
    </>
  );
}

/** Per-context glucose stats. Present only when the glucose panel was chosen. */
export function GlucoseSection({
  t,
  report,
  fmtNum,
}: {
  t: Translate;
  report: DoctorReportData;
  fmtNum: (n: number) => number;
}) {
  const entries = Object.entries(report.glucoseStats).filter(
    ([, s]) => s.count > 0,
  );
  if (entries.length === 0) return null;
  return (
    <Section title={t("clinicianView.labs")}>
      {entries.map(([ctx, s]) => (
        <StatRow
          key={ctx}
          label={t(`clinicianView.glucose.${ctx}`)}
          value={t("clinicianView.statSummary", {
            latest: fmtNum(s.latest),
            avg: fmtNum(s.avg),
            min: fmtNum(s.min),
            max: fmtNum(s.max),
          })}
        />
      ))}
    </Section>
  );
}

/** The medication list with the adherence rate beside each drug. */
export function MedicationsSection({
  t,
  report,
  selection,
}: {
  t: Translate;
  report: DoctorReportData;
  selection: ReportSelection;
}) {
  const medications = report.medications ?? [];
  const complianceOn = selection.has("MEDICATION_COMPLIANCE");
  const complianceEntries = complianceOn
    ? Object.entries(report.compliance).filter(([, c]) => c.total > 0)
    : [];
  if (medications.length === 0 && complianceEntries.length === 0) return null;

  return (
    <Section title={t("clinicianView.medications")}>
      {medications.map((med) => {
        const comp = report.compliance[med.name];
        const rate =
          complianceOn && comp && comp.total > 0
            ? `${Math.round((comp.taken / comp.total) * 100)}%`
            : null;
        return (
          <StatRow
            key={med.name}
            label={med.dose ? `${med.name} — ${med.dose}` : med.name}
            value={
              rate
                ? t("clinicianView.adherence", { rate })
                : t("clinicianView.noAdherence")
            }
          />
        );
      })}
      {complianceEntries
        .filter(([name]) => !medications.some((m) => m.name === name))
        .map(([name, c]) => (
          <StatRow
            key={name}
            label={name}
            value={t("clinicianView.adherence", {
              rate: `${Math.round((c.taken / c.total) * 100)}%`,
            })}
          />
        ))}
    </Section>
  );
}

/**
 * The fenced wellness card. Descriptive composites, not clinical assessments —
 * the disclaimer is load-bearing and sits above the numbers, not under them.
 */
export function WellnessSection({
  t,
  report,
  fmtNum,
}: {
  t: Translate;
  report: DoctorReportData;
  fmtNum: (n: number) => number;
}) {
  const wellness = report.wellnessScores?.filter((s) => s.count > 0) ?? [];
  if (wellness.length === 0) return null;
  return (
    <section className="border-warning/50 bg-warning/5 rounded-lg border border-dashed p-4 md:p-6">
      <h2 className="text-muted-foreground mb-1 text-base font-semibold">
        {t("clinicianView.wellness.title")}
      </h2>
      <p className="text-muted-foreground mb-3 text-xs">
        {t("clinicianView.wellness.disclaimer")}
      </p>
      <div>
        {wellness.map((s) => (
          <StatRow
            key={s.type}
            label={t(
              `clinicianView.wellness.${WELLNESS_KEY[s.type] ?? "score"}`,
            )}
            value={t("clinicianView.statSummary", {
              latest: fmtNum(s.latest),
              avg: fmtNum(s.avg),
              min: fmtNum(s.min),
              max: fmtNum(s.max),
            })}
          />
        ))}
      </div>
    </section>
  );
}
