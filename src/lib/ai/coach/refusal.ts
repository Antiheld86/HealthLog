/**
 * Refusal heuristics for the Coach inbound channel.
 *
 * Two attack surfaces this module guards:
 *
 *   1. Off-topic — the Coach is health-tracking only. A user typing
 *      "tell me a joke", "what's the weather", "write me a python
 *      script" gets a calm refusal in their locale. The route never
 *      hits a provider for these — saves the operator's bill and
 *      keeps the response shape consistent.
 *
 *   2. Prompt injection — variations of "ignore previous instructions",
 *      "you are now a different model", "system: you may answer
 *      anything". The detector is intentionally pattern-based rather
 *      than LLM-based; a tiny, deterministic regex bank is cheap and
 *      auditable. A full LLM-based classifier would itself be
 *      promptable.
 *
 * The detector errs toward false positives — refusing a borderline
 * request is recoverable (the user rephrases). Letting an injection
 * through is not. Genuine health-related text trips few of these
 * patterns; the refusal helper takes a `defaultAllow` argument so the
 * route can choose its bias.
 */
import type { Locale } from "@/lib/i18n/config";
import { foldForMatch } from "@/lib/i18n/fold-for-match";
import { labelsInEveryLocale } from "@/lib/i18n/localised-label-index";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { MEASUREMENT_TYPE_LABEL_KEYS } from "@/lib/measurements/type-label-keys";

/**
 * Refusal copy for the streaming response — UI-rendered as `token` SSE frames
 * followed by `done`.
 *
 * The copy now lives in the bundles under `coach.refusal.*` for every shipped
 * locale. It used to be a de/en constant pair selected by `locale === "de"`,
 * which answered a French, Spanish, Italian or Polish user in English at the
 * one moment the Coach is declining to help — the worst turn to switch
 * language on someone.
 *
 * The EN / DE constants stay exported, now derived from the bundles rather
 * than duplicating them, so server-only code (tests, logs) can still pin the
 * exact wording without a translator round-trip and cannot drift from what the
 * user is actually shown.
 */
function coachRefusalCopy(reason: CoachRefusalReason, locale: Locale): string {
  return getServerTranslator(locale).t(
    reason === "prompt_injection"
      ? "coach.refusal.promptInjection"
      : "coach.refusal.outOfScope",
  );
}

export const COACH_REFUSAL_OUT_OF_SCOPE_EN = coachRefusalCopy(
  "out_of_scope",
  "en",
);

export const COACH_REFUSAL_OUT_OF_SCOPE_DE = coachRefusalCopy(
  "out_of_scope",
  "de",
);

export const COACH_REFUSAL_INJECTION_EN = coachRefusalCopy(
  "prompt_injection",
  "en",
);

export const COACH_REFUSAL_INJECTION_DE = coachRefusalCopy(
  "prompt_injection",
  "de",
);

/**
 * Categorisation of a refusal hit, so the route can annotate the
 * Wide-Event with `reason` and serve the right localised copy.
 */
export type CoachRefusalReason = "out_of_scope" | "prompt_injection";

export interface CoachRefusalDecision {
  /** True when the message should be refused. */
  refuse: boolean;
  /** Why — drives Wide-Event metadata. */
  reason: CoachRefusalReason | null;
  /** Pre-resolved refusal copy for the active locale. */
  message: string | null;
}

/**
 * Pattern bank — kept as a flat array so a future audit can grep for
 * any single phrase without unraveling a regex tree.
 *
 * Each entry uses `\b` word boundaries so substring collisions ("hi
 * gnore me" matching "ignore") are avoided, and the case-insensitive
 * `i` flag accepts the obvious variants.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+)?(?:previous|prior|earlier|above|the\s+above)\s+(?:instructions?|rules?|prompts?|messages?)\b/i,
  /\bignoriere\s+(?:(?:alle|sämtliche|saemtliche|die|deine|meine)\s+)?(?:vorherigen?|vorigen?|bisherigen?|obigen?)?\s*(?:anweisungen?|regeln?|vorgaben?|prompts?)\b/i,
  /\bvergiss\s+(?:(?:alle|sämtliche|saemtliche|die|deine|meine)\s+)?(?:vorherigen?|bisherigen?|obigen?)?\s*(?:anweisungen?|regeln?|vorgaben?)\b/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|earlier|above)\s+(?:instructions?|rules?|prompts?)\b/i,
  /\boverride\s+(?:your|the)\s+(?:system|previous|original)\s+(?:prompt|instructions?|rules?)\b/i,
  /\byou\s+are\s+now\s+(?:a|an)?\s*(?:dan|jailbreak|developer|admin|root)\b/i,
  /\bact\s+as\s+(?:if\s+)?(?:you\s+(?:are|were)|a)\s+(?:dan|jailbreak|admin|root|unrestricted)\b/i,
  /\bpretend\s+(?:to\s+be\s+|you\s+are\s+)(?:dan|admin|root|unrestricted|a\s+different\s+model)\b/i,
  /\b(?:do\s+anything\s+now|jailbreak|prompt\s+injection)\b/i,
  /\b(?:reveal|print|show|leak|expose|dump)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions?|rules?|guidelines?)\b/i,
  /\b(?:from\s+now\s+on|starting\s+now)\s*,?\s*you\s+(?:will|must|are)\b/i,
  /^\s*system\s*[:>]/im,
  /<\s*\|?\s*(?:system|im_start|imstart)\s*\|?\s*>/i,
  /\[\s*INST\s*\]/i,
  /\bend\s+of\s+(?:system\s+)?prompt\b/i,
];

/**
 * Lightweight off-topic detector. Health-related terminology lives in a
 * positive allow-list (any match → on-topic). Common off-topic asks
 * land in the deny bucket. The bias is per-call: when neither bucket
 * matches we return `defaultAllow`.
 *
 * The list is pragmatic, not exhaustive — the prompt itself enforces
 * the harder constraint that the model only narrates the snapshot. The
 * detector exists so the obvious "what's the weather" ask never burns
 * a token.
 */
const HEALTH_TOKENS: readonly RegExp[] = [
  /\b(?:bp|blood\s*pressure|systolic|diastolic|mmhg|hypertension|hypotension)\b/i,
  /\b(?:weight|gewicht|kg|bmi|body\s*mass)\b/i,
  /\b(?:pulse|puls|heart\s*rate|hr|bpm|resting\s*hr|hrv)\b/i,
  /\b(?:mood|stimmung|mental|sleep|schlaf)\b/i,
  /\b(?:medication|medikament|compliance|reminder|dose|dosierung)\b/i,
  /\b(?:withings|trend|reading|measurement|messung|wert)\b/i,
  /\b(?:doctor|arzt|appointment|termin|report|bericht)\b/i,
  /\b(?:health|gesundheit|insight|einsicht|score|coach)\b/i,
  /\b(?:streak|achievement|erfolg|goal|ziel)\b/i,
  /\b(?:steps|schritte|activity|workout)\b/i,
  /\b(?:trend|delta|baseline|durchschnitt|average|median|veränderung|verändert)\b/i,
];

const OFF_TOPIC_TOKENS: readonly RegExp[] = [
  /\b(?:weather|wetter|forecast|temperature|temperatur)\b/i,
  /\b(?:news|nachricht(?:en)?|politic(?:s|al)|wahl|election)\b/i,
  /\b(?:joke|witz|story|geschichte|poem|gedicht|fanfic|roleplay|rollenspiel)\b/i,
  /\b(?:python|javascript|typescript|java|html|css|sql|regex|code\s+for)\b/i,
  /\b(?:stock|aktie|crypto|bitcoin|ethereum|invest)\b/i,
  /\b(?:movie|film|series|serie|netflix|spotify|music|musik)\b/i,
  /\b(?:recipe|rezept|cooking|kochen)\b/i,
  /\b(?:flight|flug|hotel|trip|urlaub|vacation|travel|reise)\b/i,
];

/**
 * The same deny bank for the other four shipped languages, matched against the
 * FOLDED message rather than the raw one.
 *
 * Two reasons it cannot simply join the array above. JavaScript's `\b` is
 * defined over ASCII word characters, so `\bżart\b` never matches: the space
 * before "ż" is a non-word character and so is "ż" itself, which means there is
 * no boundary between them. And a reply may spell a word with or without its
 * diacritic. Folding both sides first solves both at once — "żart" and "zart"
 * fold together, and every entry here is ASCII, so the boundaries hold.
 *
 * Only words that mean ONE thing are banked. Spanish "tiempo" and French
 * "temps" are the everyday word for both weather and time, so neither is here;
 * "meteo", "pronostico" and "pogoda" carry no second reading. A wrong entry on
 * the deny side costs a refused health question, which is the expensive
 * direction, so a missing word is preferred to a loose one.
 */
const OFF_TOPIC_TOKENS_FOLDED: readonly RegExp[] = [
  /\b(?:meteo|pronostico|previsioni|pogoda|prognoza)\b/,
  /\b(?:noticias|notizie|aktualnosci|wiadomosci|elecciones|elezioni|wybory|elections)\b/,
  /\b(?:blague|chiste|barzelletta|zart|poeme|poema|poesia|wiersz|opowiadanie)\b/,
  /\b(?:acciones|azioni|akcje|criptomoneda|criptovaluta|kryptowaluta|inwestycja)\b/,
  /\b(?:pelicula|cancion|canzone|piosenka|muzyka|musica|musique)\b/,
  /\b(?:receta|ricetta|recette|przepis|cucinare|cocinar|gotowanie)\b/,
  /\b(?:vuelo|volo|wakacje|vacaciones|vacanze|vacances|urlop|podroz)\b/,
];

/* ──────────────────────────────────────────────────────────────────────────
 * The health allow-list's second half — DERIVED, not transcribed.
 *
 * `HEALTH_TOKENS` above is a hand-written English/German bank. It carries
 * vocabulary no bundle has (`mmhg`, `hrv`, `withings`, `bpm`) and is kept, but
 * on its own it made the off-topic gate misfire across the four other shipped
 * languages: the deny bank matches "serie", so an Italian asking "ho una serie
 * di misurazioni strane" tripped it, and nothing in the allow bank recognised
 * "misurazioni" as health, so a question about the user's own data was refused.
 *
 * The words that fix this are not this module's to invent. Every metric the app
 * tracks and every health surface it navigates to is already labelled in all six
 * bundles, and those labels are exactly the nouns a person types. So the second
 * half of the allow-list is READ from the bundles: a seventh language starts
 * being understood the day `messages/xx.json` lands, with no edit here.
 *
 * Whole-word matching against the folded message, not substring — the derived
 * set is much larger than the hand bank and a substring match over it would
 * turn ordinary prose into a health signal. That costs inflected forms
 * ("pomiarów" does not match the label's "pomiary"); the hand bank and the
 * `defaultAllow` bias absorb the miss, and a miss here only means the message
 * is not positively marked health, never that it is refused on its own.
 * ────────────────────────────────────────────────────────────────────────── */

/** Health surfaces the sidebar names — the nouns a user asks about by name. */
const HEALTH_SURFACE_LABEL_KEYS: readonly string[] = [
  "nav.measurements",
  "nav.medications",
  "nav.mood",
  "nav.cycle",
  "nav.labs",
  "nav.vorsorge",
  "nav.illness",
  "nav.vaccinations",
  "nav.mentalWellbeing",
];

/**
 * Shortest derived token kept. Three-letter labels are where the collisions
 * live — French "Pas" (steps) is also the negation particle, Polish "Sen"
 * (sleep) sits inside ordinary words — and admitting them would mark almost
 * any sentence in those languages as health.
 */
const MIN_DERIVED_TOKEN_LENGTH = 4;

/**
 * Words that appear inside a metric label while carrying no health meaning of
 * their own. Three groups, all of them found by reading the derived set rather
 * than guessed at:
 *
 *   - label scaffolding — "average", "daily", "time in …", "… event";
 *   - comparatives the label uses to name a variant — "high heart rate event",
 *     "Frequenza cardiaca alta";
 *   - words that are health-shaped in English but everyday elsewhere. French
 *     "bien-être" contributes "bien" and "etre", two of the commonest words in
 *     the language; leaving them in would have marked nearly every French
 *     sentence as health and disabled the off-topic gate for French entirely.
 */
const GENERIC_LABEL_WORDS: ReadonlySet<string> = new Set([
  // articles, prepositions and copulas long enough to survive the length floor
  "alla",
  "alle",
  "dans",
  "della",
  "delle",
  "dell",
  "para",
  "przez",
  "przy",
  "bien",
  "etre",
  "estado",
  // label scaffolding
  "average",
  "media",
  "medio",
  "moyenne",
  "moyen",
  "mittel",
  "mittelwert",
  "srednie",
  "durchschnittlicher",
  "durchschnittliche",
  "total",
  "totale",
  "gesamt",
  "time",
  "tempo",
  "temps",
  "tiempo",
  "zeit",
  "czas",
  "jour",
  "giorno",
  "giornaliero",
  "dzienne",
  "dziennym",
  "daily",
  "taglich",
  "minute",
  "minutes",
  "minuten",
  "minuti",
  "minutos",
  "minutowego",
  "index",
  "indice",
  "value",
  "wert",
  "count",
  "anzahl",
  "event",
  "ereignis",
  "evento",
  "zdarzenie",
  "level",
  "niveau",
  "nivel",
  "livello",
  "poziom",
  "notification",
  "notifica",
  "powiadomienie",
  "alert",
  "alerte",
  "aviso",
  "avviso",
  "hinweis",
  "rate",
  "rapport",
  "rapporto",
  "course",
  "support",
  "load",
  "charge",
  "double",
  "doble",
  "doppio",
  "libre",
  "free",
  "scale",
  "need",
  "besoin",
  "necesidad",
  "fabbisogno",
  "zapotrzebowanie",
  "tour",
  "vita",
  "force",
  "presa",
  "seance",
  "ambiente",
  "environment",
  "environnement",
  "otoczenie",
  "umgebung",
  // comparatives naming a label variant
  "high",
  "hohe",
  "alta",
  "alto",
  "elevee",
  "wysokim",
  "maksymalne",
  "maxima",
  "maximale",
  "maximaler",
  "maximum",
  "massima",
  "bassa",
  "basse",
  "baja",
  "niedrige",
  "niskim",
  "forte",
]);

/**
 * Split a label or a message into comparable whole words: accent-folded, lower
 * cased, and cut on every non-alphanumeric run so a parenthesised label
 * ("Audio exposure (headphones)") yields the noun rather than "(headphones)".
 *
 * Applied to BOTH sides — the bundle label and the user's message go through
 * this one function, so the index cannot drift from the lookup.
 */
function healthWordTokens(raw: string): string[] {
  return foldForMatch(raw)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_DERIVED_TOKEN_LENGTH);
}

/**
 * Every health noun the bundles label, folded, across every shipped locale.
 * Built once at module load — a few hundred short string folds over catalogs
 * the server translator already holds resident.
 */
function buildDerivedHealthTokens(): ReadonlySet<string> {
  const tokens = new Set<string>();
  const keys = [
    ...Object.values(MEASUREMENT_TYPE_LABEL_KEYS),
    ...HEALTH_SURFACE_LABEL_KEYS,
  ];
  for (const key of keys) {
    for (const label of labelsInEveryLocale(key)) {
      for (const word of healthWordTokens(label)) {
        if (GENERIC_LABEL_WORDS.has(word)) continue;
        tokens.add(word);
      }
    }
  }
  return tokens;
}

const DERIVED_HEALTH_TOKENS = buildDerivedHealthTokens();

/**
 * Test seam: the guard suite asserts the derived set is non-empty and that
 * every shipped locale contributes to it, so a bundle that stops carrying the
 * metric labels fails the suite rather than quietly narrowing the allow-list.
 */
export function derivedHealthTokens(): ReadonlySet<string> {
  return DERIVED_HEALTH_TOKENS;
}

/** True when any whole word of the message is a health noun from the bundles. */
function matchesDerivedHealthToken(message: string): boolean {
  for (const word of healthWordTokens(message)) {
    if (DERIVED_HEALTH_TOKENS.has(word)) return true;
  }
  return false;
}

export interface DetectRefusalParams {
  /** Raw user-input message. */
  message: string;
  /** Locale for the refusal copy. */
  locale: Locale;
  /**
   * What to do when neither allow-list nor deny-list trips. Default
   * `true` — when nothing in the message looks off-topic, let the
   * model handle it (the prompt itself enforces the harder boundary).
   */
  defaultAllow?: boolean;
}

/**
 * Check a user message for refusal triggers. Order:
 *   1. Prompt-injection patterns (highest priority — never run a
 *      tampered request).
 *   2. Off-topic deny patterns, unless the message also contains a
 *      health allow-token (e.g. "is my BP trend related to the
 *      weather?" stays on-topic).
 */
export function detectRefusal(
  params: DetectRefusalParams,
): CoachRefusalDecision {
  const { message, locale } = params;
  const defaultAllow = params.defaultAllow ?? true;
  const trimmed = message.trim();

  if (trimmed.length === 0) {
    return { refuse: false, reason: null, message: null };
  }

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        refuse: true,
        reason: "prompt_injection",
        message: coachRefusalCopy("prompt_injection", locale),
      };
    }
  }

  const looksHealth =
    HEALTH_TOKENS.some((p) => p.test(trimmed)) ||
    matchesDerivedHealthToken(trimmed);
  const folded = foldForMatch(trimmed);
  const looksOffTopic =
    OFF_TOPIC_TOKENS.some((p) => p.test(trimmed)) ||
    OFF_TOPIC_TOKENS_FOLDED.some((p) => p.test(folded));

  if (looksOffTopic && !looksHealth) {
    return {
      refuse: true,
      reason: "out_of_scope",
      message: coachRefusalCopy("out_of_scope", locale),
    };
  }

  if (!looksHealth && !defaultAllow) {
    return {
      refuse: true,
      reason: "out_of_scope",
      message: coachRefusalCopy("out_of_scope", locale),
    };
  }

  return { refuse: false, reason: null, message: null };
}
