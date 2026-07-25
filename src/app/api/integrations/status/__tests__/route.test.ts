import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn(async () => ({ user: { id: "u1" } })),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    withingsConnection: { findUnique: vi.fn(async () => null) },
    whoopConnection: { findUnique: vi.fn(async () => null) },
    fitbitConnection: { findUnique: vi.fn(async () => null) },
    googleHealthConnection: { findUnique: vi.fn(async () => null) },
    moodEntry: { count: vi.fn(async () => 0) },
    measurement: { groupBy: vi.fn(async () => []) },
    workout: { groupBy: vi.fn(async () => []) },
  },
}));

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

vi.mock("@/lib/api-response", () => ({
  apiSuccess: (data: unknown) => ({ data, error: null, status: 200 }),
}));

const ledger: Record<string, unknown> = {
  state: "connected",
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastError: null,
};
vi.mock("@/lib/integrations/status", () => ({
  getIntegrationStatus: vi.fn(async (_u: string, integration: string) => ({
    integration,
    ...(perIntegrationLedger[integration] ?? ledger),
  })),
  getPersistentFailureThreshold: () => 5,
}));
const perIntegrationLedger: Record<string, Record<string, unknown>> = {};

vi.mock("@/lib/withings/client", () => ({ hasActivityScope: () => false }));
vi.mock("@/lib/moodlog-secret", () => ({ readMoodLogSecret: () => null }));

const polarAvailable = vi.fn(async () => true);
const ouraAvailable = vi.fn(async () => false);
vi.mock("@/lib/polar/credentials", () => ({
  getPolarClientCredentials: () => polarAvailable(),
}));
vi.mock("@/lib/oura/credentials", () => ({
  getOuraClientCredentials: () => ouraAvailable(),
}));

import { GET } from "../route";
import { prisma } from "@/lib/db";
import { ATTEMPT_STALE_AFTER_MS } from "@/lib/integrations/sync-verdict";

const userFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const whoopFind = prisma.whoopConnection.findUnique as ReturnType<typeof vi.fn>;

type Entry = {
  integration: string;
  connected?: boolean;
  configured?: boolean;
  available?: boolean;
  hasOwnCredentials?: boolean;
  hasToken?: boolean;
  allowPrivateHost?: boolean;
  syncHealth?: { verdict: string; since: string | null };
  metricFreshness?: Array<{ type: string; lastSeenAt: string; stale: boolean }>;
};

async function fetchEntries(): Promise<Entry[]> {
  const res = (await (GET as unknown as () => Promise<{ data: unknown }>)())
    .data as { integrations: Entry[] };
  return res.integrations;
}

describe("/api/integrations/status — Polar/Oura fold (04-M2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(perIntegrationLedger)) {
      delete perIntegrationLedger[key];
    }
    polarAvailable.mockResolvedValue(true);
    ouraAvailable.mockResolvedValue(false);
  });

  it("includes polar + oura entries on the consolidated envelope", async () => {
    userFind.mockResolvedValue({
      polarAccessTokenEncrypted: "tok",
      polarClientIdEncrypted: "id",
      polarClientSecretEncrypted: "sec",
      ouraAccessTokenEncrypted: null,
      ouraClientIdEncrypted: null,
      ouraClientSecretEncrypted: null,
    });

    const entries = await fetchEntries();
    const keys = entries.map((e) => e.integration);
    expect(keys).toEqual(expect.arrayContaining(["polar", "oura"]));

    const polar = entries.find((e) => e.integration === "polar")!;
    expect(polar.connected).toBe(true);
    expect(polar.configured).toBe(true);
    expect(polar.available).toBe(true);
    expect(polar.hasOwnCredentials).toBe(true);

    const oura = entries.find((e) => e.integration === "oura")!;
    expect(oura.connected).toBe(false);
    expect(oura.available).toBe(false);
    expect(oura.hasOwnCredentials).toBe(false);
  });

  it("reports polar disconnected when no access token is stored", async () => {
    userFind.mockResolvedValue({
      polarAccessTokenEncrypted: null,
      polarClientIdEncrypted: null,
      polarClientSecretEncrypted: null,
    });
    const entries = await fetchEntries();
    const polar = entries.find((e) => e.integration === "polar")!;
    expect(polar.connected).toBe(false);
    expect(polar.configured).toBe(false);
  });
});

describe("/api/integrations/status — WHOOP identity ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userFind.mockResolvedValue({
      whoopClientIdEncrypted: "id",
      whoopClientSecretEncrypted: "secret",
    });
  });

  it("reports an identity-cleared duplicate row as disconnected", async () => {
    whoopFind.mockResolvedValue({
      whoopUserId: null,
      tokenExpiresAt: new Date(Date.now() + 3_600_000),
      lastSyncedAt: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      backfillCompletedAt: null,
    });

    const entries = await fetchEntries();
    const whoop = entries.find((entry) => entry.integration === "whoop");

    expect(whoop?.connected).toBe(false);
    expect(whoop?.configured).toBe(true);
  });
});

/**
 * The envelope is the unit of coverage for liveness. Every entry carries the
 * verdict, whether or not a card renders it — a card-level verdict misses a
 * card-less provider by construction, which is exactly how a month-dead sync
 * stayed invisible.
 */
describe("/api/integrations/status — sync-health verdict on every entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(perIntegrationLedger)) {
      delete perIntegrationLedger[key];
    }
    polarAvailable.mockResolvedValue(true);
    ouraAvailable.mockResolvedValue(true);
  });

  it("carries a syncHealth verdict on every entry", async () => {
    userFind.mockResolvedValue({});
    const entries = await fetchEntries();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.syncHealth, entry.integration).toBeDefined();
      expect(typeof entry.syncHealth!.verdict).toBe("string");
      expect(Array.isArray(entry.metricFreshness)).toBe(true);
    }
  });

  it("reports a configured, month-silent card-less provider as stalled", async () => {
    // The live incident, on the wire: moodLog has no Settings card, so this
    // entry is the only thing that can tell anyone the sync has stopped.
    const lastAttemptAt = new Date(
      Date.now() - 28 * 24 * 60 * 60 * 1000,
    ).toISOString();
    perIntegrationLedger.moodlog = {
      state: "error_transient",
      lastSuccessAt: new Date(
        Date.now() - 55 * 24 * 60 * 60 * 1000,
      ).toISOString(),
      lastAttemptAt,
      lastError: null,
    };
    userFind.mockResolvedValue({
      moodLogUrlEncrypted: "enc",
      moodLogEnabled: true,
    });

    const moodlog = (await fetchEntries()).find(
      (entry) => entry.integration === "moodlog",
    )!;
    expect(moodlog.configured).toBe(true);
    expect(moodlog.syncHealth).toEqual({
      verdict: "stalled",
      since: lastAttemptAt,
    });
  });

  it("keeps an integration that attempted within the window off the stalled arm", async () => {
    perIntegrationLedger.moodlog = {
      state: "error_transient",
      lastSuccessAt: null,
      lastAttemptAt: new Date(
        Date.now() - (ATTEMPT_STALE_AFTER_MS - 60_000),
      ).toISOString(),
      lastError: null,
    };
    userFind.mockResolvedValue({ moodLogUrlEncrypted: "enc" });

    const moodlog = (await fetchEntries()).find(
      (entry) => entry.integration === "moodlog",
    )!;
    expect(moodlog.syncHealth!.verdict).toBe("failing");
  });

  it("includes a nightscout entry with the fields the card's form reads", async () => {
    userFind.mockResolvedValue({
      nightscoutUrlEncrypted: "enc",
      nightscoutTokenEncrypted: "enc",
      nightscoutAllowPrivateHost: true,
    });

    const nightscout = (await fetchEntries()).find(
      (entry) => entry.integration === "nightscout",
    );
    expect(nightscout).toBeDefined();
    expect(nightscout!.connected).toBe(true);
    expect(nightscout!.configured).toBe(true);
    expect(nightscout!.hasToken).toBe(true);
    expect(nightscout!.allowPrivateHost).toBe(true);
    expect(nightscout!.syncHealth).toBeDefined();
  });
});
