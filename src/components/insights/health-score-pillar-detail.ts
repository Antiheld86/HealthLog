import { convertGlucose, type GlucoseUnit } from "@/lib/glucose";
import type {
  PillarReference,
  ScorePillarResult,
} from "@/lib/analytics/score/types";

/**
 * Pillar display formatting for the Health Score card.
 *
 * The card renders one observed line per scored pillar and hides the
 * reference band, the personal target and the source behind the cell's info
 * popover. A Radix popover only mounts its body once it is opened, so keeping
 * that formatting inside the component would put the account-unit conversion
 * (fasting glucose in mg/dL vs mmol/L) beyond the reach of a render test.
 * These are pure functions over the report DTO plus the caller's translator,
 * so both the card and the tests read the exact same strings.
 *
 * Client-safe: the score types and the glucose conversion are both pure.
 */

export type Translate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export interface PillarDetailContext {
  t: Translate;
  /** Account glucose unit; the fasting pillar is converted into it. */
  glucoseUnit: GlucoseUnit;
}

function referenceKindText(reference: PillarReference, t: Translate): string {
  return t(
    `insights.healthScore.referenceKind.${
      reference.kind === "clinical-threshold"
        ? "clinical"
        : reference.kind === "population-percentile"
          ? "population"
          : "guideline"
    }`,
  );
}

function formatReference(
  reference: PillarReference,
  label: string,
  t: Translate,
  source = reference.source,
): string {
  return t("insights.healthScore.referenceDetail", {
    label,
    source,
    kind: referenceKindText(reference, t),
    low: reference.low ?? t("insights.healthScore.openBound"),
    high: reference.high ?? t("insights.healthScore.openBound"),
  });
}

/** The one always-visible line: what was actually measured. */
export function pillarObservedText(
  pillar: ScorePillarResult,
  { t, glucoseUnit }: PillarDetailContext,
): string {
  if (pillar.result.status !== "ok") return "";
  const observed = pillar.result.value.observed;
  if (pillar.id === "GLYCAEMIA" && observed.unit === "mg/dL") {
    return t("insights.healthScore.fastingObserved", {
      value: convertGlucose(observed.value, glucoseUnit),
      unit: glucoseUnit,
    });
  }
  if (pillar.id === "ACTIVITY") {
    return t("insights.healthScore.observedActivity", {
      value: observed.value,
    });
  }
  if (pillar.id === "SLEEP") {
    return t("insights.healthScore.observedSleep", { value: observed.value });
  }
  if (pillar.id === "ADIPOSITY") {
    return t("insights.healthScore.observedAdiposity", {
      value: observed.value,
    });
  }
  if (pillar.id === "FITNESS") {
    return t("insights.healthScore.observedFitness", {
      value: observed.value,
      unit: observed.unit,
    });
  }
  return observed.label;
}

/** The scored reference band, already converted into the account unit. */
function pillarReferenceText(
  pillar: ScorePillarResult,
  { t, glucoseUnit }: PillarDetailContext,
): string {
  if (pillar.result.status !== "ok") return "";
  const value = pillar.result.value;
  const reference = value.reference;
  if (pillar.id === "GLYCAEMIA" && value.observed.unit === "mg/dL") {
    const low =
      reference.low == null ? null : convertGlucose(reference.low, glucoseUnit);
    const high =
      reference.high == null
        ? null
        : convertGlucose(reference.high, glucoseUnit);
    return formatReference(
      { ...reference, low, high },
      t("insights.healthScore.fastingReference", {
        low: low ?? "",
        high: high ?? "",
        unit: glucoseUnit,
      }),
      t,
    );
  }
  const label =
    pillar.id === "ACTIVITY"
      ? t("insights.healthScore.referenceActivity", {
          high: reference.high ?? "",
        })
      : pillar.id === "SLEEP"
        ? t("insights.healthScore.referenceSleep", {
            low: reference.low ?? "",
          })
        : pillar.id === "ADIPOSITY"
          ? t("insights.healthScore.referenceAdiposity", {
              high: reference.high ?? "",
            })
          : pillar.id === "FITNESS"
            ? t("insights.healthScore.referenceFitness", {
                low: reference.low ?? "",
                high: reference.high ?? "",
                unit: value.observed.unit,
              })
            : pillar.id === "GLYCAEMIA"
              ? t("insights.healthScore.referenceHba1c", {
                  low: reference.low ?? "",
                  high: reference.high ?? "",
                })
              : reference.label;
  return formatReference(
    reference,
    label,
    t,
    pillar.id === "LIPIDS"
      ? t("insights.healthScore.laboratoryReferenceSource")
      : reference.source,
  );
}

/**
 * The lines behind the cell's info popover: the scored reference, the
 * user-authored target when one exists, and the source with its as-of date.
 * Ordered as they render; an absent personal target contributes no line
 * rather than an empty one.
 */
export function pillarDetailLines(
  pillar: ScorePillarResult,
  ctx: PillarDetailContext,
): string[] {
  if (pillar.result.status !== "ok") return [];
  const { t } = ctx;
  const value = pillar.result.value;
  const lines = [
    t("insights.healthScore.reference", {
      value: pillarReferenceText(pillar, ctx),
    }),
  ];
  if (value.personalReference) {
    lines.push(
      t("insights.healthScore.personalReference", {
        value: formatReference(
          value.personalReference,
          value.personalReference.label,
          t,
          t("insights.healthScore.personalTargetSource"),
        ),
      }),
    );
  }
  lines.push(
    t("insights.healthScore.source", {
      source:
        value.observed.sources.join(", ") || pillar.result.provenance.source,
      date: value.observed.asOf,
    }),
  );
  return lines;
}
