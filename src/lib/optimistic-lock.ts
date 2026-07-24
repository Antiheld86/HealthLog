/**
 * Optimistic-concurrency guard for per-user read-modify-write endpoints.
 *
 * Extracted from the shipped `/api/dashboard/widgets` fix (issue #581,
 * v1.32.16): a Save carrying the `updatedAt` it was based on writes
 * CONDITIONALLY on the stored row still carrying that token, so a Save
 * that already committed can never be silently reverted by a later
 * request that started from an older snapshot. A stale base returns 409
 * and writes NOTHING. A request that omits the token keeps the prior
 * unconditional write — byte-for-byte the pre-guard behaviour, so older
 * web builds and the native client are unaffected.
 *
 * The wire token is OPAQUE by contract: the client only ever echoes a
 * server-returned value, never parses or synthesises one. That keeps the
 * escalation path (a per-column jsonb value guard instead of the shared
 * `User.updatedAt`) wire-compatible — the token can become a hash of the
 * column value without any client change.
 *
 * Two consumer shapes:
 *   - `guardedUserUpdate` — the common case: a field-by-field
 *     `Prisma.UserUpdateInput` guarded on `User.updatedAt`.
 *   - `guardedRowUpdate` — the generic core `guardedUserUpdate` wraps, for
 *     a non-`User` row that carries its own `@updatedAt` (e.g.
 *     `UserHealthProfile` behind `/api/coach/about-me`).
 *
 * The caller always builds the `data` object field-by-field (no mass
 * assignment); this helper never spreads a parsed request body.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { apiError } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

/** Result of pulling the `baseUpdatedAt` transport field off a request body. */
export type TakeBaseTokenResult =
  | { base: Date | undefined; rest: unknown }
  | { invalid: true };

/**
 * Pull the optimistic-concurrency base token off a raw request body BEFORE
 * the domain Zod parse, so the token never has to be declared on (and can
 * never pollute) the domain schema — several of these schemas are `.strict()`
 * or derive a change list from `Object.keys(parsed.data)`.
 *
 *   - no `baseUpdatedAt` key            → `{ base: undefined, rest: body }` (legacy write)
 *   - `baseUpdatedAt` a valid ISO date  → `{ base: Date, rest: body-without-the-field }`
 *   - `baseUpdatedAt` present but junk  → `{ invalid: true }` (caller returns 422)
 *
 * A non-object body passes through untouched as a tokenless request; the
 * domain Zod parse then rejects it on its own terms.
 */
export function takeBaseToken(body: unknown): TakeBaseTokenResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { base: undefined, rest: body };
  }
  const record = body as Record<string, unknown>;
  if (!("baseUpdatedAt" in record)) {
    return { base: undefined, rest: body };
  }
  const { baseUpdatedAt, ...rest } = record;
  if (baseUpdatedAt === undefined) {
    // Present-but-undefined can't arrive over JSON; treat it as tokenless.
    return { base: undefined, rest };
  }
  if (typeof baseUpdatedAt !== "string") {
    return { invalid: true };
  }
  const base = new Date(baseUpdatedAt);
  if (Number.isNaN(base.getTime())) {
    return { invalid: true };
  }
  return { base, rest };
}

/**
 * The single 422 a malformed base token earns — same wording + errorCode
 * across every guarded endpoint (matches the shipped widgets route).
 */
export function invalidBaseTokenError(): Response {
  return apiError("Invalid base token", 422, {
    errorCode: "invalid_base_updated_at",
  });
}

/** Per-endpoint conflict identity (annotation name + wire errorCode + prose). */
export interface ConflictSpec {
  /** Wide-event action name, `<surface>.<noun>.conflict`. */
  action: string;
  /** `meta.errorCode` on the 409 envelope. */
  errorCode: string;
  /** Human prose for the 409 `error` string. */
  message: string;
}

/** Either a ready-to-return 409 `Response`, or the fresh token to echo. */
export type GuardedUpdateResult =
  | { conflict: Response }
  | { updatedAt: string };

/**
 * Generic conditional-update-or-409 core.
 *
 *   - `base === undefined` → run the UNCONDITIONAL write (backward-compat
 *     arm; this must stay the plain write forever) and echo its token.
 *   - `base` present → run the CONDITIONAL write; a zero match means the
 *     row advanced since the client read it → annotate + return a 409
 *     with NO write; a match re-reads the fresh token to echo.
 */
export async function guardedRowUpdate(opts: {
  base: Date | undefined;
  run: {
    /** The prior unconditional write; returns the row's fresh `updatedAt`. */
    unconditional: () => Promise<{ updatedAt: Date }>;
    /** The conditional write (guarded on `base`); returns the matched count. */
    conditional: (base: Date) => Promise<number>;
    /** Re-read the row's `updatedAt` after a matched conditional write. */
    freshToken: () => Promise<Date | undefined>;
  };
  conflict: ConflictSpec;
}): Promise<GuardedUpdateResult> {
  const { base, run, conflict } = opts;

  if (base === undefined) {
    const updated = await run.unconditional();
    return { updatedAt: (updated.updatedAt ?? new Date()).toISOString() };
  }

  const count = await run.conditional(base);
  if (count === 0) {
    annotate({
      action: { name: conflict.action },
      meta: { base_updated_at: base.toISOString() },
    });
    return {
      conflict: apiError(conflict.message, 409, {
        errorCode: conflict.errorCode,
      }),
    };
  }

  const fresh = await run.freshToken();
  return { updatedAt: (fresh ?? new Date()).toISOString() };
}

/**
 * `guardedRowUpdate` specialised to the `User` row: a field-by-field
 * `Prisma.UserUpdateInput` guarded on `User.updatedAt`. The `data` object is
 * always built by the caller — this helper never spreads a request body.
 */
export function guardedUserUpdate(opts: {
  userId: string;
  base: Date | undefined;
  data: Prisma.UserUpdateInput;
  conflict: ConflictSpec;
}): Promise<GuardedUpdateResult> {
  const { userId, base, data, conflict } = opts;
  return guardedRowUpdate({
    base,
    conflict,
    run: {
      unconditional: async () => {
        const updated = await prisma.user.update({
          where: { id: userId },
          data,
          select: { updatedAt: true },
        });
        return { updatedAt: updated?.updatedAt ?? new Date() };
      },
      conditional: async (b) => {
        const res = await prisma.user.updateMany({
          where: { id: userId, updatedAt: b },
          data,
        });
        return res.count;
      },
      freshToken: async () => {
        const fresh = await prisma.user.findUnique({
          where: { id: userId },
          select: { updatedAt: true },
        });
        return fresh?.updatedAt;
      },
    },
  });
}
