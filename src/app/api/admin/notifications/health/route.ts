import { prisma } from "@/lib/db";
import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * v1.17.1 — operator-wide notification delivery health.
 *
 * The per-self diagnostic (`/api/admin/notifications/diagnostic`) only shows
 * the calling admin's own account. On a multi-user instance the operator
 * cannot answer "are anyone's pushes failing?" without DB shell. This route
 * does a fleet-wide `groupBy(channel, result)` over the trailing window of the
 * `push_attempts` ledger, plus a list of channels currently auto-disabled
 * (across ALL users), so the operator can spot a flapping upstream that
 * silently disabled a channel after five failures.
 *
 * Admin-only (cookie auth, never Bearer) by construction via `requireAdmin()`.
 * The aggregate is anonymous: it counts channel×result, it never names a user.
 */

interface ChannelHealthRow {
  channel: string;
  ok: number;
  error: number;
  skipped: number;
  total: number;
}

interface DisabledChannelRow {
  type: string;
  count: number;
}

interface HealthPayload {
  windowHours: number;
  since: string;
  channels: ChannelHealthRow[];
  autoDisabledChannels: DisabledChannelRow[];
}

export const GET = apiHandler(async (request) => {
  await requireAdmin();
  annotate({ action: { name: "admin.notifications.health" } });

  // Window is operator-tunable via ?hours=, clamped 1..168 (7 days). The
  // `(channel, result, created_at)`-friendly index on push_attempts keeps the
  // groupBy bounded regardless of instance lifetime volume.
  const url = new URL(request.url);
  const hoursRaw = Number(url.searchParams.get("hours"));
  const windowHours =
    Number.isFinite(hoursRaw) && hoursRaw >= 1 && hoursRaw <= 168
      ? Math.floor(hoursRaw)
      : 24;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const [grouped, disabled] = await Promise.all([
    prisma.pushAttempt.groupBy({
      by: ["channel", "result"],
      where: {
        createdAt: { gte: since },
      },
      _count: { _all: true },
    }),
    // Channels disabled with an automated reason. A manual disable leaves
    // `disabledReason` NULL (see schema comment), so a non-null reason on a
    // disabled channel is the auto-disable signal we surface to the operator.
    prisma.notificationChannel.groupBy({
      by: ["type"],
      where: { enabled: false, disabledReason: { not: null } },
      _count: { _all: true },
    }),
  ]);

  const byChannel = new Map<string, ChannelHealthRow>();
  for (const row of grouped) {
    const existing =
      byChannel.get(row.channel) ??
      ({
        channel: row.channel,
        ok: 0,
        error: 0,
        skipped: 0,
        total: 0,
      } satisfies ChannelHealthRow);
    const count = row._count._all;
    if (row.result === "ok") existing.ok += count;
    else if (row.result === "error") existing.error += count;
    else if (row.result === "skipped") existing.skipped += count;
    existing.total += count;
    byChannel.set(row.channel, existing);
  }

  const channels = Array.from(byChannel.values()).sort((a, b) =>
    a.channel.localeCompare(b.channel),
  );

  const autoDisabledChannels: DisabledChannelRow[] = disabled
    .map((d) => ({ type: d.type, count: d._count._all }))
    .sort((a, b) => a.type.localeCompare(b.type));

  const payload: HealthPayload = {
    windowHours,
    since: since.toISOString(),
    channels,
    autoDisabledChannels,
  };

  return apiSuccess(payload);
});
