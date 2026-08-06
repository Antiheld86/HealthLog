"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { apiGet, apiPatch } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import {
  assertRecordSettingsResponseForRecord,
  safeParseManagedRecordSettingsPatch,
  type ManagedRecordSettingsFamily,
} from "@/lib/record-settings";
import { Button } from "@/components/ui/button";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { SettingsCardHeader } from "./_card-header";
import { SettingsCard } from "./settings-card";

interface ManagedRecordSettingsResponse {
  recordId: string;
  family: ManagedRecordSettingsFamily;
  settings: Record<string, unknown>;
}

type ManagedSettingsFamily = Exclude<
  ManagedRecordSettingsFamily,
  "integrations"
>;
type SettingsFormProps = {
  settings: Record<string, unknown>;
  disabled: boolean;
  onSave: (patch: unknown) => void;
  saveLabel: string;
};

const COACH_EXCLUDE_METRICS = [
  "bp",
  "weight",
  "pulse",
  "mood",
  "compliance",
  "hrv",
  "sleep",
  "resting_hr",
  "steps",
  "medications",
  "anthropometrics",
] as const;
const COACH_DATA_CLUSTERS = [
  "cardio",
  "body",
  "activity",
  "workouts",
  "sleep",
  "mood",
  "glucose",
  "medication",
  "mobility",
  "environment",
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function formNumber(form: FormData, name: string, fallback: number): number {
  const value = Number(form.get(name));
  return Number.isFinite(value) ? value : fallback;
}

function SaveButton({ disabled, label }: { disabled: boolean; label: string }) {
  return (
    <Button disabled={disabled} type="submit">
      {label}
    </Button>
  );
}

function ProfileSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
}: SettingsFormProps) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const displayName = asString(form.get("displayName")).trim();
    const heightValue = asString(form.get("heightCm")).trim();
    onSave({
      displayName: displayName || null,
      heightCm: heightValue === "" ? null : Number(heightValue),
      dateOfBirth: asString(form.get("dateOfBirth")) || null,
      gender: asString(form.get("gender")) || null,
      locale: asString(form.get("locale")) || null,
      timezone: asString(form.get("timezone")),
      unitPreference: asString(form.get("unitPreference")),
      timeFormat: asString(form.get("timeFormat")),
      dateFormat: asString(form.get("dateFormat")),
    });
  }

  return (
    <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className="grid gap-1 text-sm" htmlFor="managed-display-name">
        Display name
        <input
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asString(settings.displayName)}
          disabled={disabled}
          id="managed-display-name"
          name="displayName"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-height">
        Height (cm)
        <input
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={
            settings.heightCm === null ? "" : String(settings.heightCm ?? "")
          }
          disabled={disabled}
          id="managed-height"
          max="300"
          min="30"
          name="heightCm"
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-date-of-birth">
        Date of birth
        <input
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asString(settings.dateOfBirth)}
          disabled={disabled}
          id="managed-date-of-birth"
          name="dateOfBirth"
          type="date"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-gender">
        Gender
        <select
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asString(settings.gender)}
          disabled={disabled}
          id="managed-gender"
          name="gender"
        >
          <option value="">Not specified</option>
          <option value="MALE">Male</option>
          <option value="FEMALE">Female</option>
          <option value="OTHER">Other</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-locale">
        Locale
        <select
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asString(settings.locale)}
          disabled={disabled}
          id="managed-locale"
          name="locale"
        >
          <option value="">System default</option>
          {["de", "en", "es", "fr", "it", "pl"].map((locale) => (
            <option key={locale} value={locale}>
              {locale}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-timezone">
        Timezone
        <input
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asString(settings.timezone, "Europe/Berlin")}
          disabled={disabled}
          id="managed-timezone"
          name="timezone"
          required
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-units">
        Units
        <select
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asString(settings.unitPreference, "metric")}
          disabled={disabled}
          id="managed-units"
          name="unitPreference"
        >
          <option value="metric">Metric</option>
          <option value="imperial">Imperial</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-time-format">
        Time format
        <select
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asString(settings.timeFormat, "AUTO")}
          disabled={disabled}
          id="managed-time-format"
          name="timeFormat"
        >
          <option value="AUTO">Automatic</option>
          <option value="H12">12-hour</option>
          <option value="H24">24-hour</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-date-format">
        Date format
        <select
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asString(settings.dateFormat, "AUTO")}
          disabled={disabled}
          id="managed-date-format"
          name="dateFormat"
        >
          <option value="AUTO">Automatic</option>
          <option value="DMY">Day / month / year</option>
          <option value="MDY">Month / day / year</option>
          <option value="YMD">Year / month / day</option>
        </select>
      </label>
      <div className="sm:col-span-2">
        <SaveButton disabled={disabled} label={saveLabel} />
      </div>
    </form>
  );
}

function ModulesSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
}: SettingsFormProps) {
  const preferences = asRecord(settings.modulePreferences);
  const entries = Object.entries(preferences).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      modulePreferences: Object.fromEntries(
        entries.map(([key]) => [key, form.get(key) === "on"]),
      ),
    });
  }

  return (
    <form className="mt-4 space-y-3" onSubmit={submit}>
      {entries.map(([key, enabled]) => (
        <label className="flex items-center gap-3 text-sm" key={key}>
          <input
            defaultChecked={enabled === true}
            disabled={disabled}
            name={key}
            type="checkbox"
          />
          {key}
        </label>
      ))}
      <SaveButton disabled={disabled} label={saveLabel} />
    </form>
  );
}

function NotificationsSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
}: SettingsFormProps) {
  const preferences = asRecord(settings.notificationPreferences);
  const medication = asRecord(preferences.medication);
  const mood = asRecord(preferences.mood);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      moodReminderEnabled: form.get("moodReminderEnabled") === "on",
      notificationPreferences: {
        medication: {
          lowStockRunwayDays:
            form.get("lowStockRunwayDays") === ""
              ? null
              : formNumber(form, "lowStockRunwayDays", 7),
          reorderLeadDays: formNumber(form, "reorderLeadDays", 10),
        },
        mood: { reminderHour: formNumber(form, "reminderHour", 22) },
      },
    });
  }

  return (
    <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={submit}>
      <label className="flex items-center gap-3 text-sm sm:col-span-2">
        <input
          defaultChecked={settings.moodReminderEnabled === true}
          disabled={disabled}
          name="moodReminderEnabled"
          type="checkbox"
        />
        Enable mood reminder
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-reminder-hour">
        Mood reminder hour
        <input
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asNumber(mood.reminderHour, 22)}
          disabled={disabled}
          id="managed-reminder-hour"
          max="23"
          min="0"
          name="reminderHour"
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-low-stock">
        Low-stock runway days
        <input
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={
            medication.lowStockRunwayDays === null
              ? ""
              : asNumber(medication.lowStockRunwayDays, 7)
          }
          disabled={disabled}
          id="managed-low-stock"
          max="60"
          min="1"
          name="lowStockRunwayDays"
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-reorder-lead">
        Reorder lead days
        <input
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asNumber(medication.reorderLeadDays, 10)}
          disabled={disabled}
          id="managed-reorder-lead"
          max="60"
          min="0"
          name="reorderLeadDays"
          type="number"
        />
      </label>
      <div className="sm:col-span-2">
        <SaveButton disabled={disabled} label={saveLabel} />
      </div>
    </form>
  );
}

function ThresholdsSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
}: SettingsFormProps) {
  const overrides = asRecord(settings.overrides);
  const metrics = Object.keys(overrides);
  const metric = metrics[0] ?? "WEIGHT";
  const firstRange = asRecord(overrides[metric]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const selectedMetric = asString(form.get("metric"), metric);
    onSave({
      overrides: {
        [selectedMetric]: {
          min: formNumber(form, "minimum", asNumber(firstRange.min, 0)),
          max: formNumber(form, "maximum", asNumber(firstRange.max, 0)),
        },
      },
    });
  }

  return (
    <form className="mt-4 grid gap-4 sm:grid-cols-3" onSubmit={submit}>
      <label className="grid gap-1 text-sm" htmlFor="managed-threshold-metric">
        Metric
        <select
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={metric}
          disabled={disabled}
          id="managed-threshold-metric"
          name="metric"
        >
          {[...new Set([metric, ...metrics])].map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-threshold-minimum">
        Minimum
        <input
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asNumber(firstRange.min, 0)}
          disabled={disabled}
          id="managed-threshold-minimum"
          name="minimum"
          required
          type="number"
        />
      </label>
      <label className="grid gap-1 text-sm" htmlFor="managed-threshold-maximum">
        Maximum
        <input
          className="border-input bg-background rounded-md border px-3 py-2"
          defaultValue={asNumber(firstRange.max, 0)}
          disabled={disabled}
          id="managed-threshold-maximum"
          name="maximum"
          required
          type="number"
        />
      </label>
      <div className="sm:col-span-3">
        <SaveButton disabled={disabled} label={saveLabel} />
      </div>
    </form>
  );
}

function CoachSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
}: SettingsFormProps) {
  const preferences = asRecord(settings.preferences);
  const excluded = new Set(asStringArray(preferences.excludeMetrics));
  const dataClusters = new Set(asStringArray(preferences.dataClusters));

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSave({
      disableCoach: form.get("disableCoach") === "on",
      preferences: {
        tone: asString(form.get("tone"), "warm"),
        verbosity: asString(form.get("verbosity"), "default"),
        excludeMetrics: COACH_EXCLUDE_METRICS.filter(
          (metric) => form.get(`exclude-${metric}`) === "on",
        ),
        showEvidenceByDefault: form.get("showEvidenceByDefault") === "on",
        defaultWindow: asString(form.get("defaultWindow"), "allTime"),
        ...(form.get("useCustomClusters") === "on"
          ? {
              dataClusters: COACH_DATA_CLUSTERS.filter(
                (cluster) => form.get(`cluster-${cluster}`) === "on",
              ),
            }
          : {}),
      },
    });
  }

  return (
    <form className="mt-4 space-y-4" onSubmit={submit}>
      <label className="flex items-center gap-3 text-sm">
        <input
          defaultChecked={settings.disableCoach === true}
          disabled={disabled}
          name="disableCoach"
          type="checkbox"
        />
        Disable Coach
      </label>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className="grid gap-1 text-sm" htmlFor="managed-coach-tone">
          Tone
          <select
            className="border-input bg-background rounded-md border px-3 py-2"
            defaultValue={asString(preferences.tone, "warm")}
            disabled={disabled}
            id="managed-coach-tone"
            name="tone"
          >
            <option value="warm">Warm</option>
            <option value="neutral">Neutral</option>
            <option value="concise">Concise</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm" htmlFor="managed-coach-verbosity">
          Verbosity
          <select
            className="border-input bg-background rounded-md border px-3 py-2"
            defaultValue={asString(preferences.verbosity, "default")}
            disabled={disabled}
            id="managed-coach-verbosity"
            name="verbosity"
          >
            <option value="brief">Brief</option>
            <option value="default">Default</option>
            <option value="detailed">Detailed</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm" htmlFor="managed-coach-window">
          Default window
          <select
            className="border-input bg-background rounded-md border px-3 py-2"
            defaultValue={asString(preferences.defaultWindow, "allTime")}
            disabled={disabled}
            id="managed-coach-window"
            name="defaultWindow"
          >
            <option value="last7days">Last 7 days</option>
            <option value="last30days">Last 30 days</option>
            <option value="last90days">Last 90 days</option>
            <option value="allTime">All time</option>
          </select>
        </label>
      </div>
      <label className="flex items-center gap-3 text-sm">
        <input
          defaultChecked={preferences.showEvidenceByDefault === true}
          disabled={disabled}
          name="showEvidenceByDefault"
          type="checkbox"
        />
        Show evidence by default
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Excluded metrics</legend>
        {COACH_EXCLUDE_METRICS.map((metric) => (
          <label
            className="mr-4 inline-flex items-center gap-2 text-sm"
            key={metric}
          >
            <input
              defaultChecked={excluded.has(metric)}
              disabled={disabled}
              name={`exclude-${metric}`}
              type="checkbox"
            />
            {metric}
          </label>
        ))}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Data clusters</legend>
        <label className="mb-2 flex items-center gap-2 text-sm">
          <input
            defaultChecked={Array.isArray(preferences.dataClusters)}
            disabled={disabled}
            name="useCustomClusters"
            type="checkbox"
          />
          Use a custom cluster selection
        </label>
        {COACH_DATA_CLUSTERS.map((cluster) => (
          <label
            className="mr-4 inline-flex items-center gap-2 text-sm"
            key={cluster}
          >
            <input
              defaultChecked={dataClusters.has(cluster)}
              disabled={disabled}
              name={`cluster-${cluster}`}
              type="checkbox"
            />
            {cluster}
          </label>
        ))}
      </fieldset>
      <SaveButton disabled={disabled} label={saveLabel} />
    </form>
  );
}

type LayoutItem = { id: string; visible: boolean; order: number };

function layoutItems(value: unknown): LayoutItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = asRecord(entry);
    const id = asString(item.id);
    return id
      ? [
          {
            id,
            visible: item.visible === true,
            order: asNumber(item.order, 0),
          },
        ]
      : [];
  });
}

function InsightsSettingsForm({
  settings,
  disabled,
  onSave,
  saveLabel,
}: SettingsFormProps) {
  const layout = asRecord(settings.layout);
  const sections = layoutItems(layout.sections);
  const tiles = layoutItems(layout.tiles);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const toPatch = (kind: "section" | "tile", item: LayoutItem) => ({
      id: item.id,
      visible: form.get(`${kind}-visible-${item.id}`) === "on",
      order: formNumber(form, `${kind}-order-${item.id}`, item.order),
    });
    onSave({
      layout: {
        version: asNumber(layout.version, 2),
        sections: sections.map((section) => toPatch("section", section)),
        tiles: tiles.map((tile) => toPatch("tile", tile)),
      },
    });
  }

  const renderItems = (kind: "section" | "tile", items: LayoutItem[]) => (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {kind === "section" ? "Overview sections" : "Navigation tiles"}
      </legend>
      {items.map((item) => (
        <div className="flex items-center gap-3 text-sm" key={item.id}>
          <label className="flex flex-1 items-center gap-2">
            <input
              defaultChecked={item.visible}
              disabled={disabled}
              name={`${kind}-visible-${item.id}`}
              type="checkbox"
            />
            {item.id}
          </label>
          <label
            className="flex items-center gap-2"
            htmlFor={`${kind}-order-${item.id}`}
          >
            Order
            <input
              className="border-input bg-background w-16 rounded-md border px-2 py-1"
              defaultValue={item.order}
              disabled={disabled}
              id={`${kind}-order-${item.id}`}
              min="0"
              name={`${kind}-order-${item.id}`}
              type="number"
            />
          </label>
        </div>
      ))}
    </fieldset>
  );

  return (
    <form className="mt-4 space-y-5" onSubmit={submit}>
      {renderItems("section", sections)}
      {renderItems("tile", tiles)}
      <SaveButton disabled={disabled} label={saveLabel} />
    </form>
  );
}

export function ManagedRecordSettingsForm({
  family,
  ...props
}: SettingsFormProps & { family: ManagedSettingsFamily }) {
  switch (family) {
    case "profile":
      return <ProfileSettingsForm {...props} />;
    case "modules":
      return <ModulesSettingsForm {...props} />;
    case "notifications":
      return <NotificationsSettingsForm {...props} />;
    case "thresholds":
      return <ThresholdsSettingsForm {...props} />;
    case "coach":
      return <CoachSettingsForm {...props} />;
    case "insights":
      return <InsightsSettingsForm {...props} />;
  }
}

/**
 * Managed settings use typed target-record controls only. The actor's
 * Settings components never mount here, so their actor-scoped queries and
 * mutations cannot fire while a Guardian administers a profile.
 */
export function ManagedRecordSettingsSection({
  family,
}: {
  family: ManagedSettingsFamily;
}) {
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const recordId = user?.accountAccess?.active?.accountId ?? null;
  const [validationFailed, setValidationFailed] = useState(false);
  const query = useQuery({
    queryKey: queryKeys.recordSettingsFamily(recordId ?? "", family),
    enabled: recordId !== null,
    queryFn: async () => {
      const response = await apiGet<ManagedRecordSettingsResponse>(
        `/api/record-settings/${family}`,
      );
      assertRecordSettingsResponseForRecord(response, recordId);
      if (response.family !== family) {
        throw new Error(
          "Managed record settings response did not match its key",
        );
      }
      return response;
    },
  });
  const save = useMutation({
    mutationFn: async (patch: unknown) => {
      const response = await apiPatch<ManagedRecordSettingsResponse>(
        `/api/record-settings/${family}`,
        patch,
      );
      assertRecordSettingsResponseForRecord(response, recordId);
      if (response.family !== family) {
        throw new Error(
          "Managed record settings response did not match its key",
        );
      }
      return response;
    },
    onSuccess: (response) => {
      if (recordId === null) return;
      queryClient.setQueryData(
        queryKeys.recordSettingsFamily(recordId, family),
        response,
      );
    },
  });

  if (query.isError) {
    return <QueryErrorCard onRetry={() => void query.refetch()} />;
  }

  return (
    <SettingsCard aria-busy={query.isLoading}>
      <SettingsCardHeader
        icon={Settings}
        title={t(`settings.sections.${family}.title`)}
      />
      {query.data ? (
        <>
          <ManagedRecordSettingsForm
            disabled={save.isPending}
            family={family}
            onSave={(patch) => {
              const parsed = safeParseManagedRecordSettingsPatch(family, patch);
              if (!parsed.success) {
                setValidationFailed(true);
                return;
              }
              setValidationFailed(false);
              save.mutate(parsed.data);
            }}
            saveLabel={t("common.save")}
            settings={query.data.settings}
          />
          {save.isError || validationFailed ? (
            <p className="text-destructive mt-3 text-sm" role="alert">
              {t("common.networkError")}
            </p>
          ) : null}
        </>
      ) : null}
    </SettingsCard>
  );
}
