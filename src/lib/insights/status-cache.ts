import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  hasUsableStatusProvider,
  statusConsentBlocksGeneration,
} from "@/lib/insights/status-provider";
import {
  enqueueStatusGeneration,
  type InsightStatusScope,
} from "@/lib/jobs/insight-status-generate-shared";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import {
  discoveryMeasurementTypes,
  DISCOVERY_BEHAVIOURS,
  DISCOVERY_OUTCOMES,
} from "@/lib/insights/correlation-discovery";
import { MAX_CUSTOM_CORRELATION_CHANNELS } from "@/lib/insights/correlation-channel-series";
import { annotate } from "@/lib/logging/context";
import { delegatedGenerationSuppressed } from "@/lib/sharing/delegated-generation";
import type { SupportedLocale } from "@/lib/insights/status-shared";

/**
 * v1.18.11 (P6-tighten) — the measurement types the FDR correlation-discovery
 * matrix scans (`correlation-discovery.ts`). A status card whose prompt folds
 * the surviving cross-metric correlations (`getRelevantCorrelationsForMetric`)
 * can have a NEW correlation surface purely because one of these channels
 * gained paired data — with no change to the card's own metric rows. The input
 * gate must therefore fingerprint these channels too, or a freshly discovered
 * relation would be silently skipped for the day. `MOOD` is mood-entry backed
 * (folded separately via `includeMood`), so it is excluded from the
 * measurement-type set here.
 *
 * v1.21.0 (FDREXTEND) — `MEDICATION_COMPLIANCE` (dose-history ledger) and
 * `SYMPTOM_SEVERITY` (illness day-log) are likewise NON-measurement channels;
 * `discoveryMeasurementTypes` excludes them too, or the `type IN (...)` groupBy
 * below would try to cast a non-enum string to `MeasurementType` and error.
 * Their own data changes still flip a card's gate through their source models —
 * they simply do not belong in the measurement fingerprint set.
 */
const CORRELATION_CHANNEL_TYPES: readonly MeasurementType[] =
  discoveryMeasurementTypes([
    ...DISCOVERY_BEHAVIOURS,
    ...DISCOVERY_OUTCOMES,
  ]) as MeasurementType[];

/**
 * Shared cache-read for the seven `*-status.ts` insight generators.
 *
 * Every generator persists its assessment as an `auditLog` row keyed
 * `insights.<metric>-status.<locale>` whose `details` JSON carries
 * `{ dateKey, locale, text, providerType, model, tokensUsed }`. On the
 * next mount the generator reads the most recent such row and, if it is
 * still for today, serves it without re-hitting the provider.
 *
 * The timeout fallback used to poison this read. When a provider call
 * exceeded the status budget the route persisted a `model:"timeout-stub"`
 * / `timeout:true` row carrying the generic no-key text under the SAME
 * `text` field a real assessment uses. The cache-read only checked
 * `dateKey === today && text` — so the stub looked like a valid
 * assessment and stuck until midnight, hiding the real data-driven text
 * for the rest of the day.
 *
 * `readFreshStatusText` is the one cache-read every standard generator
 * shares. It rejects stubs explicitly so a single stall no longer pins
 * the fallback for the day, and a fresh generation is attempted instead.
 */

/**
 * The single source of truth for the per-status cache-action shape.
 *
 * Every per-metric assessment is persisted as an `auditLog` row whose
 * `action` is `insights.<scope>-status.<locale>`. The shape IS the cache
 * key, so building it by hand in multiple places risks the same silent
 * drift the queryKey factory guards against on the client. `statusCacheAction`
 * is the one builder.
 */
export function statusCacheAction(scope: string, locale: string): string {
  return `insights.${scope}-status.${locale}`;
}

interface ParsedStatusCache {
  dateKey?: string;
  locale?: string;
  text?: string;
  summary?: string;
  providerType?: string;
  model?: string;
  tokensUsed?: number | null;
  timeout?: boolean;
  /** v1.8.3 — ISO timestamp before which a timeout stub suppresses re-enqueue. */
  retryAt?: string;
  /** Explicit generated/negative cache classification for new rows. */
  statusKind?: "generated" | "negative";
  /** Whether the producer may be retried at the time this row is read. */
  retryable?: boolean;
  /** Generated rows expire once the caller's current day differs. */
  expiresAfterDateKey?: string;
  /** Stable non-sensitive negative-cache reason code. */
  reason?: "timeout" | "error" | "screened";
  /** v1.16.8 — fingerprint of the data snapshot the text was generated from. */
  snapshotHash?: string;
  /** v1.18.11 (P6) — cheap fingerprint of the salient inputs (count + newest). */
  inputHash?: string;
}

/**
 * A cached row is a timeout stub when it carries the sentinel marker the
 * timeout path writes. Either flag is sufficient — older stub rows may
 * predate one of the two markers, so both are honoured.
 */
export function isTimeoutStub(parsed: {
  model?: string;
  timeout?: boolean;
}): boolean {
  return parsed.model === "timeout-stub" || parsed.timeout === true;
}

export interface FreshStatusCacheHit {
  kind: "generated";
  text: string;
  updatedAt: string;
  retryable: false;
  expiresAfterDateKey: string;
}

/**
 * Read the latest cached assessment for `(userId, cacheAction)` and
 * return its text only when it is (a) for today and (b) NOT a timeout
 * stub. Returns `null` on a miss, a stale day, a stub, or a malformed
 * payload — every one of those means the caller should regenerate.
 *
 * `force` short-circuits to `null` so a forced regeneration never reads
 * the cache. The DB read is still skipped entirely under `force` to
 * keep the forced path cheap.
 */
export async function readFreshStatusText(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  force: boolean;
}): Promise<FreshStatusCacheHit | null> {
  const { userId, cacheAction, todayKey, force } = args;
  if (force) return null;

  const latestCache = await prisma.auditLog.findFirst({
    where: { userId, action: cacheAction },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });
  if (!latestCache?.details) return null;

  try {
    const parsed = JSON.parse(latestCache.details) as ParsedStatusCache;
    if (parsed.dateKey !== todayKey) return null;
    if (isTimeoutStub(parsed)) return null;
    if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
      return null;
    }
    return {
      kind: "generated",
      text: parsed.text,
      updatedAt: latestCache.createdAt.toISOString(),
      retryable: false,
      expiresAfterDateKey: parsed.expiresAfterDateKey ?? parsed.dateKey,
    };
  } catch {
    // Malformed cache payload — treat as a miss and regenerate.
    return null;
  }
}

/**
 * v1.16.8 — the content-hash regeneration gate for the per-status and
 * generic metric cards.
 *
 * A generator that has already gathered its data snapshot calls this
 * BEFORE the provider round-trip. When the latest cached assessment for
 * `(userId, cacheAction)` is a real (non-stub) text whose stored
 * `snapshotHash` equals the fresh snapshot's hash, nothing the prompt
 * sees has changed — so the gate re-persists the same text under
 * today's `dateKey` (a pure timestamp refresh that keeps the read path
 * and the ingest debounce satisfied) and returns it, and the caller
 * skips the LLM call entirely. Returns `null` on any miss (no prior
 * row, stub, empty text, missing or differing hash) — every one of
 * those means the caller should generate for real.
 *
 * This single gate is what turns the nightly warm, the forced warm, and
 * the ingest-driven regeneration into no-ops on unchanged data: each of
 * those paths forces past the same-day cache read, gathers the
 * snapshot, and lands here.
 *
 * Consent comes BEFORE the hash compare (mirroring the comprehensive
 * pipeline's consent-before-gate order): re-stamping a cached text
 * under today's `dateKey` presents it as a current AI assessment, so a
 * user who revoked the server-managed AI consent must not have old
 * text re-dated by an unchanged-data refresh. On a blocked consent the
 * gate misses, the generator proceeds to `runStatusCompletion`, and
 * that gate returns the no-key fallback without persisting anything.
 */
export async function refreshUnchangedStatusInsight(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  snapshotHash: string;
}): Promise<FreshStatusCacheHit | null> {
  if (await statusConsentBlocksGeneration(args.userId, "insights")) {
    annotate({
      action: { name: "insights.status.consent_required" },
      meta: { cache_action: args.cacheAction, gate: "unchanged-refresh" },
    });
    return null;
  }

  const latest = await prisma.auditLog.findFirst({
    where: { userId: args.userId, action: args.cacheAction },
    orderBy: { createdAt: "desc" },
    select: { details: true },
  });
  if (!latest?.details) return null;

  let parsed: ParsedStatusCache;
  try {
    parsed = JSON.parse(latest.details) as ParsedStatusCache;
  } catch {
    return null;
  }
  if (isTimeoutStub(parsed)) return null;
  if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    return null;
  }
  if (parsed.snapshotHash !== args.snapshotHash) return null;

  // Same data, valid text — refresh the cache row's day key so the
  // read path serves it as today's assessment and the ingest debounce
  // window restarts, without touching the provider.
  const created = await prisma.auditLog.create({
    data: {
      userId: args.userId,
      action: args.cacheAction,
      details: JSON.stringify({ ...parsed, dateKey: args.todayKey }),
    },
    select: { createdAt: true },
  });
  annotate({
    action: { name: "insights.status.skipped_unchanged" },
    meta: { cache_action: args.cacheAction },
  });
  return {
    kind: "generated",
    text: parsed.text,
    updatedAt: created.createdAt.toISOString(),
    retryable: false,
    expiresAfterDateKey: args.todayKey,
  };
}

/**
 * v1.18.11 (P6) — cheap input fingerprint for the slow-moving status
 * metrics (weight / BMI).
 *
 * The post-build content-hash gate (`refreshUnchangedStatusInsight`)
 * already skips the LLM on unchanged data, but it only runs AFTER the heavy
 * snapshot build (the bounded `findMany` + per-series rollup reads +
 * correlation math). For metrics that move on a weekly cadence that rebuild
 * is paid six days out of seven for nothing.
 *
 * This probe answers "did any salient input change since the cached
 * assessment?" with ONE grouped query — per salient type, the live row
 * `count` plus the newest `measuredAt`. A new or removed reading flips one
 * of those, which flips the hash; an idle day leaves it byte-identical. The
 * caller hashes the result and, on a match, skips the entire build. The
 * finer post-build snapshot gate stays in place for the cases this coarse
 * probe can't see (e.g. an in-place edit that keeps count + newest stamp).
 */
export async function computeStatusInputFingerprint(args: {
  userId: string;
  types: readonly MeasurementType[];
  /**
   * v1.18.11 (P6) — include the mood-entry table in the fingerprint. The
   * weight snapshot folds a mood-context block, so a mood change must flip
   * the input hash or the gate would skip a build whose prose could have
   * moved. Omit for metrics that don't read mood.
   */
  includeMood?: boolean;
  /**
   * v1.18.11 (P6-tighten) — include the FDR correlation-discovery channels
   * (`CORRELATION_CHANNEL_TYPES`) in the fingerprint. A card that folds the
   * surviving cross-metric correlations (via `getRelevantCorrelationsForMetric`)
   * can surface a NEW relation purely because a discovery channel — steps,
   * sleep, HRV, glucose, daylight, … — gained paired data, with NO change to
   * the card's own metric rows. Without this the input gate would re-stamp the
   * stale assessment and the freshly discovered correlation would never reach
   * the prose. Cheap: it widens the SAME grouped query by the channel type set
   * (no extra round-trip). `includeMood` is honoured for the mood arm of the
   * discovery matrix as before. Set on any card whose prompt carries a
   * relations block (i.e. whose metric is a discovery channel).
   */
  includeCorrelationChannels?: boolean;
  /**
   * v1.18.11 (P6) — extra non-measurement inputs the snapshot derives from
   * (e.g. BMI reads the profile `heightCm`). Folded into the hash so a
   * change to one of them flips the gate. Values must be JSON-stable.
   */
  extra?: Record<string, string | number | null>;
}): Promise<string> {
  // Widen the grouped query by the correlation-discovery channels when the
  // card folds a relations block, so a discovery-channel change flips the gate.
  // De-duplicate the union (a card's own type can also be a discovery channel)
  // so the `type IN (...)` list carries each type once.
  const groupTypes = args.includeCorrelationChannels
    ? Array.from(new Set<string>([...args.types, ...CORRELATION_CHANNEL_TYPES]))
    : [...args.types];

  const [grouped, mood, customMetrics] = await Promise.all([
    prisma.measurement.groupBy({
      by: ["type"],
      where: {
        userId: args.userId,
        type: { in: groupTypes as MeasurementType[] },
        deletedAt: null,
      },
      _count: { _all: true },
      _max: { measuredAt: true },
    }),
    args.includeMood
      ? prisma.moodEntry.aggregate({
          // Tombstoned rows are excluded here for the same reason they are in
          // the measurement arm above: this aggregate IS the freshness
          // fingerprint, so a deletion that leaves the count and the newest
          // timestamp untouched cannot invalidate the cached assessment, and
          // yesterday's text gets re-dated as today's over data that is gone.
          where: { userId: args.userId, deletedAt: null },
          _count: { _all: true },
          _max: { moodLoggedAt: true },
        })
      : Promise.resolve(null),
    args.includeCorrelationChannels
      ? prisma.customMetric.findMany({
          where: {
            userId: args.userId,
            deletedAt: null,
            correlationEnabled: true,
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: MAX_CUSTOM_CORRELATION_CHANNELS,
          select: {
            id: true,
            unit: true,
            updatedAt: true,
            _count: { select: { entries: { where: { deletedAt: null } } } },
            entries: {
              where: { deletedAt: null },
              orderBy: [{ measuredAt: "desc" }, { id: "desc" }],
              take: 1,
              select: { measuredAt: true, unit: true },
            },
          },
        })
      : Promise.resolve([]),
  ]);
  // Deterministic shape regardless of group order: sort by type, project a
  // stable `{ type, count, newest }` triple. `hashInsightSnapshot` sorts keys
  // and collapses Date → ISO, so the hash is order- and clock-stable.
  const fingerprint = grouped
    .map((row) => ({
      type: row.type,
      count: row._count._all,
      newest: row._max.measuredAt ? row._max.measuredAt.toISOString() : null,
    }))
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return hashInsightSnapshot({
    statusInput: fingerprint,
    ...(mood
      ? {
          mood: {
            count: mood._count._all,
            newest: mood._max.moodLoggedAt
              ? mood._max.moodLoggedAt.toISOString()
              : null,
          },
        }
      : {}),
    customMetrics: customMetrics.map((metric) => ({
      id: metric.id,
      unit: metric.unit,
      updatedAt: metric.updatedAt.toISOString(),
      count: metric._count.entries,
      newest: metric.entries[0]?.measuredAt.toISOString() ?? null,
      newestUnit: metric.entries[0]?.unit ?? null,
    })),
    ...(args.extra ? { extra: args.extra } : {}),
  });
}

/**
 * v1.18.11 (P6) — the INPUT gate for slow-moving status metrics.
 *
 * Runs BEFORE the snapshot build. When the latest cached assessment is a
 * real (non-stub) text whose stored `inputHash` equals the freshly probed
 * one, nothing the prompt could see has changed, so the gate re-stamps that
 * text under today's `dateKey` and returns it — the caller then skips the
 * whole gather AND the provider call. Returns `null` on any miss (no prior
 * row, stub, empty text, missing or differing `inputHash`, or a forced
 * regeneration), in which case the caller proceeds to the normal build +
 * the finer post-build content-hash gate.
 *
 * Consent is checked first, mirroring `refreshUnchangedStatusInsight`:
 * re-dating a cached text presents it as current, so a user who revoked the
 * server-managed AI consent must never have stale text re-stamped by an
 * unchanged-input refresh.
 */
export async function gateUnchangedStatusInput(args: {
  userId: string;
  cacheAction: string;
  todayKey: string;
  inputHash: string;
  force: boolean;
}): Promise<FreshStatusCacheHit | null> {
  if (args.force) return null;

  if (await statusConsentBlocksGeneration(args.userId, "insights")) {
    annotate({
      action: { name: "insights.status.consent_required" },
      meta: { cache_action: args.cacheAction, gate: "unchanged-input" },
    });
    return null;
  }

  const latest = await prisma.auditLog.findFirst({
    where: { userId: args.userId, action: args.cacheAction },
    orderBy: { createdAt: "desc" },
    select: { details: true },
  });
  if (!latest?.details) return null;

  let parsed: ParsedStatusCache;
  try {
    parsed = JSON.parse(latest.details) as ParsedStatusCache;
  } catch {
    return null;
  }
  if (isTimeoutStub(parsed)) return null;
  if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    return null;
  }
  if (!parsed.inputHash || parsed.inputHash !== args.inputHash) return null;

  // Same inputs, valid text — re-stamp the day key WITHOUT rebuilding the
  // snapshot or calling the provider. Preserve every field (incl. the prior
  // `snapshotHash` + `inputHash`) so the next day's gates still match.
  const created = await prisma.auditLog.create({
    data: {
      userId: args.userId,
      action: args.cacheAction,
      details: JSON.stringify({ ...parsed, dateKey: args.todayKey }),
    },
    select: { createdAt: true },
  });
  annotate({
    action: { name: "insights.status.skipped_unchanged" },
    meta: { cache_action: args.cacheAction, gate: "input" },
  });
  return {
    kind: "generated",
    text: parsed.text,
    updatedAt: created.createdAt.toISOString(),
    retryable: false,
    expiresAfterDateKey: args.todayKey,
  };
}

export interface LastGoodStatusHit {
  text: string;
  updatedAt: string;
}

/**
 * v1.8.7 — read the most recent NON-stub assessment for `(userId,
 * cacheAction)` regardless of which day it was generated. This is the
 * stale-while-revalidate source: when today's cache is a miss the
 * read-only path can still serve yesterday's (or older) good text
 * instantly while a fresh generation is warmed out of band, so opening a
 * category never drops to the "preparing" skeleton if an assessment was
 * ever produced. Returns `null` only when there is genuinely no prior
 * assessment (or every prior row is a timeout stub / malformed).
 */
export async function readLastGoodStatusText(args: {
  userId: string;
  cacheAction: string;
}): Promise<LastGoodStatusHit | null> {
  const { userId, cacheAction } = args;
  const rows = await prisma.auditLog.findMany({
    where: { userId, action: cacheAction },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { createdAt: true, details: true },
  });
  for (const row of rows) {
    if (!row.details) continue;
    try {
      const parsed = JSON.parse(row.details) as ParsedStatusCache;
      if (isTimeoutStub(parsed)) continue;
      if (typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
        continue;
      }
      return { text: parsed.text, updatedAt: row.createdAt.toISOString() };
    } catch {
      // Malformed payload — skip and look further back.
      continue;
    }
  }
  return null;
}

/**
 * Outcome of the read-only cache-miss resolution. The generators map this
 * onto their public return shape:
 *   - `no-provider` → `{ hasProvider: false, text: <no-key fallback> }`
 *   - `preparing`   → `{ hasProvider: true, text: <last-good|null>, preparing: true }`
 *
 * v1.8.7 — `preparing` now carries the last good assessment (if any) so
 * the card renders the previous text immediately (stale-while-revalidate)
 * instead of a skeleton while the worker re-warms the cache.
 *
 * v1.9.0 — `revalidating` is true only when last-good text is served AND a
 * fresh generation was actually enqueued (the open-card refresh case). When
 * the served text is terminal the card otherwise stops polling and never
 * sees the freshly-warmed assessment until a remount; the flag keeps the
 * bounded poll alive until the new row lands. It is false on the
 * suppressed-stub branch (no enqueue, so nothing is in flight) and whenever
 * there is no last-good text (that path already polls via `preparing`).
 */
export type ReadOnlyMissOutcome =
  | { kind: "no-provider" }
  // v1.16.13 — a provider IS configured, but it resolves via the operator's
  // server-managed key and the user has no active consent receipt, so the
  // generation gate (`assertConsentForChain` / `runStatusCompletion`) would
  // serve the no-key fallback. Distinct from `no-provider` so the status DTO
  // can render an honest "consent required" signal instead of conflating it
  // with "no AI configured at all".
  | { kind: "consent-missing" }
  | {
      kind: "preparing";
      lastGood: LastGoodStatusHit | null;
      revalidating: boolean;
    };

/**
 * v1.8.3 — resolve what a read-only status generation should return on a
 * cache miss WITHOUT running the heavy SQL gather or the blocking LLM
 * round-trip. This is the core of the holistic freeze fix: a navigation
 * request must never await an uncapped provider call.
 *
 * On a miss the route either:
 *   - finds no usable provider → returns `no-provider` (the card shows the
 *     no-key fallback; nothing to generate), or
 *   - finds a provider → fire-and-forget enqueues a generation job and
 *     returns `preparing` (the card shows a preparing state and the client
 *     polls until the worker warms the cache).
 *
 * The provider probe is a cheap chain-resolve (no completion), so the GET
 * stays sub-second even on a cold cache.
 */
export async function resolveReadOnlyStatusMiss(args: {
  userId: string;
  metric: InsightStatusScope;
  locale: SupportedLocale;
}): Promise<ReadOnlyMissOutcome> {
  // v1.37.0 — the one gate on the delegated path, and it sits here rather
  // than in the ten generators that reach this function precisely because it
  // is one gate: a generator added next year inherits it without knowing it
  // exists. A manager holding a MANAGE grant may READ the record's generated
  // assessments; the miss behind that read must not ship the owner's data to
  // the owner's provider on the owner's budget. Served the same way the
  // negative-cache branch below serves it: last-good text if there is any,
  // `preparing` if there is not, and nothing enqueued either way.
  if (delegatedGenerationSuppressed()) {
    const lastGood = await readLastGoodStatusText({
      userId: args.userId,
      cacheAction: statusCacheAction(args.metric, args.locale),
    });
    annotate({
      action: { name: "insights.status.preparing" },
      meta: {
        metric: args.metric,
        suppressed_enqueue: true,
        delegated: true,
      },
    });
    return { kind: "preparing", lastGood, revalidating: false };
  }

  const hasProvider = await hasUsableStatusProvider(args.userId);
  if (!hasProvider) return { kind: "no-provider" };

  // v1.16.13 — a provider is configured but the server-managed consent gate
  // would block egress (no active receipt for the surface). Surface this as
  // a distinct outcome so the card renders an honest "consent required"
  // signal rather than the generic no-key fallback. Enqueuing here would be
  // wasted work — the generator's own gate would short-circuit to `none`.
  if (await statusConsentBlocksGeneration(args.userId, "insights")) {
    annotate({
      action: { name: "insights.status.consent_required" },
      meta: { metric: args.metric, read_only_miss: true },
    });
    return { kind: "consent-missing" };
  }

  const cacheAction = statusCacheAction(args.metric, args.locale);

  // v1.8.7 — stale-while-revalidate. Surface the last good (non-stub)
  // assessment for this scope so the card renders the previous text
  // immediately instead of a skeleton while a refresh is warmed. Null when
  // no assessment was ever produced — only then does the card show
  // "preparing"/"no analysis yet".
  const lastGood = await readLastGoodStatusText({
    userId: args.userId,
    cacheAction,
  });

  // v1.8.3 — honour the short-TTL negative cache. If the worker recently
  // hit a provider stall it wrote a `retryAt` stub; re-enqueuing on every
  // navigation while the provider is still degraded would be a storm. While
  // the stub is fresh, stay in `preparing` without enqueuing; once it goes
  // stale (or never existed) enqueue a fresh generation.
  const negativeCache = await readStatusNegativeCache({
    userId: args.userId,
    cacheAction,
  });
  if (negativeCache && !negativeCache.retryable) {
    annotate({
      action: { name: "insights.status.preparing" },
      meta: { metric: args.metric, suppressed_enqueue: true },
    });
    // No enqueue on this branch — nothing is in flight, so the open card has
    // nothing to revalidate against. It still polls via `preparing` when
    // there is no last-good text to show.
    return { kind: "preparing", lastGood, revalidating: false };
  }

  // Enqueue out of band — do NOT await an LLM here. The enqueue itself is
  // best-effort and de-duped per (user, metric, locale).
  await enqueueStatusGeneration({
    userId: args.userId,
    metric: args.metric,
    locale: args.locale,
  });
  annotate({
    action: { name: "insights.status.preparing" },
    meta: { metric: args.metric, stale_served: lastGood !== null },
  });
  // A fresh generation is now in flight. When last-good text is served the
  // payload is otherwise terminal (`preparing` is false), so the open card
  // would stop polling and never pick up the warmed assessment. Signal
  // `revalidating` so the bounded poll stays alive until the new row lands.
  return { kind: "preparing", lastGood, revalidating: lastGood !== null };
}

/**
 * True when the most recent cache row for `(userId, cacheAction)` is a
 * timeout stub whose `retryAt` is still in the future. Used by the
 * read-only resolver to suppress a re-enqueue storm while a provider is
 * degraded. A stub without `retryAt` (legacy) is treated as stale so the
 * resolver retries, matching the pre-v1.8.3 "transient miss" behaviour.
 */
export interface StatusNegativeCache {
  kind: "negative";
  reason: "timeout" | "error" | "screened";
  retryAt: string;
  retryable: boolean;
}

/**
 * Read the latest negative-cache policy without exposing provider errors or
 * assessment content. `retryable` flips only when the explicit `retryAt`
 * boundary has passed; legacy/malformed stubs are treated as absent so the
 * next request may recover.
 */
export async function readStatusNegativeCache(args: {
  userId: string;
  cacheAction: string;
}): Promise<StatusNegativeCache | null> {
  const latest = await prisma.auditLog.findFirst({
    where: { userId: args.userId, action: args.cacheAction },
    orderBy: { createdAt: "desc" },
    select: { details: true },
  });
  if (!latest?.details) return null;
  try {
    const parsed = JSON.parse(latest.details) as ParsedStatusCache;
    if (!isTimeoutStub(parsed)) return null;
    if (typeof parsed.retryAt !== "string") return null;
    const retryAtMs = new Date(parsed.retryAt).getTime();
    if (!Number.isFinite(retryAtMs)) return null;
    const reason =
      parsed.reason === "error" || parsed.reason === "screened"
        ? parsed.reason
        : "timeout";
    return {
      kind: "negative",
      reason,
      retryAt: parsed.retryAt,
      retryable: retryAtMs <= Date.now(),
    };
  } catch {
    return null;
  }
}
