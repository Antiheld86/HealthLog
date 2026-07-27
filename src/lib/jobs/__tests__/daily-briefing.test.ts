/**
 * S5 — daily-briefing fallback cron: tz slot-gating + result accounting, plus
 * the dead-queue wiring guard (imported / in allQueues / scheduled / worked).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";

import {
  runDailyBriefingTick,
  DAILY_BRIEFING_QUEUE,
  DAILY_BRIEFING_CRON,
} from "@/lib/jobs/daily-briefing";
import type { maybeDispatchDailyBriefing } from "@/lib/daily/daily-briefing-push";

// 06:00Z → 08:00 Berlin (the fallback hour) but 02:00 in New York (not the
// slot), so a mixed-tz cohort exercises the per-user local-hour gate.
const NOW = new Date("2026-07-16T06:00:00Z");

function makePrisma(
  cohort: Array<{ userId: string; timezone: string }>,
): PrismaClient {
  return {
    notificationPreference: {
      findMany: vi.fn(async () =>
        cohort.map((c) => ({
          channel: { userId: c.userId, user: { timezone: c.timezone } },
        })),
      ),
    },
  } as unknown as PrismaClient;
}

describe("runDailyBriefingTick — slot gating", () => {
  it("only calls the dispatch seam for users at their local fallback hour", async () => {
    const prisma = makePrisma([
      { userId: "berlin", timezone: "Europe/Berlin" }, // 08:00 → in slot
      { userId: "ny", timezone: "America/New_York" }, // 02:00 → not slot
    ]);
    const maybeDispatch = vi.fn<typeof maybeDispatchDailyBriefing>(
      async () => "sent",
    );

    const summary = await runDailyBriefingTick(prisma, NOW, { maybeDispatch });

    expect(summary.candidatesScanned).toBe(2);
    expect(summary.inSlot).toBe(1);
    expect(summary.sent).toBe(1);
    expect(maybeDispatch).toHaveBeenCalledTimes(1);
    expect(maybeDispatch.mock.calls[0][1]).toBe("berlin");
  });

  it("routes each dispatch result into its summary bucket", async () => {
    const prisma = makePrisma([
      { userId: "berlin", timezone: "Europe/Berlin" },
    ]);
    const maybeDispatch = vi.fn<typeof maybeDispatchDailyBriefing>(
      async () => "suppressed-frequency",
    );

    const summary = await runDailyBriefingTick(prisma, NOW, { maybeDispatch });
    expect(summary.suppressedFrequency).toBe(1);
    expect(summary.sent).toBe(0);
  });

  it("an empty opted-in cohort is a clean no-op", async () => {
    const prisma = makePrisma([]);
    const maybeDispatch = vi.fn<typeof maybeDispatchDailyBriefing>(
      async () => "sent",
    );
    const summary = await runDailyBriefingTick(prisma, NOW, { maybeDispatch });
    expect(summary.candidatesScanned).toBe(0);
    expect(maybeDispatch).not.toHaveBeenCalled();
  });
});

describe("reminder-worker — daily-briefing wiring", () => {
  const registrar = readFileSync(
    join(__dirname, "..", "reminder", "register-status.ts"),
    "utf8",
  );

  it("imports the queue symbols from the daily-briefing module", () => {
    expect(registrar).toMatch(/from\s*["']@\/lib\/jobs\/daily-briefing["']/);
    expect(registrar).toMatch(/\bDAILY_BRIEFING_QUEUE\b/);
    expect(registrar).toMatch(/\bDAILY_BRIEFING_CRON\b/);
    expect(registrar).toMatch(/\brunDailyBriefingTick\b/);
  });

  it("registers the queue in allQueues and schedules the cron", () => {
    const allQueues = registrar.match(/const allQueues\s*=\s*\[([\s\S]*?)\];/);
    expect(allQueues).not.toBeNull();
    expect(allQueues![1]).toMatch(/\bDAILY_BRIEFING_QUEUE\b/);
    expect(registrar).toMatch(
      /\[DAILY_BRIEFING_QUEUE,\s*DAILY_BRIEFING_CRON\]/,
    );
  });

  it("wires a createAndWork handler that runs the tick", () => {
    expect(registrar).toMatch(
      /createAndWork[\s\S]{0,200}DAILY_BRIEFING_QUEUE[\s\S]{0,400}runDailyBriefingTick/,
    );
  });

  it("fires the finalisation-hook push after a finalised morning refresh", () => {
    expect(registrar).toMatch(
      /result\.status\s*===\s*["']finalised["'][\s\S]{0,300}maybeDispatchDailyBriefing/,
    );
  });

  it("uses an every-15-min cron for the fallback slot", () => {
    expect(DAILY_BRIEFING_QUEUE).toBe("daily-briefing");
    expect(DAILY_BRIEFING_CRON).toBe("*/15 * * * *");
  });
});
