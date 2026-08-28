import { describe, it, expect } from "vitest";

import {
  screenModelOutput,
  CONVERSATIONAL_CONTRACTS,
  INSIGHTS_CONTRACTS,
} from "@/lib/ai/safety/outbound-screen";
import { locales, type Locale } from "@/lib/i18n/config";

/**
 * The whole point of threading locale is that fr / es / it / pl are enforced,
 * not just en / de. Every contract below is asserted in all six languages: a
 * violating sentence written in the reader's language must be caught, and an
 * ordinary sentence in that same language must pass untouched.
 */

// ── dose-prescription ────────────────────────────────────────────────────

const DOSE_VIOLATIONS: Record<Locale, string> = {
  en: "You should step up to 2.4 mg next week.",
  de: "Erhöhe auf 7,5 mg, sobald du dich daran gewöhnt hast.",
  fr: "Augmentez votre dose à 2,4 mg la semaine prochaine.",
  es: "Aumente su dosis a 2,4 mg la próxima semana.",
  it: "Aumenti la sua dose a 2,4 mg la prossima settimana.",
  pl: "Proszę zwiększyć dawkę do 2,4 mg w przyszłym tygodniu.",
  ko: "다음 주에 2.4mg으로 늘려 보세요.",
};

/**
 * Factual restatements of a CURRENT dose. The contracts explicitly permit
 * these, so a screen that flagged them would make the Coach useless on exactly
 * the topic users bring it.
 */
const DOSE_CLEAN: Record<Locale, string> = {
  en: "You're in week 3 on 7.5 mg, and your weight is tracking down.",
  de: "Du bist in Woche 3 bei 7,5 mg, und dein Gewicht geht zurück.",
  fr: "Vous êtes en semaine 3 à 7,5 mg, et votre poids diminue.",
  es: "Está en la semana 3 con 7,5 mg, y su peso está bajando.",
  it: "È alla settimana 3 con 7,5 mg, e il suo peso sta calando.",
  pl: "Jest Pan w 3. tygodniu na 7,5 mg, a waga spada.",
  ko: "3주째 7.5mg을 복용 중이고, 체중은 내려가고 있어요.",
};

describe("screenModelOutput — dose-prescription, all six locales", () => {
  for (const locale of locales) {
    it(`blocks a dose-change imperative in ${locale}`, () => {
      const d = screenModelOutput(
        DOSE_VIOLATIONS[locale],
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(true);
      expect(d.reason).toBe("dose_prescription");
    });

    it(`passes a factual dose restatement in ${locale}`, () => {
      const d = screenModelOutput(
        DOSE_CLEAN[locale],
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(false);
      expect(d.reason).toBeNull();
    });
  }
});

// ── risk-score fabrication ───────────────────────────────────────────────

const RISK_VIOLATIONS: Record<Locale, string> = {
  en: "Your 10-year cardiovascular risk is about 12%.",
  de: "Dein Risiko liegt bei etwa 14%.",
  fr: "Votre risque est d'environ 12%.",
  es: "Su riesgo es del 12%.",
  it: "Il suo rischio è del 12%.",
  pl: "Pana ryzyko wynosi 12%.",
  ko: "10년 심혈관 위험도는 약 12%예요.",
};

/** A plain percentage that is NOT a clinical risk claim must pass. */
const RISK_CLEAN: Record<Locale, string> = {
  en: "Your adherence was 92% over the last 30 days.",
  de: "Deine Einnahmetreue lag bei 92% in den letzten 30 Tagen.",
  fr: "Votre observance était de 92% sur les 30 derniers jours.",
  es: "Su adherencia fue del 92% en los últimos 30 días.",
  it: "La sua aderenza è stata del 92% negli ultimi 30 giorni.",
  pl: "Przestrzeganie zaleceń wyniosło 92% w ostatnich 30 dniach.",
  ko: "지난 30일 복약 순응도는 92%였어요.",
};

describe("screenModelOutput — risk-score, all six locales", () => {
  for (const locale of locales) {
    it(`blocks a fabricated clinical risk figure in ${locale}`, () => {
      const d = screenModelOutput(
        RISK_VIOLATIONS[locale],
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(true);
      expect(d.reason).toBe("risk_score");
    });

    it(`passes a non-risk percentage in ${locale}`, () => {
      const d = screenModelOutput(
        RISK_CLEAN[locale],
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(false);
    });
  }
});

// ── issue #587 — bare "score" is not a fabricated clinical risk score ─────

/**
 * The named-risk-engine pattern used `score2?` (the `2` optional), so it
 * matched bare "score" too — any mention of one of THIS APP's own computed,
 * documented scores (Sleep Score, Readiness Score, Health Score, …) tripped
 * the fabricated-risk-engine bank meant for SCORE2/Framingham/ASCVD/QRISK.
 */
const WELLNESS_SCORE_CLEAN: readonly string[] = [
  "Your Sleep Score is based on sleep duration and stage balance.",
  "Your Readiness Score is lower than your recent baseline.",
  "This Health Score is based on the available tracked pillars.",
  "Your Recovery Score and Stress Score both moved this week.",
  "The Strain Score reflects yesterday's training load.",
];

describe("screenModelOutput — issue #587 ordinary wellness-score wording", () => {
  for (const text of WELLNESS_SCORE_CLEAN) {
    it(`passes: ${text}`, () => {
      const d = screenModelOutput(text, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(false);
      expect(d.reason).toBeNull();
    });
  }

  it("blocks a named engine paired with a fabricated number", () => {
    const d = screenModelOutput(
      "Based on SCORE2, your risk sits at about 14%.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("risk_score");
  });

  it("blocks a named engine paired with a categorical result verdict (numberless)", () => {
    for (const engine of [
      "Based on Framingham, you fall into the intermediate-risk category.",
      "SCORE2 would put you in the high-risk band given your profile.",
      "QRISK classifies you as elevated-risk group.",
    ]) {
      const d = screenModelOutput(engine, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("risk_score");
    }
  });

  it("PASSES a bare engine mention with no asserted result or figure (D1/D4)", () => {
    // Naming what ASCVD is — education or a refusal — is not a fabrication.
    for (const mention of [
      "I can't compute your ASCVD, that's for your clinician.",
      "An ASCVD score is something a doctor calculates from lab values.",
      "Framingham and QRISK are two examples of cardiovascular risk tools.",
    ]) {
      const d = screenModelOutput(mention, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(false);
      expect(d.reason).toBeNull();
    }
  });
});

// ── D1/D4 — hedge-then-assert, spelled-out percent, model-perfect refusal ──

describe("screenModelOutput — risk narrowing (D1/D4/M4)", () => {
  it("blocks the hedge-then-assert bypass (H1) — the 14% is caught", () => {
    const d = screenModelOutput(
      "I can't compute your exact ASCVD score, but based on your numbers your risk is about 14%.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("risk_score");
  });

  it("blocks a spelled-out percent risk figure (H4b)", () => {
    for (const text of [
      "Your ten-year cardiovascular risk is roughly twelve percent.",
      "Your ten-year risk is roughly twelve percent.",
    ]) {
      const d = screenModelOutput(text, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("risk_score");
    }
  });

  it("blocks a numberless categorical engine result (H4a)", () => {
    const d = screenModelOutput(
      "SCORE2 would put you in the high-risk band.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("risk_score");
  });

  it("blocks a numberless categorical risk-level verdict on the horizon", () => {
    const d = screenModelOutput(
      "Your 10-year cardiovascular risk is elevated — consider stepping your dose up.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("risk_score");
  });

  it("PASSES a model-perfect refusal that names the horizon and the engine (M4)", () => {
    const d = screenModelOutput(
      "I can't calculate a 10-year cardiovascular risk for you — an ASCVD score is something your clinician computes with lab values I don't have.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
    expect(d.reason).toBeNull();
  });

  it("blocks a DE spelled-out percent risk figure and a DE engine result", () => {
    expect(
      screenModelOutput(
        "Dein Risiko liegt bei etwa zwölf Prozent.",
        "de",
        CONVERSATIONAL_CONTRACTS,
      ).block,
    ).toBe(true);
    expect(
      screenModelOutput(
        "SCORE2 würde dich in den hohen Risikobereich einordnen.",
        "de",
        CONVERSATIONAL_CONTRACTS,
      ).block,
    ).toBe(true);
  });

  it("PASSES a DE bare-horizon refusal with no figure", () => {
    const d = screenModelOutput(
      "Ein 10-Jahres-Risiko kann ich dir nicht berechnen, das macht deine Ärztin.",
      "de",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
  });
});

// ── D7 — dose continuation-exclusion ─────────────────────────────────────

describe("screenModelOutput — dose continuation-exclusion (D7)", () => {
  it("PASSES an adherence-supporting continuation of the current dose", () => {
    const d = screenModelOutput(
      "You should keep taking your prescribed 7.5 mg exactly as directed.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
    expect(d.reason).toBeNull();
  });

  it("still blocks 'keep in mind that trying 5 mg' — no maintenance anchor", () => {
    const d = screenModelOutput(
      "You should keep in mind that trying 5 mg could help.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("dose_prescription");
  });

  it("still blocks 'continue tapering to 2.4 mg' — a change stem voids the exemption", () => {
    for (const text of [
      "You should continue tapering to 2.4 mg next week.",
      "Continue tapering to 2.4 mg next week.",
    ]) {
      const d = screenModelOutput(text, "en", CONVERSATIONAL_CONTRACTS);
      expect(d.block).toBe(true);
      expect(d.reason).toBe("dose_prescription");
    }
  });

  it("still blocks 'you should try 5 mg' — exclusion is of continuation, not requirement of change", () => {
    const d = screenModelOutput(
      "You should try 5 mg and see how it feels.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("dose_prescription");
  });

  it("PASSES a DE continuation that trips a DE dose pattern but is anchored", () => {
    // "du solltest … 7,5 mg" trips the DE consider/should dose pattern; the
    // "weiterhin … wie verordnet" maintenance anchor exempts it.
    const d = screenModelOutput(
      "Du solltest weiterhin deine 7,5 mg wie verordnet einnehmen.",
      "de",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
  });

  it("still blocks a DE dose increase even with a continuation word present", () => {
    const d = screenModelOutput(
      "Du solltest weiterhin erhöhen, und zwar auf 5 mg.",
      "de",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(true);
    expect(d.reason).toBe("dose_prescription");
  });
});

// ── causal claims (GROUND RULE 12) ───────────────────────────────────────

const CAUSAL_VIOLATIONS: Record<Locale, string> = {
  en: "Your weight fell because you slept more.",
  de: "Dein Gewicht sank wegen des Schlafs.",
  fr: "Votre poids a baissé parce que vous avez mieux dormi.",
  es: "Su peso bajó porque durmió más.",
  it: "Il suo peso è calato perché ha dormito di più.",
  pl: "Waga spadła, ponieważ spał Pan więcej.",
  ko: "수면 때문에 체중이 줄었어요.",
};

/** Descriptive association framing is what the contract REQUIRES. */
const CAUSAL_CLEAN: Record<Locale, string> = {
  en: "Your weight moved with your sleep this week.",
  de: "Dein Gewicht bewegte sich diese Woche mit deinem Schlaf.",
  fr: "Votre poids a évolué avec votre sommeil cette semaine.",
  es: "Su peso evolucionó junto con su sueño esta semana.",
  it: "Il suo peso si è mosso insieme al suo sonno questa settimana.",
  pl: "Waga zmieniała się razem ze snem w tym tygodniu.",
  ko: "이번 주 체중은 수면과 함께 움직였어요.",
};

describe("screenModelOutput — causal claims, all six locales", () => {
  for (const locale of locales) {
    it(`blocks asserted causation in ${locale}`, () => {
      const d = screenModelOutput(
        CAUSAL_VIOLATIONS[locale],
        locale,
        INSIGHTS_CONTRACTS,
      );
      expect(d.block).toBe(true);
      expect(d.reason).toBe("causal_claim");
    });

    it(`passes descriptive association framing in ${locale}`, () => {
      const d = screenModelOutput(
        CAUSAL_CLEAN[locale],
        locale,
        INSIGHTS_CONTRACTS,
      );
      expect(d.block).toBe(false);
    });
  }
});

// ── contract selection ───────────────────────────────────────────────────

describe("screenModelOutput — contract selection", () => {
  it("does NOT flag causal wording under the conversational contracts", () => {
    // The Coach must keep "because" — GROUND RULE 12's surface is `insights`,
    // and blocking it conversationally would gut ordinary explanation.
    const d = screenModelOutput(
      CAUSAL_VIOLATIONS.en,
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.block).toBe(false);
  });

  it("flags the same sentence under the insights contracts", () => {
    const d = screenModelOutput(CAUSAL_VIOLATIONS.en, "en", INSIGHTS_CONTRACTS);
    expect(d.block).toBe(true);
  });

  it("reports dose before risk when a reply trips both", () => {
    const d = screenModelOutput(
      "Your risk is 12% — step up to 2.4 mg.",
      "en",
      CONVERSATIONAL_CONTRACTS,
    );
    expect(d.reason).toBe("dose_prescription");
  });
});

// ── cross-language coverage ──────────────────────────────────────────────

describe("screenModelOutput — English violations reach non-English readers", () => {
  /**
   * A provider routinely answers in English regardless of the locale
   * directive. If the screen consulted only the reader's bank, the proven
   * English violation shapes would pass on five of six locales.
   */
  for (const locale of locales) {
    it(`blocks an English dose imperative for a ${locale} reader`, () => {
      const d = screenModelOutput(
        DOSE_VIOLATIONS.en,
        locale,
        CONVERSATIONAL_CONTRACTS,
      );
      expect(d.block).toBe(true);
      expect(d.reason).toBe("dose_prescription");
    });
  }
});

describe("screenModelOutput — empty input", () => {
  it("passes empty and whitespace-only text (handled upstream)", () => {
    expect(screenModelOutput("", "en", INSIGHTS_CONTRACTS).block).toBe(false);
    expect(screenModelOutput("   ", "fr", INSIGHTS_CONTRACTS).block).toBe(
      false,
    );
  });
});
