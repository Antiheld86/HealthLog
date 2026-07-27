/**
 * v1.27.13 (Welle J) — the interpretation-context registry.
 *
 * The per-metric assessment prompt used to hand the model a coarse
 * single-edge `normalRange` and the personal baseline, and nothing that says
 * what a value MEANS on a clinical scale. So the prose recited counts and a
 * trend adjective ("slightly rising") without ever placing the value: is a
 * visceral-fat rating of 2.7 good? Where does it sit? What follows?
 *
 * This module is the hand-curated answer: a typed registry mapping a metric to
 * the guideline INTERPRETATION BANDS the knowledge base
 * (`~/Projects/health-knowledge-base`, vendor-blind, guideline-cited) actually
 * carries — band edges, plain labels, a favourable/neutral/caution/unfavourable
 * valence, the direction a good value moves, and a short source tag. Every
 * entry cites the KB file + section it was derived from in a comment; NO
 * threshold is invented. A metric the KB gives no numeric band for has NO
 * entry here — its assessment then stays purely personal-relative (fail-soft),
 * which is the honest posture the KB itself takes for those metrics.
 *
 * The registry feeds two things:
 *   1. `buildInterpretationBlock` (prompts/interpretation-block.ts) renders the
 *      computed band position + table into the per-metric user prompt.
 *   2. `interpretationBandEdges` yields the band-edge numbers so any surface
 *      with a numeric grounding gate can allow-list a quoted guideline
 *      threshold (the v1.25.13 class of bug: an unlisted number strips text).
 *
 * The band position is computed HERE, server-side — never left to the model.
 */

import { binaryReferenceSex, type BinaryReferenceSex } from "@/lib/profile/sex";

/** How a band reads against health: the four-way valence the prose leans on. */
export type BandValence = "favourable" | "neutral" | "caution" | "unfavourable";

/**
 * One guideline band. `upTo` is the EXCLUSIVE upper edge in the metric's unit;
 * the last band in an ascending list carries `upTo: null` ("and above"). A
 * value belongs to the first band whose `upTo` it is strictly below.
 */
export interface InterpretationBand {
  upTo: number | null;
  /** Plain-language label ("healthy", "increased risk", "obesity class I"). */
  label: string;
  valence: BandValence;
}

/** Which direction a favourable value moves. */
export type DirectionOfGood = "lower" | "higher" | "target";

export interface MetricInterpretation {
  /** The unit the band edges are expressed in. */
  unit: string;
  directionOfGood: DirectionOfGood;
  /** Short guideline/source tag, e.g. "WHO 2000". */
  source: string;
  /** Ascending bands when the metric is not sex-split. */
  bands?: InterpretationBand[];
  /** Sex-split bands; used only when the profile carries the sex. */
  sexBands?: Record<BinaryReferenceSex, InterpretationBand[]>;
  /**
   * Optional honesty caveat surfaced in the prompt block — used where the KB
   * hedges the edges (consumer rating scales, proxy measurements).
   */
  caveat?: string;
}

/**
 * The registry. Keys are the generic metric ids (`MetricStatusMetricId`) plus
 * the specialised `"BMI"` scope, so both the generic archetype path and a
 * future BMI-card wiring resolve from one table. A metric absent here has no
 * guideline band and stays personal-relative.
 *
 * Bands are ascending; edges are the KB's stated guideline thresholds. Where
 * the KB gives a range like "normal 35.7–37.4", the band's `upTo` is the next
 * band's floor (so the normal band runs up to the fever line), keeping the
 * partition total and gap-free.
 */
const INTERPRETATION_REGISTRY: Record<string, MetricInterpretation> = {
  // Visceral fat — the maintainer's headline example. KB:
  // metrics/body-composition.md → "### Visceral fat", consumer unitless rating
  // scale (~1–59): ≈1–12 healthy, ≈13+ elevated ("by common convention"; the
  // rating is NOT a cm² value). Lower is better.
  VISCERAL_FAT: {
    unit: "rating",
    directionOfGood: "lower",
    source: "consumer rating convention",
    bands: [
      { upTo: 13, label: "healthy", valence: "favourable" },
      { upTo: null, label: "elevated", valence: "caution" },
    ],
    caveat:
      "This is the consumer 1–59 rating scale (by common convention, not a formal guideline cut-off), not a cm² area.",
  },

  // Resting heart rate — KB: metrics/resting-heart-rate.md → "## Reference
  // ranges". Normal adult resting 60–100 bpm (AHA 2024); 40–60 bpm is benign
  // in endurance athletes; sustained > 100 resting is tachycardia. Lower is
  // generally more favourable within physiologic limits.
  RESTING_HEART_RATE: {
    unit: "bpm",
    directionOfGood: "lower",
    source: "AHA 2024",
    bands: [
      {
        upTo: 60,
        label: "below the standard resting range (common in trained hearts)",
        valence: "neutral",
      },
      { upTo: 100, label: "the standard resting range", valence: "favourable" },
      {
        upTo: null,
        label: "above the standard resting range",
        valence: "caution",
      },
    ],
  },

  // Blood oxygen (SpO₂) — KB: metrics/spo2.md → "## Reference ranges". Healthy
  // room-air 95–100%; 91–94% mild hypoxaemia; < 90% clinically significant.
  // Higher is better but with a ceiling (above ~98% adds no benefit).
  OXYGEN_SATURATION: {
    unit: "%",
    directionOfGood: "higher",
    source: "StatPearls/NIH 2023",
    bands: [
      {
        upTo: 90,
        label: "clinically significant low oxygen",
        valence: "unfavourable",
      },
      { upTo: 95, label: "mildly low", valence: "caution" },
      { upTo: null, label: "the healthy range", valence: "favourable" },
    ],
  },

  // Respiratory rate — KB: metrics/respiratory-rate.md → "## Reference ranges".
  // Normal resting adult 12–20 breaths/min; > 20 tachypnoea; < 12 bradypnoea.
  // Target-band: both extremes are less favourable.
  RESPIRATORY_RATE: {
    unit: "breaths/min",
    directionOfGood: "target",
    source: "American Lung Association; StatPearls/NIH 2023",
    bands: [
      {
        upTo: 12,
        label: "below the normal resting range",
        valence: "caution",
      },
      { upTo: 20, label: "the normal resting range", valence: "favourable" },
      {
        upTo: null,
        label: "above the normal resting range",
        valence: "caution",
      },
    ],
  },

  // Body temperature — KB: metrics/temperature.md → "## Reference ranges".
  // Normal oral range ~35.7–37.4 °C (mean 36.6); fever (oral) ≥ 38.0 °C. The
  // fever edge is the canonical FEVER_BAND_C so the band and the illness
  // engine's escalation stay one intentional pair; the 37.5 sub-edge marks the
  // borderline zone below the fever line. Sites differ by up to ~1 °C, so the
  // read is a coarse placement.
  BODY_TEMPERATURE: {
    unit: "°C",
    directionOfGood: "target",
    source: "J Gen Intern Med systematic review 2019; CDC",
    bands: [
      { upTo: 35.7, label: "below the normal range", valence: "caution" },
      { upTo: 37.5, label: "the normal range", valence: "favourable" },
      { upTo: 38, label: "borderline / low-grade", valence: "caution" },
      { upTo: null, label: "fever range", valence: "unfavourable" },
    ],
  },

  // Sleep duration — KB: metrics/sleep.md → "### Duration by age". Adult
  // (18–64) recommended 7–9 h/night (NSF 2015; AASM & SRS 2015). Stored in
  // MINUTES here (420–540). Target-band (U-shaped risk).
  SLEEP_DURATION: {
    unit: "min",
    directionOfGood: "target",
    source: "NSF 2015; AASM/SRS 2015",
    bands: [
      {
        upTo: 420,
        label: "below the recommended adult range",
        valence: "caution",
      },
      {
        upTo: 540,
        label: "the recommended adult range",
        valence: "favourable",
      },
      {
        upTo: null,
        label: "above the recommended adult range",
        valence: "neutral",
      },
    ],
  },

  // Waist circumference — KB: metrics/weight-bmi.md → "### Waist circumference
  // and ratios (European-origin populations)". Sex-specific: men > 94 cm
  // increased risk, > 102 cm substantially increased; women > 80 cm / > 88 cm
  // (WHO 2008/2011; NIH/NHLBI 1998). Lower is better. Requires profile sex.
  WAIST_CIRCUMFERENCE: {
    unit: "cm",
    directionOfGood: "lower",
    source: "WHO 2008/2011; NIH/NHLBI 1998",
    sexBands: {
      MALE: [
        {
          upTo: 94,
          label: "below the increased-risk threshold",
          valence: "favourable",
        },
        { upTo: 102, label: "increased risk", valence: "caution" },
        {
          upTo: null,
          label: "substantially increased risk",
          valence: "unfavourable",
        },
      ],
      FEMALE: [
        {
          upTo: 80,
          label: "below the increased-risk threshold",
          valence: "favourable",
        },
        { upTo: 88, label: "increased risk", valence: "caution" },
        {
          upTo: null,
          label: "substantially increased risk",
          valence: "unfavourable",
        },
      ],
    },
  },

  // Waist-to-height ratio — KB: metrics/weight-bmi.md → same section. WHtR
  // ≥ 0.5 flags increased risk in both sexes (NICE). Lower is better.
  WAIST_TO_HEIGHT: {
    unit: "ratio",
    directionOfGood: "lower",
    source: "NICE",
    bands: [
      {
        upTo: 0.5,
        label: "below the increased-risk threshold",
        valence: "favourable",
      },
      { upTo: null, label: "increased risk", valence: "caution" },
    ],
  },

  // Pulse-wave velocity — KB: metrics/blood-pressure.md → derived support
  // signals. cf-PWV > 10 m/s is the European organ-damage marker (ESC/ESH
  // 2018). A consumer estimate is a PROXY, so this is a coarse "below 10 is the
  // reference side" placement only. Lower is better.
  PULSE_WAVE_VELOCITY: {
    unit: "m/s",
    directionOfGood: "lower",
    source: "ESC/ESH 2018",
    bands: [
      {
        upTo: 10,
        label: "below the arterial-stiffness reference threshold",
        valence: "favourable",
      },
      {
        upTo: null,
        label: "above the arterial-stiffness reference threshold",
        valence: "caution",
      },
    ],
    caveat:
      "A consumer PWV estimate is a proxy for clinical carotid-femoral PWV, not interchangeable with it.",
  },

  // BMI — KB: metrics/weight-bmi.md → "### BMI". WHO adult bands (WHO 2000).
  // Registered for the specialised BMI card + tests; target mid-range.
  BMI: {
    unit: "kg/m²",
    directionOfGood: "target",
    source: "WHO 2000",
    bands: [
      { upTo: 18.5, label: "underweight", valence: "caution" },
      { upTo: 25, label: "normal weight", valence: "favourable" },
      { upTo: 30, label: "overweight", valence: "caution" },
      { upTo: 35, label: "obesity class I", valence: "unfavourable" },
      { upTo: 40, label: "obesity class II", valence: "unfavourable" },
      { upTo: null, label: "obesity class III", valence: "unfavourable" },
    ],
  },
};

/**
 * Resolve the interpretation for a metric key, picking the sex-split bands when
 * the entry is sex-specific and a sex is known. Returns null when the metric
 * has no entry, OR when it needs a sex the profile does not carry (fail-soft to
 * personal-relative rather than guessing a sex).
 */
export function resolveInterpretation(
  metricKey: string,
  sex: BinaryReferenceSex | null | undefined,
): {
  unit: string;
  directionOfGood: DirectionOfGood;
  source: string;
  bands: InterpretationBand[];
  caveat?: string;
} | null {
  const entry = INTERPRETATION_REGISTRY[metricKey];
  if (!entry) return null;
  let bands: InterpretationBand[] | undefined = entry.bands;
  if (entry.sexBands) {
    const referenceSex = binaryReferenceSex(sex);
    if (!referenceSex) return null;
    bands = entry.sexBands[referenceSex];
  }
  if (!bands || bands.length === 0) return null;
  return {
    unit: entry.unit,
    directionOfGood: entry.directionOfGood,
    source: entry.source,
    bands,
    ...(entry.caveat ? { caveat: entry.caveat } : {}),
  };
}

/** Where a value sits, plus how close it is to a band boundary. */
export interface BandPosition {
  /** Index of the band in the ascending list. */
  index: number;
  band: InterpretationBand;
  /** Finite lower edge of the band (null when open-bottom). */
  lowerEdge: number | null;
  /** Finite upper edge of the band (null when open-top). */
  upperEdge: number | null;
  /** Whether the value sits centrally or hugs an edge — drives trend severity. */
  proximity: "central" | "near-lower-edge" | "near-upper-edge";
  /** The nearest finite band boundary, when one exists. */
  nearestEdge: number | null;
}

/**
 * Classify a value against an ascending band list. Uses a strict `<` on each
 * `upTo`, so a value exactly on an edge falls into the HIGHER band (25.0 is
 * overweight, not normal — matching the WHO convention). Proximity flags an
 * edge-hugging value (within 20% of the band's finite width, or within 15% of
 * an open band's single finite edge) so the prompt can escalate a trend that
 * approaches a boundary.
 */
export function classifyBandPosition(
  value: number,
  bands: InterpretationBand[],
): BandPosition {
  let index = bands.findIndex((b) => b.upTo !== null && value < b.upTo);
  if (index === -1) index = bands.length - 1;
  const band = bands[index];
  const lowerEdge = index > 0 ? bands[index - 1].upTo : null;
  const upperEdge = band.upTo;

  let proximity: BandPosition["proximity"] = "central";
  let nearestEdge: number | null = null;

  if (lowerEdge !== null && upperEdge !== null) {
    const width = upperEdge - lowerEdge;
    const margin = width * 0.2;
    const distLower = value - lowerEdge;
    const distUpper = upperEdge - value;
    if (distUpper <= distLower && distUpper <= margin) {
      proximity = "near-upper-edge";
      nearestEdge = upperEdge;
    } else if (distLower < distUpper && distLower <= margin) {
      proximity = "near-lower-edge";
      nearestEdge = lowerEdge;
    } else {
      nearestEdge = distUpper <= distLower ? upperEdge : lowerEdge;
    }
  } else if (upperEdge !== null) {
    nearestEdge = upperEdge;
    if (upperEdge !== 0 && (upperEdge - value) / Math.abs(upperEdge) <= 0.15) {
      proximity = "near-upper-edge";
    }
  } else if (lowerEdge !== null) {
    nearestEdge = lowerEdge;
    if (lowerEdge !== 0 && (value - lowerEdge) / Math.abs(lowerEdge) <= 0.15) {
      proximity = "near-lower-edge";
    }
  }

  return { index, band, lowerEdge, upperEdge, proximity, nearestEdge };
}

/**
 * Every finite band edge for a metric, for a numeric grounding allow-set. A
 * surface that injects the interpretation block AND runs a number-grounding
 * gate must feed these into its allow-set so a quoted guideline threshold can
 * never strip the assessment. Returns [] for an uncovered metric.
 */
export function interpretationBandEdges(
  metricKey: string,
  sex?: BinaryReferenceSex | null,
): number[] {
  const resolved = resolveInterpretation(metricKey, sex ?? null);
  if (!resolved) {
    // Sex-split metric with unknown sex: still surface the union of both sets
    // so a gate is complete even before a sex is known.
    const entry = INTERPRETATION_REGISTRY[metricKey];
    if (!entry?.sexBands) return [];
    const union = new Set<number>();
    for (const bands of Object.values(entry.sexBands)) {
      for (const b of bands) if (b.upTo !== null) union.add(b.upTo);
    }
    return [...union];
  }
  const edges = new Set<number>();
  for (const b of resolved.bands) if (b.upTo !== null) edges.add(b.upTo);
  return [...edges];
}
