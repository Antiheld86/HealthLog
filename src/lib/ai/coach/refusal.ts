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
import { getServerTranslator } from "@/lib/i18n/server-translator";

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

  const looksHealth = HEALTH_TOKENS.some((p) => p.test(trimmed));
  const looksOffTopic = OFF_TOPIC_TOKENS.some((p) => p.test(trimmed));

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
