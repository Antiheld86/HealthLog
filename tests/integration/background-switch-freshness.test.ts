/**
 * A switch turned off while a nightly job is running stops the rest of it.
 *
 * Reads inside one request are memoised on the request's wide event, so a
 * page that resolves the AI capabilities five times reads the settings row
 * once. A background job opens one wide event for its whole run, and the
 * status crons loop over every candidate inside it: memoising there meant the
 * switches, the modules and the consent kinds were read once at the start of
 * the run and served to every later user, and the wire re-check read the same
 * cached answer. Turning the Assistant off at 02:05 did not stop the 02:00
 * pass.
 *
 * Driven here over the real loop, the real capability loader and Postgres:
 * the first user's generation turns the switch off, and the remaining users
 * must not reach a generator, while the wire re-check inside the first user's
 * own run must see the change too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

const candidates = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock("@/lib/jobs/status-cron-candidates", () => ({
  findStatusCronCandidates: vi.fn(async () =>
    candidates.ids.map((id) => ({ id, locale: "en" })),
  ),
}));

import { runStatusCronGenerate } from "@/lib/jobs/reminder/insights-handlers";
import { aiEgressRefusal } from "@/lib/ai/capabilities/egress";

let counter = 0;

async function seedUserWithProvider(): Promise<string> {
  const n = counter++;
  const user = await getPrismaClient().user.create({
    data: {
      username: `fresh-switch-${n}`,
      email: `fresh-switch-${n}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      aiProvider: "ANTHROPIC",
      aiAnthropicKeyEncrypted: "v1:presence-only",
      consentReceipts: {
        create: { kind: "ai_full", artefact: "test", signedAt: new Date() },
      },
    },
  });
  return user.id;
}

async function setInsightStatusSwitch(enabled: boolean): Promise<void> {
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", assistantInsightStatusEnabled: enabled },
    update: { assistantInsightStatusEnabled: enabled },
  });
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await setInsightStatusSwitch(true);
});

describe("a switch turned off mid-run", () => {
  it("stops the remaining users of the same background pass", async () => {
    candidates.ids = [
      await seedUserWithProvider(),
      await seedUserWithProvider(),
      await seedUserWithProvider(),
    ];
    const reached: string[] = [];
    const wire: Array<string | null> = [];

    const generate = vi.fn(async (userId: string) => {
      reached.push(userId);
      // The wire re-check before the switch moves: open.
      wire.push(
        (await aiEgressRefusal("statusText", userId, ["anthropic"]))?.reason ??
          null,
      );
      await setInsightStatusSwitch(false);
      // The same user's wire re-check after it moved: closed.
      wire.push(
        (await aiEgressRefusal("statusText", userId, ["anthropic"]))?.reason ??
          null,
      );
    });

    await runStatusCronGenerate("job.test.fresh_switch", generate);

    expect(reached).toEqual([candidates.ids[0]]);
    expect(wire[0]).toBeNull();
    expect(wire[1]).not.toBeNull();
  });
});
