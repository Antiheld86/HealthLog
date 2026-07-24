/**
 * GET /api/coach/about-me — the caller's structured self-context.
 * PUT /api/coach/about-me — write (or clear) the self-context.
 *
 * v1.15.20 — free-text "about me", encrypted at rest.
 * v1.16.0 — extended with three structured fields (conditions,
 * allergies, coach focus; each ≤500 chars, encrypted) and the
 * clarifying-questions loop: after a save the server derives up to 3
 * follow-up questions (AI when a provider + the daily Coach budget
 * allow, deterministic hints otherwise) and persists them encrypted;
 * the Coach composer renders them as tappable chips
 * (`/api/coach/about-me/questions`).
 *
 * PUT field semantics: `aboutMe` is required (empty string clears).
 * The structured fields are optional — omitted leaves the stored value
 * untouched, an empty string clears it — so older clients that only
 * send `aboutMe` keep working unchanged.
 *
 * Plain text end to end: the client renders every value as a React
 * text child only — no markdown library exists in the tree and none
 * may be added (XSS posture, see the contributor notes).
 *
 * Ownership: the user id always comes from `requireAuth()`; the body
 * carries only the text. Audit rows never contain the text itself —
 * only per-field lengths — because it is free-form health prose.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { prisma } from "@/lib/db";
import { takeBaseToken, invalidBaseTokenError } from "@/lib/optimistic-lock";
import { checkRateLimit, rateLimitHeaders } from "@/lib/rate-limit";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  getPendingQuestionsForUser,
  getSelfContextForUser,
  setPendingQuestionsForUser,
} from "@/lib/ai/coach/about-me";
import { deriveClarifyingQuestions } from "@/lib/ai/coach/self-context-questions";
import { requireModuleEnabled } from "@/lib/modules/gate";
import {
  ABOUT_ME_FIELD_MAX_CHARS,
  ABOUT_ME_MAX_CHARS,
  aboutMePutSchema,
} from "@/lib/validations/about-me";

const PUT_RATE_LIMIT = 30;
const PUT_WINDOW_MS = 60_000;

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  // v1.18.0 — Coach module gate (operator availability + disableCoach).
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  const [ctx, pendingQuestions, row] = await Promise.all([
    getSelfContextForUser(user.id),
    getPendingQuestionsForUser(user.id),
    prisma.userHealthProfile.findUnique({
      where: { userId: user.id },
      select: { updatedAt: true },
    }),
  ]);

  annotate({
    action: { name: "coach.about_me.get" },
    meta: {
      present: ctx.aboutMe !== null,
      structured:
        ctx.conditions !== null ||
        ctx.allergies !== null ||
        ctx.coachFocus !== null,
    },
  });

  return apiSuccess({
    aboutMe: ctx.aboutMe,
    conditions: ctx.conditions,
    allergies: ctx.allergies,
    coachFocus: ctx.coachFocus,
    pendingQuestions,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    maxChars: ABOUT_ME_MAX_CHARS,
    fieldMaxChars: ABOUT_ME_FIELD_MAX_CHARS,
  });
});

export const PUT = apiHandler(async (req: Request) => {
  const { user } = await requireAuth();
  // v1.18.0 — Coach module gate (operator availability + disableCoach).
  const gate = await requireModuleEnabled(user.id, "coach");
  if (!gate.enabled) return gate.response;

  const rl = await checkRateLimit(
    `coach-about-me:put:${user.id}`,
    PUT_RATE_LIMIT,
    PUT_WINDOW_MS,
  );
  if (!rl.allowed) {
    const response = apiError("Too many requests", 429);
    for (const [k, v] of Object.entries(rateLimitHeaders(rl))) {
      response.headers.set(k, v);
    }
    return response;
  }

  const { data: rawBody, error: jsonError } = await safeJson(req, {
    maxBytes: 64 * 1024,
  });
  if (jsonError) return jsonError;

  // v1.32.21 (R5a) — pull the optimistic-concurrency base token off the body
  // BEFORE the Zod parse (issue #581 family). The token guards on
  // `UserHealthProfile.updatedAt`, which — unlike the layout endpoints on the
  // shared `User` row — moves only when THIS surface (or the `/adopt`
  // sub-route) writes, so it is noise-free.
  const taken = takeBaseToken(rawBody);
  if ("invalid" in taken) return invalidBaseTokenError();
  const base = taken.base;

  const parsed = aboutMePutSchema.safeParse(taken.rest);
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422);
  }

  const text = parsed.data.aboutMe.trim();
  const cleared = text.length === 0;

  // Field-by-field data assembly (no mass assignment): omitted fields
  // never appear in the update object, so they stay untouched.
  const encryptOptional = (
    raw: string | undefined,
  ): Uint8Array<ArrayBuffer> | null | undefined => {
    if (raw === undefined) return undefined;
    const value = raw.trim();
    return value.length === 0 ? null : encryptToBytes(value);
  };
  const update: {
    aboutMeEncrypted: Uint8Array<ArrayBuffer> | null;
    conditionsEncrypted?: Uint8Array<ArrayBuffer> | null;
    allergiesEncrypted?: Uint8Array<ArrayBuffer> | null;
    coachFocusEncrypted?: Uint8Array<ArrayBuffer> | null;
  } = {
    aboutMeEncrypted: cleared ? null : encryptToBytes(text),
  };
  const conditionsPayload = encryptOptional(parsed.data.conditions);
  if (conditionsPayload !== undefined) {
    update.conditionsEncrypted = conditionsPayload;
  }
  const allergiesPayload = encryptOptional(parsed.data.allergies);
  if (allergiesPayload !== undefined) {
    update.allergiesEncrypted = allergiesPayload;
  }
  const coachFocusPayload = encryptOptional(parsed.data.coachFocus);
  if (coachFocusPayload !== undefined) {
    update.coachFocusEncrypted = coachFocusPayload;
  }
  const fieldLengths: Record<string, number> = {
    aboutMe: text.length,
    ...(parsed.data.conditions !== undefined
      ? { conditions: parsed.data.conditions.trim().length }
      : {}),
    ...(parsed.data.allergies !== undefined
      ? { allergies: parsed.data.allergies.trim().length }
      : {}),
    ...(parsed.data.coachFocus !== undefined
      ? { coachFocus: parsed.data.coachFocus.trim().length }
      : {}),
  };

  // v1.32.21 (R5a) — optimistic concurrency on `UserHealthProfile.updatedAt`.
  //   - no base token → today's upsert (backward-compat arm, byte-identical);
  //   - base present + row still carries it → conditional update, echo fresh;
  //   - base present + zero match → the row either vanished (deleted since the
  //     read → create wins, nothing to clobber) or advanced (real conflict →
  //     409, no write).
  let updatedAtIso: string;
  if (base === undefined) {
    const row = await prisma.userHealthProfile.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...update },
      update,
      select: { updatedAt: true },
    });
    updatedAtIso = row.updatedAt.toISOString();
  } else {
    const guarded = await prisma.userHealthProfile.updateMany({
      where: { userId: user.id, updatedAt: base },
      data: update,
    });
    if (guarded.count === 0) {
      const existing = await prisma.userHealthProfile.findUnique({
        where: { userId: user.id },
        select: { updatedAt: true },
      });
      if (existing) {
        annotate({
          action: { name: "coach.about_me.conflict" },
          meta: { base_updated_at: base.toISOString() },
        });
        return apiError("Self-context changed since it was loaded", 409, {
          errorCode: "about_me_conflict",
        });
      }
      const created = await prisma.userHealthProfile.create({
        data: { userId: user.id, ...update },
        select: { updatedAt: true },
      });
      updatedAtIso = created.updatedAt.toISOString();
    } else {
      const fresh = await prisma.userHealthProfile.findUnique({
        where: { userId: user.id },
        select: { updatedAt: true },
      });
      updatedAtIso = (fresh?.updatedAt ?? new Date()).toISOString();
    }
  }

  // Read back the effective state (covers omitted fields) and derive
  // the clarifying questions. An entirely empty self-context clears
  // the pending questions instead of generating new ones.
  const ctx = await getSelfContextForUser(user.id);
  const isEmpty =
    ctx.aboutMe === null &&
    ctx.conditions === null &&
    ctx.allergies === null &&
    ctx.coachFocus === null;

  let pendingQuestions: string[] = [];
  let questionsSource: "ai" | "fallback" | "none" = "none";
  if (isEmpty) {
    await setPendingQuestionsForUser(user.id, null);
  } else {
    const derived = await deriveClarifyingQuestions(user.id, ctx, user.locale);
    pendingQuestions = derived.questions;
    questionsSource = derived.source;
    await setPendingQuestionsForUser(user.id, pendingQuestions);
  }

  // The audit row carries per-field lengths only — the text is
  // free-form health prose and must not land in the plaintext audit
  // details.
  await auditLog(
    isEmpty ? "coach.about_me.cleared" : "coach.about_me.updated",
    {
      userId: user.id,
      ipAddress: getClientIp(req),
      details: { ...fieldLengths },
    },
  );

  annotate({
    action: {
      name: isEmpty ? "coach.about_me.cleared" : "coach.about_me.updated",
    },
    meta: {
      length: text.length,
      questions_source: questionsSource,
      questions_count: pendingQuestions.length,
    },
  });

  return apiSuccess({
    aboutMe: ctx.aboutMe,
    conditions: ctx.conditions,
    allergies: ctx.allergies,
    coachFocus: ctx.coachFocus,
    pendingQuestions,
    updatedAt: updatedAtIso,
    maxChars: ABOUT_ME_MAX_CHARS,
    fieldMaxChars: ABOUT_ME_FIELD_MAX_CHARS,
  });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
