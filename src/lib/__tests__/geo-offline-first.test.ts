/**
 * The offline tier is consulted FIRST, and a local hit makes no request.
 *
 * From v1.18.10 until v1.37 the resolver queried the online provider first
 * and read the MMDBs only when that missed. Every document describing the
 * feature said the opposite — the contributor notes, the self-hosting runbook,
 * the admin notification that tells an operator their login IPs are leaving
 * the server. So an operator who mounted the databases in order to stop that
 * egress kept every bit of it, and nothing said so: the location resolved, the
 * admin overview filled in, and the only difference was where the address had
 * been.
 *
 * The assertion that matters is therefore about the fetch that does NOT
 * happen. Watched red: restore the old order (online lookup first, offline as
 * the fallback) and the first two cases fail on a call count of 1.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The MMDB readers are stubbed: `loadMmdbReader` only needs the file to
// exist, and what the reader answers is this table.
const cityRows = new Map<string, unknown>();
const asnRows = new Map<string, unknown>();

vi.mock("mmdb-lib", () => ({
  Reader: class {
    private readonly rows: Map<string, unknown>;
    constructor(buf: Buffer) {
      // The two readers are told apart by the stub file's own content, which
      // is the only thing distinguishing them at construction time.
      this.rows = buf.toString().startsWith("asn") ? asnRows : cityRows;
    }
    get(ip: string): unknown {
      return this.rows.get(ip) ?? null;
    }
  },
}));

// safeFetch's requirePublicHost path runs through undici's own `fetch`.
// Delegate it to the global stub so an outbound call is visible either way.
vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    fetch: (input: unknown, init?: unknown) =>
      (globalThis.fetch as unknown as (i: unknown, n?: unknown) => unknown)(
        input,
        init,
      ),
  };
});

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: vi.fn(async () => undefined),
}));
vi.mock("@/lib/db", () => ({
  prisma: { user: { findMany: vi.fn(async () => []) } },
}));

const ORIGINAL_ENV = { ...process.env };
let tmpRoot: string;

function jsonOk(value: unknown): Response {
  return new Response(
    new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer,
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function writeCityDb(): void {
  writeFileSync(join(tmpRoot, "GeoLite2-City.mmdb"), Buffer.from("city-stub"));
}

function writeAsnDb(): void {
  writeFileSync(join(tmpRoot, "GeoLite2-ASN.mmdb"), Buffer.from("asn-stub"));
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.IP_GEO_LOOKUP_URL;
  delete process.env.IP_GEO_LOOKUP_DISABLED;
  delete process.env.IP_GEO_ALLOW_INSECURE;
  tmpRoot = mkdtempSync(join(tmpdir(), "healthlog-geo-offline-first-"));
  process.env.GEOLITE2_DIR = tmpRoot;
  cityRows.clear();
  asnRows.clear();
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("geo resolver is offline-first", () => {
  it("makes no outbound request when the MMDBs place the address", async () => {
    writeCityDb();
    writeAsnDb();
    cityRows.set("8.8.8.8", {
      city: { names: { de: "Nürnberg", en: "Nuremberg" } },
      country: { iso_code: "DE" },
    });
    asnRows.set("8.8.8.8", {
      autonomous_system_number: 3320,
      autonomous_system_organization: "Deutsche Telekom AG",
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect(await lookupIpGeo("8.8.8.8")).toEqual({
      location: "Nürnberg, DE",
      asn: 3320,
      carrier: "Deutsche Telekom AG",
    });
    expect(
      fetchSpy,
      "an address the local databases placed still left the host",
    ).not.toHaveBeenCalled();
  });

  it("makes no outbound request when only the City MMDB is mounted", async () => {
    // The ASN database is a separate download and an operator may have only
    // the City one. Reaching out for a carrier string would send the address
    // off the host anyway, which is the thing the mount was for.
    writeCityDb();
    cityRows.set("9.9.9.9", {
      city: { names: { en: "Zurich" } },
      country: { iso_code: "CH" },
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect(await lookupIpGeo("9.9.9.9")).toEqual({
      location: "Zurich, CH",
      asn: null,
      carrier: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls through to the online provider when the MMDB holds no row", async () => {
    writeCityDb();
    writeAsnDb();
    // Databases present, this address simply not in them.
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonOk({
        success: true,
        city: "Berlin",
        country_code: "DE",
        connection: { asn: 3209, isp: "Vodafone" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect(await lookupIpGeo("1.1.1.1")).toEqual({
      location: "Berlin, DE",
      asn: 3209,
      carrier: "Vodafone",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the offline ASN authoritative when the location came from online", async () => {
    writeCityDb();
    writeAsnDb();
    asnRows.set("1.1.1.1", {
      autonomous_system_number: 13335,
      autonomous_system_organization: "Cloudflare, Inc.",
    });
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonOk({
        success: true,
        city: "Berlin",
        country_code: "DE",
        connection: { asn: 3209, isp: "Vodafone" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect(await lookupIpGeo("1.1.1.1")).toEqual({
      location: "Berlin, DE",
      asn: 13335,
      carrier: "Cloudflare, Inc.",
    });
  });

  it("leaves the online path unchanged when no MMDB is mounted", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonOk({ success: true, city: "Berlin", country_code: "DE" }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect(await lookupIpGeo("8.8.8.8")).toEqual({
      location: "Berlin, DE",
      asn: null,
      carrier: null,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ipwho.is/8.8.8.8");
  });

  it("resolves locally with IP_GEO_LOOKUP_DISABLED set, and never reaches the network without the databases", async () => {
    // The kill switch is unchanged by the reordering: it disables step 3
    // only, so an offline hit still resolves and an offline miss returns
    // null rather than going online.
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    writeCityDb();
    cityRows.set("8.8.8.8", {
      city: { names: { en: "Vienna" } },
      country: { iso_code: "AT" },
    });

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect((await lookupIpGeo("8.8.8.8")).location).toBe("Vienna, AT");
    expect((await lookupIpGeo("1.1.1.1")).location).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
