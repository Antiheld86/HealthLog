"use client";

/**
 * v1.7.0 — Settings → Export → Health Record export panel.
 *
 * One surface that drives `POST /api/export/health-record`: a format
 * toggle (PDF / FHIR / package) that drives the visible options below it
 * (per the "dropdown drives the form, no top/bottom split" preference),
 * a date-range picker, grouped data-section toggles, and the generate
 * action that streams the artefact as a download.
 *
 * Mood stays default-OFF everywhere (privacy). PDF-only fields (practice
 * name, charts) hide when the format is FHIR. The ePA-compat note shows
 * for the FHIR + package formats.
 *
 * v1.18.1 (D9) — the panel renders as a normal settings card (the v1.12
 * gradient/glow hero treatment was dropped: the gradient read too crass next
 * to the rest of the settings surface). The grouped data-section toggles live
 * behind a collapsible disclosure, collapsed by default, so the panel opens
 * compact instead of as a long always-expanded checklist.
 */

import Link from "next/link";
import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Download,
  FileText,
  FolderOpen,
  Loader2,
} from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useRovingRadioGroup } from "@/hooks/use-roving-radio-group";
import { apiFetchRaw } from "@/lib/api/api-fetch";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";

type ExportFormat = "pdf" | "fhir" | "package";

const EXPORT_FORMATS: readonly ExportFormat[] = ["pdf", "fhir", "package"];

interface SectionState {
  weight: boolean;
  bp: boolean;
  pulse: boolean;
  oxygenSaturation: boolean;
  bodyFat: boolean;
  bodyComposition: boolean;
  restingHeartRate: boolean;
  hrv: boolean;
  vo2max: boolean;
  steps: boolean;
  distance: boolean;
  sleep: boolean;
  glucose: boolean;
  medList: boolean;
  compliance: boolean;
  mood: boolean;
  bmi: boolean;
  labs: boolean;
  allergies: boolean;
  familyHistory: boolean;
}

const DEFAULT_SECTIONS: SectionState = {
  weight: true,
  bp: true,
  pulse: true,
  oxygenSaturation: true,
  bodyFat: true,
  bodyComposition: false,
  restingHeartRate: false,
  hrv: false,
  vo2max: false,
  steps: false,
  distance: false,
  sleep: false,
  glucose: true,
  medList: true,
  compliance: true,
  mood: false, // privacy default
  bmi: true,
  labs: true,
  allergies: true,
  familyHistory: true,
};

function buildSelectionSections(s: SectionState) {
  return {
    vitals: {
      weight: s.weight,
      bp: s.bp,
      pulse: s.pulse,
      oxygenSaturation: s.oxygenSaturation,
      bodyFat: s.bodyFat,
      bodyComposition: s.bodyComposition,
    },
    cardioFitness: {
      restingHeartRate: s.restingHeartRate,
      hrv: s.hrv,
      vo2max: s.vo2max,
    },
    activity: {
      steps: s.steps,
      distance: s.distance,
      sleep: s.sleep,
    },
    glucose: s.glucose,
    medications: { list: s.medList, compliance: s.compliance },
    mood: s.mood,
    bmi: s.bmi,
    labs: s.labs,
    allergies: s.allergies,
    familyHistory: s.familyHistory,
  };
}

export function HealthRecordExportPanel() {
  const { t, locale } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [days, setDays] = useState<number>(90);
  const [practiceName, setPracticeName] = useState("");
  const [practiceNameSeededUserId, setPracticeNameSeededUserId] = useState<
    string | null
  >(null);
  const [includeCharts, setIncludeCharts] = useState(true);
  const [includeAiSummary, setIncludeAiSummary] = useState(false);
  const [sections, setSections] = useState<SectionState>(DEFAULT_SECTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The included-data checklist is a disclosure, collapsed by default —
  // the panel opens compact instead of as a long always-expanded list.
  const [includedDataOpen, setIncludedDataOpen] = useState(false);
  const includedDataPanelId = useId();

  // Seed the practice name from the last export once the auth payload lands.
  // `useAuth` resolves asynchronously, so a `useState` initializer would read
  // `undefined` and stick at empty. Store-the-id-alongside-the-state (the same
  // pattern the account form uses) syncs during render instead of in an
  // effect, and the per-user gate means a late re-resolve never clobbers a
  // field the user is already typing into.
  if (user && user.id !== practiceNameSeededUserId) {
    setPracticeNameSeededUserId(user.id);
    setPracticeName(user.lastReportPracticeName ?? "");
  }

  const isPdfLike = format === "pdf" || format === "package";
  const isFhirLike = format === "fhir" || format === "package";

  const { getRadioProps: getFormatRadioProps } = useRovingRadioGroup({
    count: EXPORT_FORMATS.length,
    selectedIndex: EXPORT_FORMATS.indexOf(format),
    onSelect: (index) => setFormat(EXPORT_FORMATS[index]!),
  });

  function toggle(key: keyof SectionState) {
    setSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  // The single "Medikamente" control gates the whole medication block
  // (list + compliance) so unchecking it actually excludes all medication
  // data from the export — matching the iOS five-section model.
  function toggleMedications() {
    setSections((prev) => {
      const next = !(prev.medList && prev.compliance);
      return { ...prev, medList: next, compliance: next };
    });
  }

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetchRaw("/api/export/health-record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          format,
          // Carry the active in-app locale so the generated artefact matches
          // the UI language instead of falling back to the browser's
          // Accept-Language header on the server.
          locale,
          range: { days },
          practiceName: practiceName.trim() || undefined,
          includeCharts,
          includeAiSummary,
          sections: buildSelectionSections(sections),
        }),
      });
      if (!res.ok) {
        setError(`${res.status}`);
        return;
      }
      const blob = await res.blob();
      const ext = format === "pdf" ? "pdf" : format === "fhir" ? "json" : "zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `healthlog-health-record-${new Date()
        .toISOString()
        .slice(0, 10)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      // The route just persisted the practice name, so the cached `/me`
      // payload is stale. Refresh it, or a remount of this panel would seed
      // from the previous value.
      void queryClient.invalidateQueries({ queryKey: queryKeys.authMe() });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsCard
      as="section"
      aria-labelledby="health-record-export-title"
      data-testid="health-record-export-panel"
    >
      <SettingsCardHeader
        className="mb-4"
        icon={FileText}
        titleId="health-record-export-title"
        title={t("settings.healthRecord.title")}
        description={t("settings.healthRecord.description")}
      />

      <div className="space-y-4">
        {/* Format + range share a row on desktop so the panel opens
            denser; on mobile they stack. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-sm font-medium">
              {t("settings.healthRecord.format")}
            </legend>
            <div className="flex flex-wrap gap-2" role="radiogroup">
              {EXPORT_FORMATS.map((f, index) => (
                <Button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={format === f}
                  variant={format === f ? "default" : "outline"}
                  size="sm"
                  className="min-h-11 sm:min-h-9"
                  onClick={() => setFormat(f)}
                  {...getFormatRadioProps(index)}
                >
                  {t(`settings.healthRecord.format_${f}`)}
                </Button>
              ))}
            </div>
          </fieldset>

          {/* Date range */}
          <div className="space-y-1.5">
            <Label htmlFor="hr-range">{t("settings.healthRecord.range")}</Label>
            <NativeSelect
              id="hr-range"
              value={String(days)}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value="90">{t("settings.healthRecord.range90")}</option>
              <option value="180">{t("settings.healthRecord.range180")}</option>
              <option value="365">{t("settings.healthRecord.range365")}</option>
            </NativeSelect>
            {/* Entry point into the document vault for the report period
                (navigation only — attaching documents to the PDF is a later
                phase). Year granularity is what the vault's URL filters
                offer; the current year covers the bulk of any range. Only
                rendered when the documents module is enabled. */}
            {user?.modules?.inboundDocuments ? (
              <Link
                href={`/documents?year=${new Date().getFullYear()}`}
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1.5 rounded-md text-xs transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <FolderOpen className="size-3.5" aria-hidden />
                {t("settings.healthRecord.documentsLink")}
              </Link>
            ) : null}
          </div>
        </div>

        {/* Practice name — PDF only */}
        {isPdfLike && (
          <div className="space-y-1.5">
            <Label htmlFor="hr-practice">
              {t("settings.healthRecord.practiceName")}
            </Label>
            <Input
              id="hr-practice"
              value={practiceName}
              onChange={(e) => setPracticeName(e.target.value)}
              maxLength={120}
              placeholder={t("settings.healthRecord.practiceNamePlaceholder")}
            />
          </div>
        )}

        {/* Section groups — collapsible, collapsed by default so the
            panel opens compact. The disclosure follows the inline
            aria-expanded/aria-controls pattern used elsewhere in the app
            (e.g. the insights recommendation cards). */}
        <fieldset className="space-y-3">
          <legend className="sr-only">
            {t("settings.healthRecord.includedData")}
          </legend>
          <button
            type="button"
            data-testid="health-record-included-data-toggle"
            aria-expanded={includedDataOpen}
            aria-controls={includedDataPanelId}
            onClick={() => setIncludedDataOpen((v) => !v)}
            className="text-foreground hover:bg-muted/40 focus-visible:ring-ring/50 flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-1 py-1 text-left text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span>{t("settings.healthRecord.includedData")}</span>
            <ChevronDown
              className={cn(
                "text-muted-foreground h-4 w-4 shrink-0 transition-transform",
                includedDataOpen && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>

          {includedDataOpen && (
            <div
              id={includedDataPanelId}
              data-testid="health-record-included-data-panel"
              className="animate-insight-in space-y-3"
              style={{ animationDuration: "200ms" }}
            >
              <div className="border-border space-y-2 rounded-lg border p-3">
                <p className="text-xs font-semibold">
                  {t("settings.healthRecord.groupVitals")}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ToggleRow
                    label={t("settings.healthRecord.weight")}
                    checked={sections.weight}
                    onToggle={() => toggle("weight")}
                  />
                  <ToggleRow
                    label={t("settings.healthRecord.bp")}
                    checked={sections.bp}
                    onToggle={() => toggle("bp")}
                  />
                  <ToggleRow
                    label={t("settings.healthRecord.pulse")}
                    checked={sections.pulse}
                    onToggle={() => toggle("pulse")}
                  />
                  <ToggleRow
                    label={t("settings.healthRecord.oxygenSaturation")}
                    checked={sections.oxygenSaturation}
                    onToggle={() => toggle("oxygenSaturation")}
                  />
                  <ToggleRow
                    label={t("settings.healthRecord.bodyFat")}
                    checked={sections.bodyFat}
                    onToggle={() => toggle("bodyFat")}
                  />
                  <ToggleRow
                    label={t("settings.healthRecord.bodyComposition")}
                    checked={sections.bodyComposition}
                    onToggle={() => toggle("bodyComposition")}
                  />
                </div>
              </div>

              <div className="border-border space-y-2 rounded-lg border p-3">
                <p className="text-xs font-semibold">
                  {t("settings.healthRecord.groupCardio")}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ToggleRow
                    label={t("settings.healthRecord.restingHeartRate")}
                    checked={sections.restingHeartRate}
                    onToggle={() => toggle("restingHeartRate")}
                  />
                  <ToggleRow
                    label={t("settings.healthRecord.hrv")}
                    checked={sections.hrv}
                    onToggle={() => toggle("hrv")}
                  />
                  <ToggleRow
                    label={t("settings.healthRecord.vo2max")}
                    checked={sections.vo2max}
                    onToggle={() => toggle("vo2max")}
                  />
                </div>
              </div>

              <div className="border-border space-y-2 rounded-lg border p-3">
                <p className="text-xs font-semibold">
                  {t("settings.healthRecord.groupActivity")}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <ToggleRow
                    label={t("settings.healthRecord.steps")}
                    checked={sections.steps}
                    onToggle={() => toggle("steps")}
                  />
                  <ToggleRow
                    label={t("settings.healthRecord.distance")}
                    checked={sections.distance}
                    onToggle={() => toggle("distance")}
                  />
                  <ToggleRow
                    label={t("settings.healthRecord.sleep")}
                    checked={sections.sleep}
                    onToggle={() => toggle("sleep")}
                  />
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <ToggleRow
                  label={t("settings.healthRecord.glucose")}
                  checked={sections.glucose}
                  onToggle={() => toggle("glucose")}
                />
                <ToggleRow
                  label={t("settings.healthRecord.medications")}
                  checked={sections.medList && sections.compliance}
                  onToggle={toggleMedications}
                />
                <ToggleRow
                  label={t("settings.healthRecord.bmi")}
                  checked={sections.bmi}
                  onToggle={() => toggle("bmi")}
                />
                <ToggleRow
                  label={t("settings.healthRecord.mood")}
                  checked={sections.mood}
                  onToggle={() => toggle("mood")}
                />
                <ToggleRow
                  label={t("settings.healthRecord.labs")}
                  checked={sections.labs}
                  onToggle={() => toggle("labs")}
                />
                <ToggleRow
                  label={t("settings.healthRecord.allergies")}
                  checked={sections.allergies}
                  onToggle={() => toggle("allergies")}
                />
                <ToggleRow
                  label={t("settings.healthRecord.familyHistory")}
                  checked={sections.familyHistory}
                  onToggle={() => toggle("familyHistory")}
                />
              </div>

              {isPdfLike && (
                <ToggleRow
                  label={t("settings.healthRecord.includeCharts")}
                  checked={includeCharts}
                  onToggle={() => setIncludeCharts((v) => !v)}
                />
              )}
              {isPdfLike && (
                <ToggleRow
                  label={t("settings.healthRecord.includeAiSummary")}
                  checked={includeAiSummary}
                  onToggle={() => setIncludeAiSummary((v) => !v)}
                />
              )}
            </div>
          )}
        </fieldset>

        {/* The FHIR note and the generate action share the footer row so
            the panel ends compact instead of stacking a note above a
            right-aligned button. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {isFhirLike ? (
            <p className="text-muted-foreground max-w-md text-xs">
              {t("settings.healthRecord.fhirNote")}
            </p>
          ) : (
            <span />
          )}
          <Button
            type="button"
            onClick={handleGenerate}
            disabled={busy}
            className="ml-auto min-h-11 sm:min-h-9"
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            {t("settings.healthRecord.generate")}
          </Button>
        </div>

        {error && (
          <p role="alert" className="text-destructive text-sm">
            {t("settings.healthRecord.error", { code: error })}
          </p>
        )}
      </div>
    </SettingsCard>
  );
}

function ToggleRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onToggle} />
    </label>
  );
}
