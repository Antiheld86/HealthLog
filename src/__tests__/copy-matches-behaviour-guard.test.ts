/**
 * Copy-matches-behaviour guard.
 *
 * Three classes of copy that drifted away from the code they describe, each
 * pinned here so the pair fails loudly if either half moves again:
 *
 *   1. DELETE CONFIRMATIONS. A confirmation is the moment a user weighs the
 *      consequence. Four dialogs promised permanence on surfaces that render
 *      an Undo affordance (measurements bulk, mood bulk, labs, illness) — a
 *      cautious user declines a safe delete, and the warning loses weight
 *      where it is true. This test pins both directions: undo-able surfaces
 *      must offer the undo sentence and must NOT claim finality; the
 *      genuinely permanent ones must keep their warning.
 *
 *   2. SLEEP DEBT. v1.19.0 replaced the summed shortfall with a running
 *      balance that credits surplus sleep. The labels still described the old
 *      arithmetic, so the word contradicted the number for anyone who caught
 *      up after a short night.
 *
 *   3. GLUCOSE REFERENCE BAND. The declared diabetes opt-in has a server
 *      preference and a route; the copy for its web control must exist in
 *      every locale, since a missing key silently degrades to the raw key on
 *      a surface that makes a clinical-adjacent claim.
 *
 * Reversibility evidence for the undo-able set:
 *   - measurements: `POST /api/measurements/restore`, undo toast in
 *     `src/components/measurements/measurement-list.tsx`
 *   - mood:         `POST /api/mood-entries/restore`, undo toast in
 *     `src/components/mood/mood-list.tsx`
 *   - labs:         `POST /api/labs/restore`, undo toast in
 *     `src/components/labs/lab-history-list.tsx`
 *   - illness:      `POST /api/illness/episodes/[id]/restore`, undo toast in
 *     `src/components/illness/episode-menu.tsx`
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MESSAGES = join(__dirname, "../../messages");
const LOCALES = ["de", "en", "es", "fr", "it", "pl"] as const;

function bundle(locale: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MESSAGES, `${locale}.json`), "utf8"));
}

function resolve(obj: Record<string, unknown>, path: string): string {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    expect(cur, `${path} is missing at "${seg}"`).toBeTypeOf("object");
    cur = (cur as Record<string, unknown>)[seg];
  }
  expect(typeof cur, `${path} must resolve to a string`).toBe("string");
  return cur as string;
}

/**
 * Per-locale phrases that assert a deletion cannot be taken back. A dialog on
 * an undo-able surface must contain none of these.
 */
const FINALITY_PHRASES: Record<string, readonly string[]> = {
  en: ["cannot be undone", "can't be undone", "permanently", "permanent"],
  de: ["nicht rückgängig", "endgültig", "dauerhaft", "unwiderruflich"],
  es: ["no se puede deshacer", "permanente", "irreversible"],
  fr: [
    "irréversible",
    "définitivement",
    "définitive",
    "ne peut pas être annulé",
  ],
  it: [
    "non può essere annullata",
    "non può essere annullato",
    "definitivamente",
    "definitiva",
    "permanente",
  ],
  pl: ["nie można cofnąć", "nie można tego cofnąć", "trwale", "nieodwracaln"],
};

/** Per-locale phrase that promises the short undo window. */
const UNDO_PHRASES: Record<string, string> = {
  en: "undo",
  de: "rückgängig",
  es: "deshacerlo",
  fr: "annuler cette action",
  it: "annullare",
  pl: "cofnąć",
};

/** Confirmation bodies whose surface renders an Undo affordance. */
const UNDOABLE_CONFIRM_KEYS = [
  "measurements.deleteConfirmDescription",
  "measurements.bulkDeleteConfirmBody",
  "mood.deleteConfirmDescription",
  "mood.bulkDeleteConfirmBody",
  "labs.deleteConfirmDescription",
  "illness.deleteConfirm.body",
] as const;

/**
 * Confirmation bodies whose delete really is unrecoverable for the user —
 * hard delete or a tombstone with no restore path. These MUST keep a
 * finality warning; softening them would be the mirror-image bug.
 */
const PERMANENT_CONFIRM_KEYS = [
  // hard delete + cascade of every recorded value
  "labs.biomarker.deleteConfirmDescription",
  // `?purge=true` hard-deletes the tag off every past entry
  "mood.manage.purgeBody",
  // GDPR Art. 17 account purge
  "settings.deleteAccountConfirmDescription",
  // hard delete of every user-scoped row except the sign-in credentials
  "settings.dangerZoneConfirmDescription",
  // hard delete since v1.32.40 — the tombstone served nothing and the
  // dialog already promised permanence
  "measurementReminders.deleteConfirmDescription",
  "records.allergies.deleteConfirmDescription",
] as const;

describe("delete confirmations describe what the surface actually does", () => {
  for (const locale of LOCALES) {
    const msgs = bundle(locale);

    describe(locale, () => {
      for (const key of UNDOABLE_CONFIRM_KEYS) {
        it(`${key} offers undo and claims no finality`, () => {
          const copy = resolve(msgs, key).toLowerCase();

          for (const phrase of FINALITY_PHRASES[locale]) {
            expect(
              copy,
              `${locale}/${key} claims finality ("${phrase}") but the surface renders an Undo`,
            ).not.toContain(phrase.toLowerCase());
          }

          expect(
            copy,
            `${locale}/${key} should tell the user the delete can be undone`,
          ).toContain(UNDO_PHRASES[locale].toLowerCase());
        });
      }

      for (const key of PERMANENT_CONFIRM_KEYS) {
        it(`${key} keeps its finality warning`, () => {
          const copy = resolve(msgs, key).toLowerCase();
          const warns = FINALITY_PHRASES[locale].some((p) =>
            copy.includes(p.toLowerCase()),
          );
          expect(
            warns,
            `${locale}/${key} deletes irrecoverably — the copy must say so`,
          ).toBe(true);
        });
      }
    });
  }
});

describe("sleep debt is labelled as a balance, not a summed deficit", () => {
  /**
   * The figure is a running balance: a short night adds, a long night pays it
   * down. Deficit/shortfall vocabulary describes the pre-v1.19.0 sum.
   */
  const STALE_SUM_VOCABULARY: Record<string, readonly string[]> = {
    en: ["cumulative", "shortfall", "accumulated"],
    de: ["kumuliert", "defizit", "aufgelaufen"],
    es: ["acumulado", "acumulada", "déficit"],
    fr: ["cumulé", "cumulée", "déficit"],
    it: ["cumulato", "cumulata", "accumulato", "deficit"],
    pl: ["skumulowan", "niedobór", "niedoboru"],
  };

  for (const locale of LOCALES) {
    const msgs = bundle(locale);

    it(`${locale} debt captions carry no summed-deficit wording`, () => {
      for (const key of [
        "insights.sleep.debt.caption",
        "insights.sleep.debt.clearCaption",
      ]) {
        const copy = resolve(msgs, key).toLowerCase();
        for (const term of STALE_SUM_VOCABULARY[locale]) {
          expect(
            copy,
            `${locale}/${key} still describes the pre-v1.19.0 summed shortfall ("${term}")`,
          ).not.toContain(term);
        }
      }
    });
  }

  it("the explainer states that catch-up sleep pays the balance down", () => {
    const copy = resolve(bundle("en"), "insights.sleep.debt.computedInfo");
    expect(copy.toLowerCase()).toContain("balance");
    expect(copy.toLowerCase()).toContain("catch-up");
  });
});

describe("the glucose reference band control is translated everywhere", () => {
  const KEYS = [
    "settings.glucoseReference.title",
    "settings.glucoseReference.description",
    "settings.glucoseReference.enable",
    "settings.glucoseReference.explainer",
    "settings.glucoseReference.disclaimer",
    "settings.glucoseReference.error",
  ] as const;

  for (const locale of LOCALES) {
    it(`${locale} carries every key`, () => {
      const msgs = bundle(locale);
      for (const key of KEYS) {
        expect(resolve(msgs, key).length).toBeGreaterThan(0);
      }
    });
  }

  it("the disclaimer refuses the diagnosis reading (EN)", () => {
    const copy = resolve(
      bundle("en"),
      "settings.glucoseReference.disclaimer",
    ).toLowerCase();
    expect(copy).toContain("not a diagnosis");
    expect(copy).toContain("never inferred");
  });
});
