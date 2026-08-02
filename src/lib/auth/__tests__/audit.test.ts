import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/geo", () => ({
  lookupIpGeo: vi.fn(),
}));

import { auditLog } from "../audit";
import { prisma } from "@/lib/db";
import { lookupIpGeo } from "@/lib/geo";

const ENTRY = { id: "audit-1" };
type GeoResolved = {
  location: string | null;
  asn: number | null;
  carrier: string | null;
};
const EMPTY_GEO: GeoResolved = { location: null, asn: null, carrier: null };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.auditLog.create).mockResolvedValue(ENTRY as never);
  vi.mocked(prisma.auditLog.update).mockResolvedValue(ENTRY as never);
  // Default: nothing resolves. Tests that exercise location/carrier
  // resolution override this with `mockResolvedValueOnce`.
  vi.mocked(lookupIpGeo).mockResolvedValue(EMPTY_GEO);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Wait for any micro/macrotask `Promise.race` resolutions to flush.
 * Real timers are used because the Promise wrapping `setTimeout` resolves
 * via the event loop — vi.useFakeTimers() would block the geo-lookup
 * Promise from resolving in tests that need it.
 */
async function flush(): Promise<void> {
  // Two `setImmediate`-equivalent cycles are enough: one for `Promise.race`
  // to resolve and one for the `.then(...)` continuation.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("auditLog", () => {
  it("creates an audit-log row with action, userId, JSON-stringified details, ipAddress and null location", async () => {
    await auditLog("auth.login", {
      userId: "user-7",
      details: { reason: "passkey", browser: "firefox" },
      ipAddress: "203.0.113.5",
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const args = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
    expect(args.data).toEqual({
      action: "auth.login",
      userId: "user-7",
      details: JSON.stringify({ reason: "passkey", browser: "firefox" }),
      ipAddress: "203.0.113.5",
      // v1.36.0 — no acting account on this request, so the row says the
      // account acted for itself. NULL is the statement, not a gap.
      actorUserId: null,
    });
    // Location is intentionally not set on insert — it's filled later by the
    // geo lookup. The schema column itself is not in the create payload.
    expect(args.data).not.toHaveProperty("location");
  });

  it("persists null userId / null ipAddress / null details when none supplied", async () => {
    await auditLog("auth.bearer.failure");

    const args = vi.mocked(prisma.auditLog.create).mock.calls[0][0];
    expect(args.data).toEqual({
      action: "auth.bearer.failure",
      userId: null,
      details: null,
      ipAddress: null,
      actorUserId: null,
    });
    // No IP → no geo lookup enqueued.
    expect(lookupIpGeo).not.toHaveBeenCalled();
  });

  it("for auth.* actions with an ip address, runs geo lookup and updates the row with the resolved location", async () => {
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: "Berlin, DE",
      asn: null,
      carrier: null,
    });

    await auditLog("auth.login", {
      userId: "user-8",
      ipAddress: "8.8.8.8",
    });
    await flush();

    expect(lookupIpGeo).toHaveBeenCalledWith("8.8.8.8");
    expect(prisma.auditLog.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { location: "Berlin, DE" },
    });
  });

  it("does NOT update the row when geo lookup resolves to nothing", async () => {
    vi.mocked(lookupIpGeo).mockResolvedValueOnce(EMPTY_GEO);

    await auditLog("auth.login", {
      userId: "user-9",
      ipAddress: "1.2.3.4",
    });
    await flush();

    expect(lookupIpGeo).toHaveBeenCalledOnce();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("does NOT update the row when geo lookup outruns the 3s race timeout", async () => {
    // Lookup that never resolves within 3 s — must lose the Promise.race.
    let neverResolve: (value: typeof EMPTY_GEO) => void;
    vi.mocked(lookupIpGeo).mockImplementationOnce(
      () =>
        new Promise<typeof EMPTY_GEO>((resolve) => {
          neverResolve = resolve;
        }),
    );

    vi.useFakeTimers();
    const promise = auditLog("auth.login", {
      userId: "user-10",
      ipAddress: "1.2.3.4",
    });
    await promise; // create resolves immediately; race continues in background

    // Advance past the 3 s timeout — race resolves to null path.
    await vi.advanceTimersByTimeAsync(3001);
    vi.useRealTimers();
    await flush();

    expect(prisma.auditLog.update).not.toHaveBeenCalled();
    // Caller stays unblocked — the awaited promise above already resolved.
    // Resolve the dangling lookup so the test process exits cleanly.
    neverResolve!({ location: "Tokyo, JP", asn: null, carrier: null });
    await flush();
  });

  it("non-auth actions never enqueue a geo lookup, even with an IP", async () => {
    await auditLog("medication.create", {
      userId: "user-11",
      ipAddress: "203.0.113.99",
    });
    await flush();

    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
    expect(lookupIpGeo).not.toHaveBeenCalled();
    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("silently swallows geo-lookup throws — caller stays unblocked, no update emitted", async () => {
    vi.mocked(lookupIpGeo).mockRejectedValueOnce(new Error("upstream 503"));

    // The auditLog promise itself must NOT reject.
    await expect(
      auditLog("auth.login", {
        userId: "user-12",
        ipAddress: "8.8.8.8",
      }),
    ).resolves.toBeUndefined();
    await flush();

    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("silently swallows update() throws (e.g. row deleted between create + update)", async () => {
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: "Paris, FR",
      asn: null,
      carrier: null,
    });
    vi.mocked(prisma.auditLog.update).mockRejectedValueOnce(
      new Error("row gone"),
    );

    await expect(
      auditLog("auth.login", {
        userId: "user-13",
        ipAddress: "8.8.4.4",
      }),
    ).resolves.toBeUndefined();
    await flush();

    expect(prisma.auditLog.update).toHaveBeenCalledOnce();
  });

  // ── ASN + carrier resolution ──────────────────────────────────────
  it("writes asn + carrier alongside location when the resolver fills all three", async () => {
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: "Berlin, DE",
      asn: 3320,
      carrier: "Deutsche Telekom AG",
    });

    await auditLog("auth.login.password", {
      userId: "user-14",
      ipAddress: "84.131.0.1",
    });
    await flush();

    expect(lookupIpGeo).toHaveBeenCalledWith("84.131.0.1");
    expect(prisma.auditLog.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: {
        location: "Berlin, DE",
        asn: 3320,
        carrier: "Deutsche Telekom AG",
      },
    });
  });

  it("writes asn + carrier even when the location lookup returns null", async () => {
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: null,
      asn: 3209,
      carrier: "Vodafone GmbH",
    });

    await auditLog("auth.login.passkey", {
      userId: "user-15",
      ipAddress: "139.7.0.1",
    });
    await flush();

    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: {
        asn: 3209,
        carrier: "Vodafone GmbH",
      },
    });
  });

  it("writes carrier without asn when the online provider omits the AS number", async () => {
    // v1.25.8 — ip-api can return `isp` without a parseable `as`, so a carrier
    // resolves with a null asn. The carrier is still persisted.
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: "Bochum, DE",
      asn: null,
      carrier: "Deutsche Telekom AG",
    });

    await auditLog("auth.login.password", {
      userId: "user-14b",
      ipAddress: "84.131.0.2",
    });
    await flush();

    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { location: "Bochum, DE", carrier: "Deutsche Telekom AG" },
    });
  });

  it("writes location only when the carrier lookup misses", async () => {
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: "Berlin, DE",
      asn: null,
      carrier: null,
    });

    await auditLog("auth.login.password", {
      userId: "user-16",
      ipAddress: "192.0.2.1",
    });
    await flush();

    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { location: "Berlin, DE" },
    });
  });

  it("does NOT update when the resolver misses entirely", async () => {
    vi.mocked(lookupIpGeo).mockResolvedValueOnce(EMPTY_GEO);

    await auditLog("auth.login.password", {
      userId: "user-17",
      ipAddress: "192.0.2.2",
    });
    await flush();

    expect(prisma.auditLog.update).not.toHaveBeenCalled();
  });

  it("omits the carrier field when the resolver returns an asn but no organisation", async () => {
    vi.mocked(lookupIpGeo).mockResolvedValueOnce({
      location: null,
      asn: 64500,
      carrier: null,
    });

    await auditLog("auth.login.password", {
      userId: "user-18",
      ipAddress: "192.0.2.3",
    });
    await flush();

    expect(prisma.auditLog.update).toHaveBeenCalledWith({
      where: { id: "audit-1" },
      data: { asn: 64500 },
    });
  });
});
