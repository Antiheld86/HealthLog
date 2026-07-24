"use client";

/**
 * Client-side companion to `src/lib/optimistic-lock.ts` (server).
 *
 * The optimistic-concurrency recipe every guarded write follows, extracted
 * from the shipped `/api/dashboard/widgets` client (issue #581):
 *
 *   1. Read the freshest token straight from the query cache AT MUTATE TIME
 *      (`readUpdatedAtToken`) — not a render snapshot — so it reflects
 *      whatever the last settled write or refetch advanced it to.
 *   2. Echo it on the write body as `baseUpdatedAt` (`withBaseToken`); omit
 *      the field entirely when no token is known yet, which takes the
 *      server's backward-compatible unconditional write.
 *   3. On a 409 (`isConflict`), invalidate the read so the token advances,
 *      then either keep the draft (explicit-Save surfaces) or roll back the
 *      optimistic delta (instant-write surfaces) and re-apply against fresh
 *      state.
 *
 * No `useMutation` wrapper: every writer has bespoke optimistic / draft
 * logic and a wrapper would obscure it. These are the three shared
 * primitives the two dispositions are built from.
 *
 * The token is opaque — callers only ever echo a server-returned value.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { ApiError } from "./api-fetch";

/**
 * The current optimistic-concurrency token for a read, straight from the
 * query cache. Generalises the shipped `readBaseToken`: every guarded GET /
 * write response carries an optional `updatedAt`, cached with its payload.
 */
export function readUpdatedAtToken(
  queryClient: QueryClient,
  queryKey: QueryKey,
): string | undefined {
  return queryClient.getQueryData<{ updatedAt?: string }>(queryKey)?.updatedAt;
}

/**
 * Attach the base token to a write payload — but only when it is known, so a
 * tokenless client transparently takes the server's unconditional write
 * (mirrors `buildRingMutationPayload`'s conditional spread).
 */
export function withBaseToken<T extends object>(
  payload: T,
  token: string | undefined,
): T & { baseUpdatedAt?: string } {
  return token !== undefined
    ? { ...payload, baseUpdatedAt: token }
    : { ...payload };
}

/** True when a thrown error is an optimistic-concurrency 409. */
export function isConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409;
}
