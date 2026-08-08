"use client";

/**
 * The five level-A sliders, and the state rules around them.
 *
 * One component for both mood surfaces — the create sheet and the list's edit
 * dialog — because what one writes the other has to be able to show. A value a
 * user set on Monday and cannot see on Tuesday is worse than one they were
 * never offered.
 *
 * The section is closed by default and nothing in it is required. The five
 * faces above it remain a complete entry on their own: one tap still saves.
 */
import { Gauge } from "lucide-react";

import { SheetSection, SheetSectionCount } from "@/components/ui/sheet-section";
import { SliderField } from "@/components/ui/slider";
import { MOOD_DIMENSIONS } from "@/lib/mood/dimensions";
import { getA1ForMood } from "@/lib/validations/mood";
import { useTranslations } from "@/lib/i18n/context";

/** The five values as the form holds them. `null` means unanswered. */
export interface LevelAState {
  a1: number | null;
  a2: number | null;
  a3: number | null;
  a4: number | null;
  a5: number | null;
}

export const EMPTY_LEVEL_A: LevelAState = {
  a1: null,
  a2: null,
  a3: null,
  a4: null,
  a5: null,
};

/** How many of the five carry an answer — the collapsed section's badge. */
export function levelAAnsweredCount(state: LevelAState): number {
  return MOOD_DIMENSIONS.filter((d) => state[d.key] !== null).length;
}

/**
 * The five values as the API takes them, with the unanswered ones left out.
 *
 * Omitted rather than sent as null on the create path: absent means "nothing
 * to say", and the server writes NULL for it. Nothing here ever sends a
 * default, which is the whole reason the columns are nullable.
 */
export function levelACreatePayload(
  state: LevelAState,
): Partial<Record<keyof LevelAState, number>> {
  const out: Partial<Record<keyof LevelAState, number>> = {};
  for (const dimension of MOOD_DIMENSIONS) {
    const value = state[dimension.key];
    if (value !== null) out[dimension.key] = value;
  }
  return out;
}

/**
 * The five values as the edit path takes them — nulls included.
 *
 * The edit path replaces rather than adds, so a value the user cleared has to
 * travel as an explicit null. Sending nothing would leave the old answer in
 * place and the dialog would lie about what it just saved.
 */
export function levelAUpdatePayload(state: LevelAState): LevelAState {
  return { ...state };
}

/**
 * Seed the state from an entry being edited.
 *
 * The reader is the API's own wire shape, so a row that has never carried
 * these values arrives as `undefined` and lands as `null` — unanswered, which
 * is what it is.
 */
export function levelAFromEntry(entry: {
  a1?: number | null;
  a2?: number | null;
  a3?: number | null;
  a4?: number | null;
  a5?: number | null;
}): LevelAState {
  return {
    a1: entry.a1 ?? null,
    a2: entry.a2 ?? null,
    a3: entry.a3 ?? null,
    a4: entry.a4 ?? null,
    a5: entry.a5 ?? null,
  };
}

/**
 * Re-seed pleasantness from a freshly picked face — but only while the user
 * has not moved that slider themselves.
 *
 * This is the one interaction in the sheet that will confuse a later reader,
 * so it is written down here rather than inferred from two call sites: picking
 * a face suggests a pleasantness value, and moving the slider takes the
 * suggestion over. After that the faces and the slider are independent, and in
 * particular moving the slider never changes which face is lit — the two are
 * different questions at different resolutions, not two views of one answer.
 */
export function seedA1FromMood(
  state: LevelAState,
  mood: string,
  a1Touched: boolean,
): LevelAState {
  if (a1Touched) return state;
  return { ...state, a1: mood ? getA1ForMood(mood) : null };
}

interface MoodLevelASectionProps {
  value: LevelAState;
  onChange: (next: LevelAState) => void;
  /** Called when the user moves pleasantness themselves, which ends the re-seeding. */
  onA1Touched?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function MoodLevelASection({
  value,
  onChange,
  onA1Touched,
  open,
  onOpenChange,
}: MoodLevelASectionProps) {
  const { t } = useTranslations();

  return (
    <SheetSection
      title={t("mood.sectionLevelA")}
      icon={<Gauge />}
      open={open}
      onOpenChange={onOpenChange}
      summary={<SheetSectionCount count={levelAAnsweredCount(value)} />}
    >
      <div className="space-y-4" data-slot="mood-level-a">
        <p className="text-muted-foreground text-xs">
          {t("mood.sectionLevelAHelp")}
        </p>
        {MOOD_DIMENSIONS.map((dimension) => {
          const current = value[dimension.key];
          const low = t(dimension.lowAnchorKey);
          const high = t(dimension.highAnchorKey);
          return (
            <SliderField
              key={dimension.key}
              label={t(dimension.labelKey)}
              value={current}
              min={dimension.min}
              max={dimension.max}
              step={1}
              lowAnchor={low}
              highAnchor={high}
              emptyLabel={t("mood.dimensionNotAnswered")}
              valueText={
                current === null
                  ? undefined
                  : t("mood.dimensionValueText", {
                      value: current,
                      max: dimension.max,
                      low,
                      high,
                    })
              }
              clearLabel={t("mood.dimensionClear")}
              // Pleasantness has no clear control, and that is the same rule
              // the server keeps: an entry always carries a five-point label,
              // so it always implies a pleasantness value, and there is no
              // state in which the field is honestly unanswered. Offering a
              // control that the write path would immediately undo would be a
              // button that quietly does nothing. The other four are genuinely
              // optional and keep theirs.
              onClear={
                dimension.key === "a1"
                  ? undefined
                  : () => onChange({ ...value, [dimension.key]: null })
              }
              onValueChange={(next) => {
                if (dimension.key === "a1") onA1Touched?.();
                onChange({ ...value, [dimension.key]: next });
              }}
            />
          );
        })}
      </div>
    </SheetSection>
  );
}
