/**
 * GET /api/insights/coach/nudge-status — is there an unread Coach
 * message the caller has not opened yet?
 *
 * v1.18.6 (CCH-03) — the proactive Coach nudge now lands as a real
 * ASSISTANT message in the conversation rail (CCH-02), not as a
 * notification-only dispatch. The unread signal moved with it: instead
 * of anchoring on the `push_attempts` ledger (which is empty when no
 * push channel is configured, so the nudge was invisible), the status
 * compares the newest Coach assistant message against the
 * server-authoritative `User.coachLastSeenAt` stamp.
 *
 * `unread` is true when an assistant message exists that is newer than
 * the last time the user opened the Coach (drawer or page, which writes
 * `coachLastSeenAt` via `POST /api/insights/coach/seen`). A user who has
 * never opened the Coach reads any existing nudge as unread exactly
 * once. Server-authoritative so the signal is consistent across web +
 * iOS; the FAB keeps a local mirror only as an instant-paint
 * optimisation.
 *
 * `nudgedAt` carries the newest assistant-message timestamp so the FAB's
 * local seen-stamp keys on a stable value (kept for the existing client
 * contract).
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { requireAssistantSurface } from "@/lib/feature-flags";
import { readCoachNudgeStatus } from "@/lib/ai/coach/nudge-status";
import { evaluateCoachContextReminders } from "@/lib/ai/coach/context-reminders";
import { prisma } from "@/lib/db";

export const GET = apiHandler(async () => {
  // The RECORD's unread signal, not the caller's. The tempting reading is that
  // the FAB is the delegate's own chrome and should keep answering about the
  // delegate's own Coach — and that is exactly the defect this feature already
  // shipped once, in a different place: an actor answer paints the delegate's
  // unread dot on a page whose banner names somebody else. The shell hides the
  // FAB while a switch is on, but this route is in the refusal log precisely
  // because the query fires before `/api/auth/me` has resolved and the shell
  // knows to hide it, so "the client never renders it" is not a property to
  // rest a data scope on.
  //
  // What crosses the wire is a timestamp, a boolean and a conversation id, all
  // of the record's own Coach thread. The Coach CHAT stays refused under a
  // switch and that is not in tension with this: chat spends the owner's AI
  // budget and writes into their conversation, and reading whether the thread
  // has something unopened does neither.
  const { user, actor } = await requireRecordAuth("read", "record");
  // Operator-level flag — an `AppSettings` singleton, unaffected by whose
  // record is open.
  await requireAssistantSurface("coach");

  // NEXT_APP_OPEN Coach reminders resolve here: this poll mounts with the
  // app chrome, which makes it the app-open signal itself. Owner-only — a
  // delegate opening the record is not the owner opening their app, so a
  // switched caller never satisfies the cue. Awaited so the reminder's
  // message is already in the thread when this very response computes the
  // unread flag; fault-isolated so an evaluator hiccup can never break the
  // badge. Steady-state cost is one indexed query returning zero rows.
  if (actor.id === user.id) {
    try {
      await evaluateCoachContextReminders(prisma, user.id, "app-open");
    } catch (err) {
      console.warn("[coach] app-open context evaluation failed", err);
    }
  }

  // Shared with the `/coach` RSC prefetch (`src/app/coach/page.tsx`) so both
  // readers compute the unread signal identically.
  return apiSuccess(await readCoachNudgeStatus(user.id));
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
