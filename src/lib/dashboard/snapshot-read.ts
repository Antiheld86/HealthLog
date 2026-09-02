/**
 * Shared cached-snapshot read for the two dashboard entry points:
 *
 *   - `GET /api/dashboard/snapshot` (the client cell's endpoint), and
 *   - the dashboard RSC wrapper (`src/app/page.tsx`), which server-
 *     prefetches the same payload into a dehydrated TanStack cache so the
 *     first HTML paints real tiles instead of skeletons-until-JS.
 *
 * Both ride the SAME `caches.analytics` SWR cell, keyed by
 * `dashboardSnapshotCacheKey(userId)` plus the resolved locale, so an RSC
 * prefetch warms the API path and vice versa — the builder never runs twice
 * for one user within the TTL, and the write-invalidation semantics
 * (stale-sweep on measurement writes, hard evict on widget reorder) cover
 * both readers.
 *
 * "The SAME cell" rests on `caches` being pinned to `globalThis` in
 * `src/lib/cache/server-cache.ts`. These two entry points are bundled into
 * different layers, and while the registry sat in plain module state they
 * held one Map each: a write evicted the route handlers' copy and the home
 * page kept rendering the pre-write snapshot until it aged out. Anything
 * that moves the registry back off the global breaks this paragraph, not
 * just a performance assumption.
 */
import type { User } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import { dashboardSnapshotCacheKey } from "@/lib/cache/invalidate";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import {
  buildDashboardSnapshot,
  type DashboardSnapshot,
  type SnapshotUserInput,
} from "@/lib/dashboard/snapshot";
import { resolveServerLocale } from "@/lib/i18n/server-locale";
import type { Locale } from "@/lib/i18n/config";

/**
 * Per-key TTL for the snapshot cache entry. Strictly greater than the
 * client's 120 s refetch interval so a scheduled poll lands on a warm
 * entry instead of a guaranteed miss that re-runs the full builder. The
 * 60 s headroom absorbs interval jitter / a poll firing a touch late.
 * The analytics bucket's 60 s default still governs the slim / thick /
 * mood cells; only this key is lengthened. Eviction on writes is
 * unchanged (the `${userId}|` prefix sweep / point-delete both ignore
 * the TTL).
 */
export const SNAPSHOT_CACHE_TTL_MS = DASHBOARD_REFETCH_INTERVAL_MS + 60_000;

export interface SnapshotReadResult {
  body: DashboardSnapshot;
  /** The locale the snapshot was resolved (and cache-keyed) under. */
  locale: Locale;
}

export interface SnapshotReadOptions {
  /**
   * A locale already resolved by the caller. Background paths (the morning
   * briefing push) have no request to resolve one from and pass the job-side
   * resolution here so the digest and the push copy agree on a language.
   */
  locale?: Locale;
}

/**
 * Resolve locale + read the snapshot through the SWR cache for an already
 * authenticated user row. `time` lets the API route keep its per-sub-query
 * timing surface; the RSC prefetch passes none.
 */
export async function readDashboardSnapshotCached(
  user: User,
  time?: <T>(label: string, builder: () => Promise<T>) => Promise<T>,
  options: SnapshotReadOptions = {},
): Promise<SnapshotReadResult> {
  // `User` row is already in hand at both call sites — no extra round-trip.
  const snapshotUser: SnapshotUserInput = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    timezone: user.timezone,
    heightCm: user.heightCm,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender,
    glucoseUnit: user.glucoseUnit,
    onboardingTourCompleted: user.onboardingTourCompleted,
    disableCoach: user.disableCoach,
    insightsCachedText: user.insightsCachedText,
    insightsCachedAt: user.insightsCachedAt,
    insightsCachedLocale: user.insightsCachedLocale,
    dashboardWidgetsJson: user.dashboardWidgetsJson,
    sourcePriorityJson: user.sourcePriorityJson,
    thresholdsJson: user.thresholdsJson,
    healthScoreConfigJson: user.healthScoreConfigJson,
  };

  // v1.21.2 (A4) — the briefing recall + forward-look is locale-specific
  // prose, so the snapshot cache key carries the resolved locale: an EN and
  // a DE session never share a snapshot cell (and never see each other's
  // memory wording). The `${user.id}|` prefix still covers the key under
  // the measurement-write stale-sweep.
  const locale = await resolveServerLocale({
    userLocale: user.locale,
    override: options.locale ?? null,
  });

  // Stale-while-revalidate: a measurement write marks the analytics
  // bucket stale rather than hard-evicting the snapshot, so a busy iOS
  // sync serves the prior snapshot immediately (within the bucket's
  // stale window) while a single background recompute warms a fresh one
  // — the foreground request never pays the cold rebuild. Hard-evicting
  // writes (widget reorder) still drop the key outright, forcing a clean
  // miss + synchronous rebuild here.
  const body = await cachedSwr(
    caches.analytics as ServerCache<DashboardSnapshot>,
    // The invalidators sweep by `dashboardSnapshotCacheKey(userId)` prefix, so
    // the read has to build its key from that same function. Spelling the
    // string out here worked only for as long as nobody edited one side.
    `${dashboardSnapshotCacheKey(user.id)}|${locale}`,
    () => buildDashboardSnapshot(prisma, snapshotUser, { time, locale }),
    annotate,
    SNAPSHOT_CACHE_TTL_MS,
  );

  return { body, locale };
}
