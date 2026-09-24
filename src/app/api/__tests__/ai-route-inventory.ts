/**
 * The AI route inventory: which API routes ask an AI capability, and which
 * are data and must never ask.
 *
 * The rule it pins (the AI-optional design): data never depends on AI. A
 * route that serves measurements, device records, computed scores,
 * statistics or template sentences imports no AI gate and is never refused
 * because a switch is off, a provider is missing, consent is absent or the
 * person opted out of AI analysis. A route that calls a model, or serves text
 * a model wrote, names its capability:
 *
 *   - `action` routes call `requireAiCapability(key)` and refuse with the
 *     capability envelope;
 *   - `mixed` reads call `getAiCapability(key)`, answer 200, null the model
 *     text and say why in `ai`. They never refuse for an AI reason, so they
 *     never call `requireAiCapability`.
 *
 * Read by two guards: `ai-capability-route-inventory.test.ts` (the whole API
 * tree) and `insights/__tests__/coach-route-gate-inventory.test.ts` (every
 * route in the trees where AI routes live is classified). Not a test file, so
 * importing it registers nothing.
 */
import type { AiCapabilityKey } from "@/lib/ai/capabilities/types";

export interface AiRouteEntry {
  kind: "action" | "mixed";
  capabilities: readonly AiCapabilityKey[];
  why: string;
}

export const AI_ROUTES: Readonly<Record<string, AiRouteEntry>> = {
  "src/app/api/insights/chat/route.ts": {
    kind: "action",
    capabilities: ["coach"],
    why: "POST streams a Coach reply from a model. The history GET in the same file asks nothing.",
  },
  "src/app/api/insights/generate/route.ts": {
    kind: "action",
    capabilities: ["briefing"],
    why: "POST generates the briefing; GET is a pure AI read (the payload is the model text and nothing else), so both refuse.",
  },
  "src/app/api/insights/comprehensive/route.ts": {
    kind: "mixed",
    capabilities: ["briefing", "statusText"],
    why: "Computed overview data; the `ai` block says whether the briefing and status notes around it can be shown.",
  },
  "src/app/api/insights/derived/route.ts": {
    kind: "mixed",
    capabilities: ["statusText"],
    why: "Computed score; only the model-written assessment override follows the capability.",
  },
  "src/app/api/insights/narrative/route.ts": {
    kind: "mixed",
    capabilities: ["periodNarrative"],
    why: "A deterministic narrative is data; a model-written one is served only while the capability is available.",
  },
  "src/app/api/insights/pregenerate/route.ts": {
    kind: "mixed",
    capabilities: ["briefing", "statusText"],
    why: "Enqueue-only warm that returns no model text: `queued: false` when neither half can run.",
  },
  "src/app/api/insights/coach/nudge-status/route.ts": {
    kind: "mixed",
    capabilities: ["coach"],
    why: "The unread signal of a Coach that is unavailable is the quiet empty shape, never a refusal.",
  },
  "src/app/api/insights/coach/seeded-question/route.ts": {
    kind: "mixed",
    capabilities: ["coach"],
    why: "The opener exists only to open the Coach: `signal: null` while it is unavailable.",
  },
  "src/app/api/coach/about-me/route.ts": {
    kind: "mixed",
    capabilities: ["aboutMeQuestions"],
    why: "The profile is data; only model-written follow-up questions follow the capability.",
  },
  "src/app/api/insights/biomarker-assessment/route.ts": {
    kind: "mixed",
    capabilities: ["statusText"],
    why: "Status family: the card is data, the note inside it follows the capability (200 with a null note otherwise).",
  },
  "src/app/api/insights/blood-pressure-status/route.ts": {
    kind: "mixed",
    capabilities: ["statusText"],
    why: "Status family: the card is data, the note inside it follows the capability (200 with a null note otherwise).",
  },
  "src/app/api/insights/bmi-status/route.ts": {
    kind: "mixed",
    capabilities: ["statusText"],
    why: "Status family: the card is data, the note inside it follows the capability (200 with a null note otherwise).",
  },
  "src/app/api/insights/medication-compliance-status/route.ts": {
    kind: "mixed",
    capabilities: ["statusText"],
    why: "Status family: the card is data, the note inside it follows the capability (200 with a null note otherwise).",
  },
  "src/app/api/insights/metric-status/route.ts": {
    kind: "mixed",
    capabilities: ["statusText"],
    why: "Status family: the card is data, the note inside it follows the capability (200 with a null note otherwise).",
  },
  "src/app/api/insights/mood-status/route.ts": {
    kind: "mixed",
    capabilities: ["statusText"],
    why: "Status family: the card is data, the note inside it follows the capability (200 with a null note otherwise).",
  },
  "src/app/api/insights/pulse-status/route.ts": {
    kind: "mixed",
    capabilities: ["statusText"],
    why: "Status family: the card is data, the note inside it follows the capability (200 with a null note otherwise).",
  },
  "src/app/api/insights/weight-status/route.ts": {
    kind: "mixed",
    capabilities: ["statusText"],
    why: "Status family: the card is data, the note inside it follows the capability (200 with a null note otherwise).",
  },
  "src/app/api/workouts/[id]/route.ts": {
    kind: "mixed",
    capabilities: ["workoutInsights"],
    why: "The workout is data; only the stored Activity Insight paragraph follows the capability.",
  },
};

/**
 * Routes that are data and must never import an AI gate. Every entry is a
 * claim the guard checks against the file.
 */
export const DATA_ROUTES: Readonly<Record<string, string>> = {
  // The design's list of formerly AI-gated data reads and writes.
  "src/app/api/insights/derived/batch/route.ts":
    "Deterministic scores and assessments for the whole grid.",
  "src/app/api/insights/ecg/route.ts":
    "Device recordings, list and live ingest: an upload is never refused because AI is off.",
  "src/app/api/insights/ecg/[id]/route.ts": "One device recording's waveform.",
  "src/app/api/insights/rhythm-events/route.ts":
    "The device's own flagged events, verbatim.",
  "src/app/api/insights/cards/route.ts":
    "Rule alerts from the threshold engine; `provider` is `rules`.",
  "src/app/api/insights/correlations/route.ts":
    "Statistics; the retired Correlations switch gated no model output.",
  "src/app/api/insights/coach-read/route.ts":
    "Baseline placement and the strongest association, both computed.",
  "src/app/api/insights/coach/seen/route.ts":
    "A timestamp on the caller's own row.",
  "src/app/api/insights/coach/facts/route.ts":
    "Stored Coach facts: readable and erasable while the Coach is unavailable.",
  "src/app/api/insights/coach/facts/[id]/route.ts": "Erasing one stored fact.",
  "src/app/api/insights/chat/[id]/route.ts":
    "One stored conversation: read, rename, delete.",
  "src/app/api/insights/chat/messages/[id]/feedback/route.ts":
    "A rating on a message that already exists.",
  "src/app/api/insights/breathing-screening/route.ts":
    "Device breathing data, owned by the sleep module.",
  "src/app/api/insights/labs-changes/route.ts":
    "Lab deltas, owned by the labs module.",
  "src/app/api/insights/health-status/route.ts":
    "Baseline drift, computed over core vitals.",
  "src/app/api/insights/pulse/intraday/route.ts":
    "The day's pulse shape, a core vital.",
  "src/app/api/insights/patterns/route.ts": "Stored correlation statistics.",
  "src/app/api/insights/patterns/[id]/route.ts":
    "Dismissing a stored correlation.",
  "src/app/api/daily/digest/route.ts":
    "The Today digest is data; its AI parts are masked by the loader through the capability resolver, never refused.",
  "src/app/api/daily/digest/dismiss/route.ts": "Dismissing a Today rail item.",
  "src/app/api/dashboard/snapshot/route.ts":
    "The dashboard is data; the briefing inside it is masked per read by the snapshot loader, never refused.",
  // Configuration and other non-AI routes in the insights tree.
  "src/app/api/insights/feedback/route.ts":
    "Feedback on a recommendation that already exists.",
  "src/app/api/insights/glp1-plateau/route.ts":
    "A deterministic plateau detector over weight and dose history.",
  "src/app/api/insights/glp1-timeline/route.ts":
    "A merge of medication events.",
  "src/app/api/insights/layout/route.ts": "The person's tile layout.",
  "src/app/api/insights/provider-chain/route.ts":
    "AI configuration: editable while AI is unavailable, so it can be set up.",
  "src/app/api/insights/settings/route.ts":
    "AI configuration: editable while AI is unavailable, so it can be set up.",
  "src/app/api/insights/targets/route.ts": "Threshold reference values.",
  // The Coach tree's own data: gated on the `coach` module, never on AI.
  "src/app/api/coach/about-me/adopt/route.ts":
    "Folds a typed answer into the stored profile; no model call.",
  "src/app/api/coach/about-me/questions/route.ts":
    "Reads or dismisses stored questions; no model call.",
  "src/app/api/coach/plans/route.ts": "Stored Coach plans.",
  "src/app/api/coach/plans/[id]/route.ts": "One stored Coach plan.",
  "src/app/api/coach/reminders/route.ts": "Stored Coach reminders.",
  "src/app/api/coach/reminders/[id]/route.ts": "One stored Coach reminder.",
  "src/app/api/coach/reminder-suggestions/route.ts":
    "Deterministic reminder suggestions.",
  "src/app/api/coach/suggested-actions/route.ts":
    "Confirms a proposed action from a closed allowlist; no model call.",
};

/**
 * Routes in the AI trees whose AI gating another change owns. Each still has
 * to be classified; the entry names who moves it. An entry that starts
 * calling a capability gate fails the guard until it moves to `AI_ROUTES`.
 */
export const PENDING_ROUTES: Readonly<Record<string, string>> = {
  "src/app/api/insights/chat/fenced/route.ts":
    "Document chat inside a conversation: moves to `coach` and `documentAi` with the document-extraction routes.",
  "src/app/api/insights/chat/[id]/attachments/route.ts":
    "Attaching a document to a conversation: moves to `coach` and `documentAi` with the document-extraction routes.",
  "src/app/api/insights/chat/[id]/attachments/[documentId]/route.ts":
    "Detaching a document: removal of one's own data, stays ungated once the document routes move.",
};

/** The trees in which every route has to be classified above. */
export const AI_ROUTE_TREES = [
  "src/app/api/insights",
  "src/app/api/coach",
  "src/app/api/daily",
] as const;
