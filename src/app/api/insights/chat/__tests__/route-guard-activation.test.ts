import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * CHARACTERISATION — when the Coach's numeric grounding guard is armed, and
 * when it is not.
 *
 * The guard rewrites any figure in the reply that the turn's Grounding Ledger
 * cannot account for. It runs only when `activatingPayloads` is non-empty, and
 * on the tool path that array comes solely from `loop.toolResults`. A tool that
 * found nothing at all resolves to `{ present: false, reason: "none" }` with no
 * `available` payload, and `loop.ts` drops that shape from `toolResults`
 * (pinned in `tools-loop-miss-payloads.test.ts`). The no-tools snapshot
 * fallback is populated only in the non-tool-mode branch, so on the tool path
 * there is nothing to fall back to.
 *
 * The consequence, pinned below: on a tool-mode turn where every tool missed —
 * i.e. exactly when the user has no data for what they asked about — a figure
 * the model invented is streamed and persisted verbatim, and the reply carries
 * no `unverifiedFigures` marker, so it reads to the user as fully checked.
 *
 * These tests assert the CURRENT behaviour, not the desired one. If the
 * activation gate is widened so the guard covers the all-missed turn, they will
 * fail — that failure is the fix landing, and the assertions should be flipped
 * to the safe expectation at that point.
 *
 * The first test is the control: with one present tool result the guard is
 * armed and the same invented figure is stripped.
 */

const SNAPSHOT_JSON = '{"bp":{"aggregate":{"mean":128}}}';

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1", locale: "en" } })),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(async () => ({ enabled: true })),
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/feature-flags", () => ({
  requireAssistantSurface: vi.fn(async () => undefined),
}));
vi.mock("@/lib/api-response", () => ({
  apiError: (error: string, status: number) => ({ data: null, error, status }),
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: vi.fn(),
}));
vi.mock("@/lib/logging/redact", () => ({
  redactSecrets: (s: string) => s,
  redactOptional: (s: unknown) => s,
}));
vi.mock("@/lib/auth/audit", () => ({ auditLog: vi.fn() }));
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(async () => ({ coachPrefsJson: null })) },
    coachConversation: { findFirst: vi.fn(async () => ({ id: "c1" })) },
  },
}));

const { checkRateLimit } = vi.hoisted(() => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit }));
vi.mock("@/lib/i18n/server-locale", () => ({
  resolveServerLocale: vi.fn(async () => "en"),
}));

const { runStreamingRawCompletionWithFallback } = vi.hoisted(() => ({
  runStreamingRawCompletionWithFallback: vi.fn(),
}));
vi.mock("@/lib/ai/provider-runner", () => ({
  AllProvidersFailedError: class extends Error {},
  runStreamingRawCompletionWithFallback,
}));

const { resolveProviderChain } = vi.hoisted(() => ({
  resolveProviderChain: vi.fn(),
}));
vi.mock("@/lib/ai/provider", () => ({
  resolveProviderChain,
  resolveProvider: vi.fn(),
}));

const { assertConsentForChain } = vi.hoisted(() => ({
  assertConsentForChain: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/consent-guard", () => ({ assertConsentForChain }));
vi.mock("@/lib/ai/prompts/insight-generator", () => ({ PROMPT_VERSION: "x" }));
vi.mock("@/lib/ai/ai-budgets", () => ({
  AI_BUDGETS: { coach: { maxTokens: 1500, temperature: 0.4 } },
}));

vi.mock("@/lib/ai/coach/types", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/coach/types")>(
    "@/lib/ai/coach/types",
  );
  return actual;
});

const { fetchConversationWithMessages } = vi.hoisted(() => ({
  fetchConversationWithMessages: vi.fn(),
}));
vi.mock("@/lib/ai/coach/persistence", () => ({
  appendMessage: vi.fn(async () => ({ id: "m1" })),
  createConversation: vi.fn(async () => ({ id: "c1" })),
  fetchConversationWithMessages,
  listConversations: vi.fn(),
}));
vi.mock("@/lib/ai/coach/coach-memory-shared", () => ({
  enqueueCoachMemoryRefresh: vi.fn(),
}));
vi.mock("@/lib/ai/coach/facts", () => ({
  storeDeterministicFacts: vi.fn(async () => undefined),
}));

// Guard II — the schedule read. Empty here; the schedule-gated dose rule is
// unit-tested in the outbound-screen suite.
vi.mock("@/lib/medications/scheduled-doses", () => ({
  getScheduledDoseValues: vi.fn(async () => []),
}));

const { reserveBudget, reconcileSpend } = vi.hoisted(() => ({
  reserveBudget: vi.fn(async () => ({ allowed: true, reserved: 3000 })),
  reconcileSpend: vi.fn(async () => undefined),
}));
vi.mock("@/lib/ai/coach/budget", () => ({
  buildDateKey: vi.fn(() => "2026-07-23"),
  reserveBudget,
  reconcileSpend,
  resolveDailyCap: vi.fn(() => 2_000_000),
}));

const { detectRefusal } = vi.hoisted(() => ({
  detectRefusal: vi.fn(() => ({ refuse: false })),
}));
vi.mock("@/lib/ai/coach/refusal", () => ({ detectRefusal }));
vi.mock("@/lib/ai/coach/outbound-guard", () => ({
  screenCoachReply: vi.fn(() => ({ block: false })),
  coachOutboundFallback: vi.fn(() => "fallback"),
}));
vi.mock("@/lib/ai/coach/system-prompt", () => ({
  getCoachSystemPrompt: vi.fn(() => "SYSTEM"),
}));
vi.mock("@/lib/ai/coach/about-me", () => ({
  getSelfContextTextForUser: vi.fn(async () => null),
}));
vi.mock("@/lib/ai/coach/snapshot", () => ({
  buildCoachSnapshot: vi.fn(async () => ({
    snapshotJson: SNAPSHOT_JSON,
    sections: { bloodPressure: { aggregate: { mean: 128 } } },
    provenance: { windows: ["last30days"], metrics: ["bp"] },
    referenceGrounding: "REFERENCE RANGES",
  })),
}));
vi.mock("@/lib/workouts/hr-series", () => ({
  buildWorkoutHrSeries: vi.fn(async () => null),
}));
vi.mock("@/lib/workouts/zones", () => ({
  computeZones: vi.fn(() => null),
  hrMaxFromAge: vi.fn(() => 185),
  parseWhoopZoneDurations: vi.fn(() => null),
}));
vi.mock("@/lib/workouts/sport-context", () => ({
  buildSportContext: vi.fn(async () => null),
}));

const {
  buildCoachDataInventory,
  renderDataInventory,
  renderFocusHint,
  runCoachToolLoop,
} = vi.hoisted(() => ({
  buildCoachDataInventory: vi.fn(async () => ({
    entries: [],
    restMode: false,
    cycleEnabled: false,
    window: "last30days",
    probeScope: { sources: ["bp"], window: "last30days" },
  })),
  renderDataInventory: vi.fn(() => "DATA INVENTORY\n- blood pressure: present"),
  renderFocusHint: vi.fn(() => ""),
  runCoachToolLoop: vi.fn(),
}));
vi.mock("@/lib/ai/coach/tools", () => ({
  COACH_TOOL_DEFS: [{ name: "get_metric_series" }],
  MAX_ROUNDS: 3,
  buildCoachDataInventory,
  renderDataInventory,
  renderFocusHint,
  buildToolModeAddendum: vi.fn(() => "TOOL ADDENDUM"),
  runCoachToolLoop,
}));

const { parseKeyValuesSentinel } = vi.hoisted(() => ({
  parseKeyValuesSentinel: vi.fn(),
}));
vi.mock("@/lib/ai/coach/keyvalues", () => ({ parseKeyValuesSentinel }));
const { parseSuggestReminder } = vi.hoisted(() => ({
  parseSuggestReminder: vi.fn(),
}));
vi.mock("@/lib/ai/coach/suggest-reminder", () => ({ parseSuggestReminder }));
vi.mock("@/lib/ai/coach/suggest-gate", () => ({ gateSuggestion: vi.fn() }));
vi.mock("@/lib/validations/coach-prefs", () => ({
  parseCoachPrefs: vi.fn(() => ({ defaultWindow: undefined })),
  DEFAULT_REMINDER_SUGGESTION_PREFS: {},
}));

const { appendMessage } = await import("@/lib/ai/coach/persistence");

const sse = vi.hoisted(() => ({ done: Promise.resolve() as Promise<unknown> }));
vi.mock("@/lib/sse/create-stream", () => ({
  createSseStream: (
    producer: (c: {
      signal: { aborted: boolean };
      enqueue: () => void;
    }) => void | Promise<void>,
  ) => {
    sse.done = Promise.resolve(
      producer({ signal: { aborted: false }, enqueue: () => {} }),
    );
    return new ReadableStream();
  },
}));

import { POST } from "../route";

const post = POST as unknown as (req: Request) => Promise<Response>;

function chatReq(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/insights/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Force the model's assembled prose through the sentinel/suggest parsers. */
function stubReply(prose: string, toolResults: unknown[]): void {
  parseKeyValuesSentinel.mockReturnValue({
    prose,
    keyValues: [],
    malformed: false,
    malformedEntries: [],
  });
  parseSuggestReminder.mockReturnValue({ prose });
  runCoachToolLoop.mockImplementation(async () => ({
    result: { content: prose, tokensUsed: 80, model: "m" },
    workingProviderType: "anthropic",
    totalTokens: 80,
    rounds: 1,
    toolTrace: [{ name: "get_metric_series", present: true }],
    toolResults,
  }));
}

function assistantContent(): string {
  const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
  const assistant = calls.find(
    (c) => (c[0] as { role: string }).role === "assistant",
  );
  return (assistant?.[0] as { content: string }).content;
}

function assistantProvenance(): Record<string, unknown> | null | undefined {
  const calls = (appendMessage as ReturnType<typeof vi.fn>).mock.calls;
  const assistant = calls.find(
    (c) => (c[0] as { role: string }).role === "assistant",
  );
  return (
    assistant?.[0] as {
      metricSource?: Record<string, unknown> | null;
    }
  ).metricSource;
}

describe("coach chat — grounding-guard activation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveBudget.mockResolvedValue({ allowed: true, reserved: 3000 });
    detectRefusal.mockReturnValue({ refuse: false });
    checkRateLimit.mockResolvedValue({ allowed: true });
    assertConsentForChain.mockResolvedValue(undefined);
    resolveProviderChain.mockResolvedValue([
      { providerType: "anthropic", instance: {} },
    ]);
    fetchConversationWithMessages.mockResolvedValue({
      id: "c1",
      attachmentCount: 0,
      summary: null,
      messages: [],
    });
  });

  it("CONTROL — one present tool result arms the guard: the invented figure is stripped", async () => {
    stubReply("Your sleep averaged 432 minutes last week.", [
      { present: true, data: { metric: "bp", aggregate: { avgSys30: 128 } } },
    ]);

    await post(chatReq({ conversationId: "c1", message: "how did I sleep?" }));
    await sse.done;

    expect(assistantContent()).not.toContain("432");
    expect(assistantContent()).toContain("[…]");
    expect(assistantProvenance()?.unverifiedFigures).toBe(1);
  });

  it("every tool missed: the guard stays dormant and the invented figure survives", async () => {
    // A pure miss never reaches `toolResults` (see tools-loop-miss-payloads),
    // so this is what the route sees when the record holds nothing.
    stubReply("Your sleep averaged 432 minutes last week.", []);

    await post(chatReq({ conversationId: "c1", message: "how did I sleep?" }));
    await sse.done;

    expect(assistantContent()).toBe(
      "Your sleep averaged 432 minutes last week.",
    );
    // No withheld-figure notice either, so the reply reads as verified.
    expect(assistantProvenance()?.unverifiedFigures).toBeUndefined();
  });

  it("the model called no tool at all: the guard stays dormant", async () => {
    const prose = "Your resting heart rate has been averaging 58 bpm.";
    parseKeyValuesSentinel.mockReturnValue({
      prose,
      keyValues: [],
      malformed: false,
      malformedEntries: [],
    });
    parseSuggestReminder.mockReturnValue({ prose });
    runCoachToolLoop.mockImplementation(async () => ({
      result: { content: prose, tokensUsed: 80, model: "m" },
      workingProviderType: "anthropic",
      totalTokens: 80,
      rounds: 1,
      toolTrace: [],
      toolResults: [],
    }));

    await post(chatReq({ conversationId: "c1", message: "how is my RHR?" }));
    await sse.done;

    expect(assistantContent()).toBe(prose);
    expect(assistantProvenance()?.unverifiedFigures).toBeUndefined();
  });
});
