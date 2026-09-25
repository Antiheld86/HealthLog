/**
 * POST /api/insights/coach/seen — mark every Coach message as read.
 *
 * v1.18.6 (CCH-03) — opening the Coach (drawer or full page) clears the
 * unread dot on the FAB. The open stamps `User.coachLastSeenAt = now`;
 * the FAB's `GET /api/insights/coach/nudge-status` then reads no
 * assistant message newer than the stamp and drops the dot. Server-
 * authoritative so the cleared state follows the user across web + iOS,
 * not just the device that opened the Coach.
 *
 * No request body — the timestamp is server-minted from `now()` so a
 * client can never backdate the stamp to suppress a future nudge.
 *
 * No AI gate: a timestamp on the caller's own row is data, whatever the
 * Coach's availability.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { prisma } from "@/lib/db";

export const POST = apiHandler(async () => {
  const { user } = await requireAuth();

  const seenAt = new Date();
  await prisma.user.update({
    where: { id: user.id },
    data: { coachLastSeenAt: seenAt },
  });

  return apiSuccess({ seenAt: seenAt.toISOString() });
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
