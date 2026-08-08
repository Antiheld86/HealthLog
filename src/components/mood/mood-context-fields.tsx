"use client";

/**
 * The four day-context sections, and the read-only block beside them.
 *
 * One component for both mood surfaces — the create sheet and the list's edit
 * dialog — for the same reason the level-A sliders share one: what one writes
 * the other has to be able to show, and a value somebody set on Monday and
 * cannot correct on Tuesday is worse than one they were never offered.
 *
 * Every section is closed by default and renders no inputs while closed, so an
 * entry is still one tap and Save. The count badge on a closed section says
 * how much is in it, so nothing is hidden silently.
 *
 * Two copy rules hold throughout, and both are load-bearing rather than
 * stylistic. Labels state facts and never judgements: "worked a regular day"
 * is a fact and "worked too much" is a verdict on somebody's life. And the
 * linked block is read-only — it shows what the sleep, activity, vitals and
 * illness modules already hold, names where each figure comes from, and offers
 * a way in to change it there. It is never an input here, because the moment
 * it were, the same night would have two homes.
 */
import { useMemo } from "react";
import {
  Activity,
  Briefcase,
  CalendarClock,
  Link2,
  Palmtree,
  Users,
} from "lucide-react";

import { DateTimeField } from "@/components/ui/date-time-field";
import { FieldGroup } from "@/components/ui/field-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SheetSection, SheetSectionCount } from "@/components/ui/sheet-section";
import { SliderField } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { useTranslations } from "@/lib/i18n/context";
import {
  CONTACT_CIRCLE_KEYS,
  CONTACT_EXTENT_KEYS,
  CONTACT_FORM_KEYS,
  CONTEXT_MINUTES_MAX,
  CONTEXT_MINUTES_MIN,
  CONTEXT_RATING_MAX,
  CONTEXT_RATING_MIN,
  CONTEXT_VALENCE_MAX,
  CONTEXT_VALENCE_MIN,
  EVENT_TYPE_KEYS,
  LEISURE_CATEGORY_KEYS,
  WORK_STATUS_KEYS,
  contextSectionLabelKey,
  contextValueLabelKey,
} from "@/lib/mood/context-vocabulary";
import type { LinkedDayContext, LinkedFigure } from "@/lib/mood/linked-context";

const CONTEXT_NOTE_MAX_LENGTH = 500;

/** The context as the form holds it. `null` everywhere means unanswered. */
export interface MoodContextState {
  workStatus: string | null;
  workMinutes: number | null;
  overtimeMinutes: number | null;
  workLoad: number | null;
  workSatisfaction: number | null;
  contactCircles: string[];
  contactForm: string | null;
  contactExtent: string | null;
  contactQuality: number | null;
  contactSupport: number | null;
  leisureCategories: string[];
  leisureMinutes: number | null;
  leisureJoy: number | null;
  leisureRecovery: number | null;
  eventType: string | null;
  eventValence: number | null;
  /** Local `datetime-local` value, or "" for unanswered. */
  eventAt: string;
  note: string;
}

export const EMPTY_MOOD_CONTEXT: MoodContextState = {
  workStatus: null,
  workMinutes: null,
  overtimeMinutes: null,
  workLoad: null,
  workSatisfaction: null,
  contactCircles: [],
  contactForm: null,
  contactExtent: null,
  contactQuality: null,
  contactSupport: null,
  leisureCategories: [],
  leisureMinutes: null,
  leisureJoy: null,
  leisureRecovery: null,
  eventType: null,
  eventValence: null,
  eventAt: "",
  note: "",
};

/** Which state fields each section owns, so a badge counts its own section. */
const SECTION_FIELDS = {
  work: [
    "workStatus",
    "workMinutes",
    "overtimeMinutes",
    "workLoad",
    "workSatisfaction",
  ],
  contacts: [
    "contactCircles",
    "contactForm",
    "contactExtent",
    "contactQuality",
    "contactSupport",
  ],
  leisure: [
    "leisureCategories",
    "leisureMinutes",
    "leisureJoy",
    "leisureRecovery",
  ],
  events: ["eventType", "eventValence", "eventAt", "note"],
} as const satisfies Record<string, ReadonlyArray<keyof MoodContextState>>;

function isAnswered(value: MoodContextState[keyof MoodContextState]): boolean {
  if (value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

/** How many answers a section holds — the collapsed section's badge. */
export function contextSectionCount(
  state: MoodContextState,
  section: keyof typeof SECTION_FIELDS,
): number {
  return SECTION_FIELDS[section].filter((field) => isAnswered(state[field]))
    .length;
}

/** Does the whole context say anything at all? */
export function contextIsEmpty(state: MoodContextState): boolean {
  return (
    Object.keys(SECTION_FIELDS) as Array<keyof typeof SECTION_FIELDS>
  ).every((section) => contextSectionCount(state, section) === 0);
}

/**
 * The context as the API takes it.
 *
 * `null` when nothing was answered, which is how the write path is told to
 * store no row (and to remove one that is there). Not `undefined`: on the edit
 * path an omitted key means "leave it alone", and a person who cleared every
 * section means the opposite of that.
 */
export function moodContextPayload(
  state: MoodContextState,
): Record<string, unknown> | null {
  if (contextIsEmpty(state)) return null;
  return {
    workStatus: state.workStatus,
    workMinutes: state.workMinutes,
    overtimeMinutes: state.overtimeMinutes,
    workLoad: state.workLoad,
    workSatisfaction: state.workSatisfaction,
    contactCircles: state.contactCircles,
    contactForm: state.contactForm,
    contactExtent: state.contactExtent,
    contactQuality: state.contactQuality,
    contactSupport: state.contactSupport,
    leisureCategories: state.leisureCategories,
    leisureMinutes: state.leisureMinutes,
    leisureJoy: state.leisureJoy,
    leisureRecovery: state.leisureRecovery,
    eventType: state.eventType,
    eventValence: state.eventValence,
    eventAt: state.eventAt ? new Date(state.eventAt).toISOString() : null,
    note: state.note.trim() === "" ? null : state.note.trim(),
  };
}

/** Seed the form from an entry being edited. */
export function moodContextFromEntry(
  context:
    | (Partial<Omit<MoodContextState, "eventAt" | "note">> & {
        eventAt?: string | null;
        note?: string | null;
      })
    | null
    | undefined,
): MoodContextState {
  if (!context) return EMPTY_MOOD_CONTEXT;
  return {
    ...EMPTY_MOOD_CONTEXT,
    ...context,
    contactCircles: context.contactCircles ?? [],
    leisureCategories: context.leisureCategories ?? [],
    // The wire carries an ISO instant; the control wants a local wall clock.
    eventAt: context.eventAt ? toLocalInputValue(context.eventAt) : "",
    note: context.note ?? "",
  };
}

function toLocalInputValue(iso: string): string {
  const at = new Date(iso);
  const local = new Date(at.getTime() - at.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

/** A selectable chip. Tapping the selected one again takes the answer back. */
function ChoiceChip({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      data-slot="mood-context-choice"
      className={`inline-flex min-h-11 items-center rounded-full border px-3 py-2 text-xs transition-colors ${
        selected
          ? "border-primary bg-primary/15 text-primary"
          : "border-border/70 bg-muted text-foreground/75 hover:bg-accent hover:text-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function ChoiceRow({
  label,
  field,
  keys,
  value,
  onChange,
}: {
  label: string;
  field: string;
  keys: readonly string[];
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="space-y-2">
      <Label className="text-muted-foreground text-xs font-normal">
        {label}
      </Label>
      <div className="flex flex-wrap gap-1.5">
        {keys.map((key) => (
          <ChoiceChip
            key={key}
            label={t(contextValueLabelKey(field, key))}
            selected={value === key}
            onClick={() => onChange(value === key ? null : key)}
          />
        ))}
      </div>
    </div>
  );
}

function MultiChoiceRow({
  label,
  field,
  keys,
  value,
  onChange,
}: {
  label: string;
  field: string;
  keys: readonly string[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="space-y-2">
      <Label className="text-muted-foreground text-xs font-normal">
        {label}
      </Label>
      <div className="flex flex-wrap gap-1.5">
        {keys.map((key) => (
          <ChoiceChip
            key={key}
            label={t(contextValueLabelKey(field, key))}
            selected={value.includes(key)}
            onClick={() =>
              onChange(
                value.includes(key)
                  ? value.filter((k) => k !== key)
                  : [...value, key],
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function MinutesField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  const { t } = useTranslations();
  return (
    <FieldGroup htmlFor={id} label={label}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={CONTEXT_MINUTES_MIN}
        max={CONTEXT_MINUTES_MAX}
        step={5}
        value={value === null ? "" : String(value)}
        placeholder={t("mood.dayContext.minutesPlaceholder")}
        onChange={(e) => {
          const raw = e.target.value;
          // An emptied field is an unanswered field, not a zero. Zero minutes
          // is a real answer somebody can still type.
          onChange(raw === "" ? null : Number(raw));
        }}
      />
    </FieldGroup>
  );
}

/** One 0-10 rating with its two anchors, resolved from the vocabulary. */
function ContextRating({
  field,
  value,
  onChange,
}: {
  field: string;
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  const { t } = useTranslations();
  const low = t(`mood.context.rating.${field}.low`);
  const high = t(`mood.context.rating.${field}.high`);
  return (
    <SliderField
      label={t(contextValueLabelKey("field", field))}
      value={value}
      min={CONTEXT_RATING_MIN}
      max={CONTEXT_RATING_MAX}
      step={1}
      lowAnchor={low}
      highAnchor={high}
      emptyLabel={t("mood.dimensionNotAnswered")}
      valueText={
        value === null
          ? undefined
          : t("mood.dimensionValueText", {
              value,
              max: CONTEXT_RATING_MAX,
              low,
              high,
            })
      }
      clearLabel={t("mood.dimensionClear")}
      onClear={() => onChange(null)}
      onValueChange={onChange}
    />
  );
}

interface MoodContextSectionsProps {
  value: MoodContextState;
  onChange: (next: MoodContextState) => void;
}

export function MoodContextSections({
  value,
  onChange,
}: MoodContextSectionsProps) {
  const { t } = useTranslations();
  const set = <K extends keyof MoodContextState>(
    key: K,
    next: MoodContextState[K],
  ) => onChange({ ...value, [key]: next });

  return (
    <>
      <SheetSection
        title={t(contextSectionLabelKey("work"))}
        icon={<Briefcase />}
        summary={
          <SheetSectionCount count={contextSectionCount(value, "work")} />
        }
      >
        <div className="space-y-4" data-slot="mood-context-work">
          <ChoiceRow
            label={t(contextValueLabelKey("field", "workStatus"))}
            field="workStatus"
            keys={WORK_STATUS_KEYS}
            value={value.workStatus}
            onChange={(next) => set("workStatus", next)}
          />
          <MinutesField
            id="mood-context-work-minutes"
            label={t(contextValueLabelKey("field", "workMinutes"))}
            value={value.workMinutes}
            onChange={(next) => set("workMinutes", next)}
          />
          <MinutesField
            id="mood-context-overtime-minutes"
            label={t(contextValueLabelKey("field", "overtimeMinutes"))}
            value={value.overtimeMinutes}
            onChange={(next) => set("overtimeMinutes", next)}
          />
          <ContextRating
            field="workLoad"
            value={value.workLoad}
            onChange={(next) => set("workLoad", next)}
          />
          <ContextRating
            field="workSatisfaction"
            value={value.workSatisfaction}
            onChange={(next) => set("workSatisfaction", next)}
          />
        </div>
      </SheetSection>

      <SheetSection
        title={t(contextSectionLabelKey("contacts"))}
        icon={<Users />}
        summary={
          <SheetSectionCount count={contextSectionCount(value, "contacts")} />
        }
      >
        <div className="space-y-4" data-slot="mood-context-contacts">
          <p className="text-muted-foreground text-xs">
            {t("mood.dayContext.contactsHelp")}
          </p>
          <MultiChoiceRow
            label={t(contextValueLabelKey("field", "contactCircles"))}
            field="contactCircles"
            keys={CONTACT_CIRCLE_KEYS}
            value={value.contactCircles}
            onChange={(next) => set("contactCircles", next)}
          />
          <ChoiceRow
            label={t(contextValueLabelKey("field", "contactForm"))}
            field="contactForm"
            keys={CONTACT_FORM_KEYS}
            value={value.contactForm}
            onChange={(next) => set("contactForm", next)}
          />
          <ChoiceRow
            label={t(contextValueLabelKey("field", "contactExtent"))}
            field="contactExtent"
            keys={CONTACT_EXTENT_KEYS}
            value={value.contactExtent}
            onChange={(next) => set("contactExtent", next)}
          />
          <ContextRating
            field="contactQuality"
            value={value.contactQuality}
            onChange={(next) => set("contactQuality", next)}
          />
          <ContextRating
            field="contactSupport"
            value={value.contactSupport}
            onChange={(next) => set("contactSupport", next)}
          />
        </div>
      </SheetSection>

      <SheetSection
        title={t(contextSectionLabelKey("leisure"))}
        icon={<Palmtree />}
        summary={
          <SheetSectionCount count={contextSectionCount(value, "leisure")} />
        }
      >
        <div className="space-y-4" data-slot="mood-context-leisure">
          <MultiChoiceRow
            label={t(contextValueLabelKey("field", "leisureCategories"))}
            field="leisureCategories"
            keys={LEISURE_CATEGORY_KEYS}
            value={value.leisureCategories}
            onChange={(next) => set("leisureCategories", next)}
          />
          <MinutesField
            id="mood-context-leisure-minutes"
            label={t(contextValueLabelKey("field", "leisureMinutes"))}
            value={value.leisureMinutes}
            onChange={(next) => set("leisureMinutes", next)}
          />
          <ContextRating
            field="leisureJoy"
            value={value.leisureJoy}
            onChange={(next) => set("leisureJoy", next)}
          />
          <ContextRating
            field="leisureRecovery"
            value={value.leisureRecovery}
            onChange={(next) => set("leisureRecovery", next)}
          />
        </div>
      </SheetSection>

      <SheetSection
        title={t(contextSectionLabelKey("events"))}
        icon={<CalendarClock />}
        summary={
          <SheetSectionCount count={contextSectionCount(value, "events")} />
        }
      >
        <div className="space-y-4" data-slot="mood-context-events">
          <ChoiceRow
            label={t(contextValueLabelKey("field", "eventType"))}
            field="eventType"
            keys={EVENT_TYPE_KEYS}
            value={value.eventType}
            onChange={(next) => set("eventType", next)}
          />
          <SliderField
            label={t(contextValueLabelKey("field", "eventValence"))}
            value={value.eventValence}
            min={CONTEXT_VALENCE_MIN}
            max={CONTEXT_VALENCE_MAX}
            step={1}
            lowAnchor={t("mood.context.rating.eventValence.low")}
            highAnchor={t("mood.context.rating.eventValence.high")}
            emptyLabel={t("mood.dimensionNotAnswered")}
            clearLabel={t("mood.dimensionClear")}
            onClear={() => set("eventValence", null)}
            onValueChange={(next) => set("eventValence", next)}
          />
          <FieldGroup
            htmlFor="mood-context-event-at"
            label={t(contextValueLabelKey("field", "eventAt"))}
          >
            <DateTimeField
              id="mood-context-event-at"
              value={value.eventAt}
              onChange={(next) => set("eventAt", next)}
            />
          </FieldGroup>
          <FieldGroup
            htmlFor="mood-context-note"
            label={t(contextValueLabelKey("field", "notes"))}
          >
            <Textarea
              id="mood-context-note"
              value={value.note}
              onChange={(e) => set("note", e.target.value)}
              placeholder={t("mood.dayContext.notePlaceholder")}
              maxLength={CONTEXT_NOTE_MAX_LENGTH}
              rows={3}
            />
          </FieldGroup>
        </div>
      </SheetSection>
    </>
  );
}

function formatFigure(
  figure: LinkedFigure | undefined,
  notRecorded: string,
): string {
  if (!figure || !figure.present) return notRecorded;
  return `${figure.value} ${figure.unit}`;
}

/**
 * The read-only block: what the other modules already hold for this day.
 *
 * Every row names where its number comes from and offers a way in to change it
 * there. A block whose module is switched off is not rendered at all — not
 * zeroed, not greyed out — because turning a module off is a statement about
 * what somebody wants to see.
 */
export function MoodLinkedDaySection({
  linked,
}: {
  linked: LinkedDayContext | null;
}) {
  const { t } = useTranslations();
  const notRecorded = t("mood.dayContext.notRecorded");

  const rows = useMemo(() => {
    if (!linked) return [];
    const out: Array<{ label: string; value: string; href: string }> = [];
    if (linked.sleep.available) {
      out.push({
        label: t("mood.dayContext.linkedSleep"),
        value: formatFigure(linked.sleep.asleep, notRecorded),
        href: "/insights/sleep",
      });
      out.push({
        label: t("mood.dayContext.linkedInBed"),
        value: formatFigure(linked.sleep.inBed, notRecorded),
        href: "/insights/sleep",
      });
    }
    if (linked.activity.available) {
      out.push({
        label: t("mood.dayContext.linkedSteps"),
        value: formatFigure(linked.activity.steps, notRecorded),
        href: "/insights/steps",
      });
      out.push({
        label: t("mood.dayContext.linkedActiveEnergy"),
        value: formatFigure(linked.activity.activeEnergy, notRecorded),
        href: "/insights/steps",
      });
    }
    if (linked.vitals.available) {
      out.push({
        label: t("mood.dayContext.linkedRestingHeartRate"),
        value: formatFigure(linked.vitals.restingHeartRate, notRecorded),
        href: "/measurements",
      });
      out.push({
        label: t("mood.dayContext.linkedHrv"),
        value: formatFigure(linked.vitals.heartRateVariability, notRecorded),
        href: "/measurements",
      });
    }
    return out;
  }, [linked, notRecorded, t]);

  if (!linked) return null;

  const bodyLine = linked.body.available
    ? linked.body.logged
      ? t("mood.dayContext.bodyLogged", {
          count: String(linked.body.symptoms.length),
        })
      : t("mood.dayContext.bodyNotLogged")
    : null;

  return (
    <SheetSection
      title={t("mood.dayContext.linkedTitle")}
      icon={<Link2 />}
      summary={<SheetSectionCount count={rows.length} />}
    >
      <div className="space-y-3" data-slot="mood-linked-day">
        <p className="text-muted-foreground text-xs">
          {t("mood.dayContext.linkedHelp")}
        </p>
        <dl className="space-y-1.5">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex items-center justify-between gap-3"
            >
              <dt className="text-muted-foreground text-xs">{row.label}</dt>
              <dd className="text-foreground text-sm tabular-nums">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        {bodyLine ? (
          <div className="border-border/60 flex items-center justify-between gap-3 border-t pt-3">
            <span className="text-muted-foreground text-xs">
              <Activity className="mr-1 inline h-3 w-3" aria-hidden="true" />
              {bodyLine}
            </span>
            <a
              href={
                linked.body.available && linked.body.episodeId
                  ? `/illness/${linked.body.episodeId}`
                  : "/illness"
              }
              className="text-primary text-xs underline underline-offset-2"
            >
              {t("mood.dayContext.openIllness")}
            </a>
          </div>
        ) : null}
      </div>
    </SheetSection>
  );
}
