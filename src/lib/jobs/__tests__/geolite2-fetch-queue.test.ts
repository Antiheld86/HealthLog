/**
 * Runtime GeoLite2 fetch (issue #659) — queue-wiring guard + boot gating.
 *
 * The source-text-grep half mirrors the other dead-queue guards: assert the
 * queue is imported, in `allQueues`, scheduled, and bound to a `createAndWork`
 * handler that runs the fetch — without booting pg-boss. An unregistered queue
 * silently never drains (the recurring v1.4.37 dead-queue bug), which here
 * would mean a keyed self-host never gets its databases fetched.
 *
 * The second half exercises the boot-discovery gate directly: it must send a
 * job only when a key is set, egress is not disabled, and the offline tier is
 * absent.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-maintenance.ts",
);
const workerSource =
  readFileSync(REGISTRAR_PATH, "utf8") +
  readFileSync(join(__dirname, "..", "reminder", "ops-handlers.ts"), "utf8");

describe("reminder-worker — geolite2-fetch wiring", () => {
  it("imports the queue symbols from the geolite2-fetch module", () => {
    expect(workerSource).toMatch(/from\s*["']@\/lib\/jobs\/geolite2-fetch["']/);
    expect(workerSource).toMatch(/\bGEOLITE2_FETCH_QUEUE\b/);
    expect(workerSource).toMatch(/\bGEOLITE2_FETCH_CRON\b/);
    expect(workerSource).toMatch(/\benqueueGeolite2FetchBootDiscovery\b/);
  });

  it("registers the queue in the allQueues loop", () => {
    const allQueuesMatch = workerSource.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bGEOLITE2_FETCH_QUEUE\b/);
  });

  it("schedules the monthly cron", () => {
    expect(workerSource).toMatch(
      /\[GEOLITE2_FETCH_QUEUE,\s*GEOLITE2_FETCH_CRON\]/,
    );
  });

  it("registers a createAndWork handler for the queue", () => {
    expect(workerSource).toMatch(
      /createAndWork[\s\S]{0,200}GEOLITE2_FETCH_QUEUE[\s\S]{0,200}handleGeolite2Fetch/,
    );
  });

  it("runs the fetch inside the handler", () => {
    expect(workerSource).toMatch(
      /handleGeolite2Fetch[\s\S]{0,500}fetchGeoLite2Databases/,
    );
  });

  it("fires the boot discovery from enqueueMaintenanceBootDiscovery", () => {
    expect(workerSource).toMatch(
      /enqueueMaintenanceBootDiscovery[\s\S]*enqueueGeolite2FetchBootDiscovery/,
    );
  });
});

// ── Boot-discovery gate ──────────────────────────────────────────────
const { sendMock, bossMock, offlineGeoReadyMock } = vi.hoisted(() => {
  const sendMock = vi.fn().mockResolvedValue("job-1");
  return {
    sendMock,
    bossMock: { send: sendMock },
    offlineGeoReadyMock: vi.fn(),
  };
});
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => bossMock,
}));
vi.mock("@/lib/geo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/geo")>();
  return { ...actual, offlineGeoReady: offlineGeoReadyMock };
});

import { enqueueGeolite2FetchBootDiscovery } from "@/lib/jobs/geolite2-fetch";

const ORIGINAL_KEY = process.env.MAXMIND_LICENSE_KEY;
const ORIGINAL_DISABLED = process.env.IP_GEO_LOOKUP_DISABLED;

describe("enqueueGeolite2FetchBootDiscovery — gating", () => {
  beforeEach(() => {
    sendMock.mockClear();
    sendMock.mockResolvedValue("job-1");
    offlineGeoReadyMock.mockReturnValue(false);
    process.env.MAXMIND_LICENSE_KEY = "test-key";
    delete process.env.IP_GEO_LOOKUP_DISABLED;
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.MAXMIND_LICENSE_KEY;
    else process.env.MAXMIND_LICENSE_KEY = ORIGINAL_KEY;
    if (ORIGINAL_DISABLED === undefined)
      delete process.env.IP_GEO_LOOKUP_DISABLED;
    else process.env.IP_GEO_LOOKUP_DISABLED = ORIGINAL_DISABLED;
  });

  it("enqueues a boot-mode fetch when keyed and no database is present", async () => {
    const { enqueued } = await enqueueGeolite2FetchBootDiscovery();
    expect(enqueued).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [queue, payload] = sendMock.mock.calls[0];
    expect(queue).toBe("geolite2-fetch");
    expect(payload).toMatchObject({ mode: "boot" });
  });

  it("skips when no MAXMIND_LICENSE_KEY is set", async () => {
    delete process.env.MAXMIND_LICENSE_KEY;
    const { enqueued } = await enqueueGeolite2FetchBootDiscovery();
    expect(enqueued).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips when IP_GEO_LOOKUP_DISABLED=1", async () => {
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const { enqueued } = await enqueueGeolite2FetchBootDiscovery();
    expect(enqueued).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("skips when the offline tier is already present", async () => {
    offlineGeoReadyMock.mockReturnValue(true);
    const { enqueued } = await enqueueGeolite2FetchBootDiscovery();
    expect(enqueued).toBe(0);
    expect(sendMock).not.toHaveBeenCalled();
  });
});
