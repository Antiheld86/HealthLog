/**
 * POST /api/admin/backups/run — enqueue a manual data-backup pg-boss job.
 *
 * The pg-boss `data-backup` queue is also driven by a weekly cron in the
 * worker (Sundays 03:00 Europe/Berlin); this route lets an admin force a
 * snapshot now. Returns the boss job id so the UI can show feedback.
 *
 * If the worker isn't running (no global boss instance) the route returns
 * 503 — the caller can then route the user to the system-status page.
 */
import type { NextRequest } from "next/server";
import { apiHandler, requireAdmin, HttpError } from "@/lib/api-handler";
import { apiSuccess, getClientIp } from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  DATA_BACKUP_QUEUE,
  DATA_BACKUP_SEND_OPTIONS,
} from "@/lib/jobs/data-backup-policy";

export const dynamic = "force-dynamic";

export const POST = apiHandler(async (request: NextRequest) => {
  const { user: admin } = await requireAdmin();
  annotate({ action: { name: "admin.backups.run" } });

  // pg-boss does not dedupe by payload; without a rate-limit, an
  // impatient admin (or compromised admin session) can stack dozens of
  // identical jobs on the queue. Three runs/min per admin is plenty
  // for ad-hoc snapshots — the weekly cron carries the regular cadence.
  const rl = await checkRateLimit(
    `admin-backups-run:${admin.id}`,
    3,
    60 * 1000,
  );
  if (!rl.allowed) {
    // Audit the rate-limited attempt so a compromised session burning
    // through the cap is visible in the trail.
    await auditLog("admin.backups.run.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason: "rate_limited" },
    });
    throw new HttpError(429, "Too many backup runs");
  }

  const boss = getGlobalBoss();
  if (!boss) {
    await auditLog("admin.backups.run.denied", {
      userId: admin.id,
      ipAddress: getClientIp(request),
      details: { reason: "worker_not_running" },
    });
    // 503 instead of 500 — the request is well-formed; the worker just
    // isn't reachable from this process. Same response shape as other
    // worker-required endpoints.
    throw new HttpError(503, "Background worker is not running");
  }

  // Same expiration window as the weekly cron. An ad-hoc snapshot runs the
  // identical pass over the identical record, so it must not silently keep the
  // 15-minute queue default the cron was rescued from.
  const jobId = await boss.send(
    DATA_BACKUP_QUEUE,
    { triggeredAt: new Date().toISOString() },
    DATA_BACKUP_SEND_OPTIONS,
  );

  annotate({ meta: { job_id: jobId ?? null } });

  // Mirrors the audit shape of upload / download / restore: actor =
  // admin.id, action = admin.backups.run, with the boss job id so a
  // forensic trail can correlate "admin enqueued" → "worker ran".
  await auditLog("admin.backups.run", {
    userId: admin.id,
    ipAddress: getClientIp(request),
    details: {
      queue: DATA_BACKUP_QUEUE,
      jobId: jobId ?? null,
    },
  });

  return apiSuccess({
    jobId,
    queue: DATA_BACKUP_QUEUE,
  });
});
