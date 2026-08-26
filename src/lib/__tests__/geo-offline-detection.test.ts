import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * v1.4.27 R5 — runtime detection + one-shot admin notification for the
 * offline GeoLite2 tier.
 *
 * The CI workflow drops an `.empty` marker into `assets/geolite2/`
 * whenever `MAXMIND_LICENSE_KEY` is unset, so the Docker COPY still
 * lands a non-empty directory in `/opt/geolite2/`. The runtime resolver
 * detects the marker on first fallback, fires a single localised
 * notification to every admin, and stays silent for the rest of the
 * process lifetime.
 *
 * The tests cover the three states the design pins:
 *
 *   1. `.empty` marker present, City MMDB absent → notification fires
 *      on first public-IP lookup.
 *   2. No marker, City MMDB present → no notification fires.
 *   3. Marker present, repeat lookups → notification fires once and
 *      never again.
 *
 * `mmdb-lib` is stubbed via the same shape the existing
 * `geo-asn.test.ts` uses; `fs` is left real because `offlineGeoReady`
 * reads real files at the temp-dir path picked per test, and the
 * `dispatchLocalisedNotification` + `prisma.user.findMany` are mocked
 * so the test never reaches a database or a sender.
 */

vi.mock("mmdb-lib", () => ({
  Reader: class {
    constructor(_buf: Buffer) {
      void _buf;
    }
    get(ip: string): unknown {
      void ip;
      return null;
    }
  },
}));

const dispatchSpy = vi.fn(async () => undefined);
vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: dispatchSpy,
}));

const findManySpy = vi.fn(async () => [{ id: "admin-1" }]);
vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findMany: findManySpy },
  },
}));

const ORIGINAL_ENV = { ...process.env };
let tmpRoot: string;

async function flushMicrotasks(): Promise<void> {
  // The notification path is fire-and-forget — `void notify…()` —
  // and pulls in `@/lib/db` + `@/lib/notifications/dispatch-localised`
  // through dynamic `import()` calls, so each dispatch needs several
  // microtask + macrotask flushes before the spy registers the call.
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.IP_GEO_LOOKUP_DISABLED;
  tmpRoot = mkdtempSync(join(tmpdir(), "healthlog-geo-r5-"));
  process.env.GEOLITE2_DIR = tmpRoot;
  dispatchSpy.mockClear();
  findManySpy.mockClear();
  findManySpy.mockResolvedValue([{ id: "admin-1" }]);
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("offline-geo runtime detection (v1.4.27 R5)", () => {
  it("offlineGeoReady() is false when the .empty marker is present", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    const { offlineGeoReady } = await import("../geo");
    expect(offlineGeoReady()).toBe(false);
  });

  it("offlineGeoReady() is false when the City MMDB is absent", async () => {
    const { offlineGeoReady } = await import("../geo");
    expect(offlineGeoReady()).toBe(false);
  });

  it("treats a blank GEOLITE2_DIR as unset rather than as the working directory", async () => {
    // A compose `${GEOLITE2_DIR:-}` substitutes to the EMPTY STRING, which
    // is not nullish. Without the trim, `path.join("", "GeoLite2-City.mmdb")`
    // is a RELATIVE path and the readiness check answers from whatever the
    // process working directory happens to hold. Proven by putting a stub
    // MMDB in the working directory and asserting the blank value still
    // resolves to the documented default (which has none).
    const originalCwd = process.cwd();
    writeFileSync(join(tmpRoot, "GeoLite2-City.mmdb"), Buffer.from("stub"));
    process.chdir(tmpRoot);
    try {
      process.env.GEOLITE2_DIR = "";
      const { offlineGeoReady } = await import("../geo");
      expect(offlineGeoReady()).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("offlineGeoReady() is true when the City MMDB is present and no marker", async () => {
    writeFileSync(
      join(tmpRoot, "GeoLite2-City.mmdb"),
      Buffer.from("city-stub"),
    );
    const { offlineGeoReady } = await import("../geo");
    expect(offlineGeoReady()).toBe(true);
  });

  it("fires the one-shot admin notification when the marker is present and lookupIpLocation falls back", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    // Disable the online fallback so the test does not hit the network.
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const { lookupIpLocation } = await import("../geo");

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();

    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "admin-1",
        titleKey: "notifications.admin.offlineGeoUnavailableTitle",
        messageKey: "notifications.admin.offlineGeoUnavailableBody",
        params: expect.objectContaining({
          host: "ipwho.is",
          docsUrl: expect.stringContaining("docs/self-hosting/geolite2.md"),
        }),
        metadata: expect.objectContaining({ source: "geo-offline-detection" }),
      }),
    );
  });

  it("names the real online provider in the notification params", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    process.env.IP_GEO_LOOKUP_URL = "https://ip-api.example/json";
    const { lookupIpLocation } = await import("../geo");

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();

    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ host: "ip-api.example" }),
      }),
    );
  });

  it("points the admin at a reachable action, never at a repository secret", async () => {
    // issue #659 — the message used to tell a self-hoster to set
    // MAXMIND_LICENSE_KEY in this repository's Actions secrets, which is
    // not something they can do. Every locale must name the mount instead.
    const locales = ["de", "en", "es", "fr", "it", "pl", "ko"] as const;
    for (const locale of locales) {
      const bundle = JSON.parse(
        readFileSync(
          join(__dirname, `../../../messages/${locale}.json`),
          "utf8",
        ),
      ) as {
        notifications: { admin: { offlineGeoUnavailableBody: string } };
      };
      const body = bundle.notifications.admin.offlineGeoUnavailableBody;
      expect(body, `${locale} still names a build-time secret`).not.toMatch(
        /MAXMIND_LICENSE_KEY|GitHub|Actions|secret/i,
      );
      expect(body, `${locale} does not name the reachable override`).toContain(
        "GEOLITE2_DIR",
      );
      expect(body, `${locale} drops the {host} placeholder`).toContain(
        "{host}",
      );
      expect(body, `${locale} drops the {docsUrl} placeholder`).toContain(
        "{docsUrl}",
      );
    }
  });

  it("does NOT fire the notification when the City MMDB is present", async () => {
    writeFileSync(
      join(tmpRoot, "GeoLite2-City.mmdb"),
      Buffer.from("city-stub"),
    );
    // The stubbed reader returns null for every IP, which is fine — the
    // lookup will still go through the online path, but the offline
    // check sees a healthy directory so the notification stays silent.
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const { lookupIpLocation } = await import("../geo");

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();

    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(findManySpy).not.toHaveBeenCalled();
  });

  it("fires the notification exactly once across repeated fallbacks (process-level latch)", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const { lookupIpLocation, lookupIpAsn } = await import("../geo");

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();
    await lookupIpLocation("1.1.1.1");
    await flushMicrotasks();
    lookupIpAsn("9.9.9.9");
    await flushMicrotasks();

    // Three fallbacks, exactly one dispatch.
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back silently when no admin user is configured", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    findManySpy.mockResolvedValueOnce([]);
    const { lookupIpLocation } = await import("../geo");

    await lookupIpLocation("8.8.8.8");
    await flushMicrotasks();

    expect(findManySpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it("lookupIpAsn fires the notification when the ASN reader is missing and the marker is set", async () => {
    writeFileSync(join(tmpRoot, ".empty"), "");
    const { lookupIpAsn } = await import("../geo");

    const result = lookupIpAsn("8.8.8.8");
    await flushMicrotasks();

    expect(result).toBeNull();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
  });
});
