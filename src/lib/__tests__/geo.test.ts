import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// safeFetch's requirePublicHost path runs through undici's own `fetch`
// (version-locked with its dispatcher). Delegate it to the global `fetch`
// stub these tests install so the existing interception still applies.
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

// v1.18.11 (W3): capture wide-event warnings so the non-ok-status path can
// be asserted. `getEvent()` returns null outside a request context, so
// without this mock the `getEvent()?.addWarning(...)` call is a silent
// no-op and there is nothing to assert against.
const addWarningSpy = vi.fn();
vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    getEvent: () => ({ addWarning: addWarningSpy }),
  };
});

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.IP_GEO_LOOKUP_URL;
  delete process.env.IP_GEO_LOOKUP_DISABLED;
  delete process.env.IP_GEO_ALLOW_INSECURE;
  addWarningSpy.mockClear();
  vi.resetModules();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  vi.restoreAllMocks();
});

// V3 audit: /api/auth events were leaking IP + timestamp via plaintext
// HTTP to ip-api.com (GDPR Art. 32 + Art. 44). The lookup helper now
// (a) only egresses over HTTPS, (b) supports an opt-out env, and
// (c) accepts both ipwho.is and ip-api.com pro response shapes.
describe("lookupIpLocation IP-geolocation HTTPS guard", () => {
  it("returns null for private addresses without making any request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("10.0.0.5")).toBeNull();
    expect(await lookupIpLocation("127.0.0.1")).toBeNull();
    expect(await lookupIpLocation("::1")).toBeNull();
    expect(await lookupIpLocation(null)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns null when IP_GEO_LOOKUP_DISABLED=1", async () => {
    process.env.IP_GEO_LOOKUP_DISABLED = "1";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // v1.4.16 A8a: helper turns a JS object into a real `Response` whose
  // body is the UTF-8 byte stream of `JSON.stringify(value)`. The geo
  // helper now reads via `arrayBuffer() + TextDecoder('utf-8')` so the
  // test fakes have to expose those, not just `json()`.
  function jsonOk(value: unknown): Response {
    return new Response(
      new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer,
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  it("uses the ipwho.is HTTPS endpoint by default", async () => {
    // v1.25.5: ipwho.is is the default provider again. The wire URL must be
    // the ipwho.is path and the parser must accept its `success`/`country_code`
    // shape. (Operators whose egress ipwho.is rejects override IP_GEO_LOOKUP_URL
    // to ip-api.com — the parser still accepts that shape; covered below.)
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonOk({ success: true, city: "Berlin", country_code: "DE" }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Berlin, DE");
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url.startsWith("https://")).toBe(true);
    expect(url).toBe("https://ipwho.is/8.8.8.8");
  });

  it("uses the default provider when compose passes IP_GEO_LOOKUP_URL empty", async () => {
    // docker-compose.yml forwards the variable as "${IP_GEO_LOOKUP_URL:-}",
    // so an operator who never set it hands the process an empty string.
    process.env.IP_GEO_LOOKUP_URL = "";
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonOk({ success: true, city: "Berlin", country_code: "DE" }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Berlin, DE");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://ipwho.is/8.8.8.8");
  });

  it.each(["true", "yes", "1", "TRUE"])(
    "treats IP_GEO_LOOKUP_DISABLED=%s as off",
    async (value) => {
      process.env.IP_GEO_LOOKUP_DISABLED = value;
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);
      const { lookupIpLocation } = await import("../geo");

      expect(await lookupIpLocation("8.8.8.8")).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("refuses to call non-HTTPS configured providers", async () => {
    process.env.IP_GEO_LOOKUP_URL = "http://ip-api.com/json";
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response("", {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    const result = await lookupIpLocation("8.8.8.8");
    expect(result).toBeNull();
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    // Even when an operator misconfigures HTTP, the helper rewrites the
    // URL to a deliberately invalid HTTPS URL so the egress is HTTPS-only.
    expect(url.startsWith("https://")).toBe(true);
  });

  it("calls a plain-HTTP provider only when IP_GEO_ALLOW_INSECURE=true", async () => {
    // v1.25.6 — a self-hoster who explicitly opts in can use the free
    // HTTP-only ip-api.com endpoint; the helper then issues the HTTP request
    // verbatim and parses its `status`/`countryCode` shape.
    process.env.IP_GEO_LOOKUP_URL = "http://ip-api.com/json";
    process.env.IP_GEO_ALLOW_INSECURE = "true";
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonOk({ status: "success", city: "Bochum", countryCode: "DE" }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Bochum, DE");
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url).toBe("http://ip-api.com/json/8.8.8.8");
  });

  it("still refuses plain HTTP when the opt-in is any value other than 'true'", async () => {
    process.env.IP_GEO_LOOKUP_URL = "http://ip-api.com/json";
    process.env.IP_GEO_ALLOW_INSECURE = "1"; // not the literal "true"
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(jsonOk({ status: "success", countryCode: "DE" }));
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBeNull();
    const url = fetchSpy.mock.calls[0]?.[0] as string;
    expect(url.startsWith("https://")).toBe(true);
  });

  it("accepts the ip-api pro response shape (status:'success', countryCode)", async () => {
    process.env.IP_GEO_LOOKUP_URL = "https://pro.ip-api.com/json";
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonOk({
        status: "success",
        city: "Hamburg",
        countryCode: "DE",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Hamburg, DE");
  });
});

// v1.18.11 (W3): a non-ok HTTP status (403 free-plan/CORS rejection, 429
// rate-limit, 5xx) must surface a wide-event warning instead of being
// swallowed as a clean miss. The ipwho.is 403 that produced the prod "—"
// never emitted a single signal; this guards against that regression.
describe("lookupIpLocation non-ok status warning (v1.18.11 W3)", () => {
  function nonOk(status: number): Response {
    return new Response("", {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  for (const status of [403, 429, 503]) {
    it(`returns null and warns on HTTP ${status}`, async () => {
      const fetchSpy = vi.fn().mockResolvedValue(nonOk(status));
      vi.stubGlobal("fetch", fetchSpy);
      const { lookupIpLocation } = await import("../geo");

      expect(await lookupIpLocation("8.8.8.8")).toBeNull();
      expect(addWarningSpy).toHaveBeenCalledTimes(1);
      expect(addWarningSpy.mock.calls[0]?.[0]).toContain(String(status));
    });
  }

  it("does not warn on a clean 200 success", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(
        new TextEncoder().encode(
          JSON.stringify({
            status: "success",
            city: "Berlin",
            countryCode: "DE",
          }),
        ).buffer as ArrayBuffer,
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Berlin, DE");
    expect(addWarningSpy).not.toHaveBeenCalled();
  });
});

// v1.4.16 A8a: the maintainer spotted "Nrnberg" rendered in /admin/login-overview
// for an audit row that should have read "Nürnberg, DE". The geo source
// (ipwho.is) returns valid UTF-8, but `Response.json()` defers its
// charset decoding to whatever the server's `Content-Type` header
// claims, so an upstream proxy that strips the charset parameter (or
// re-serves the body as latin-1) can poison the umlaut path. The fix
// reads the body as a UTF-8 ArrayBuffer first, then JSON.parses.
// The umlaut-roundtrip test is the regression guard.
describe("lookupIpLocation umlaut roundtrip (v1.4.16 A8a)", () => {
  // Build a Response-like that serves a UTF-8 byte stream — what ipwho.is
  // actually puts on the wire — instead of letting the Vitest test runner
  // hand the parser a pre-decoded JS object, which masks any
  // `Content-Type`-charset-driven decoding bug.
  function utf8JsonResponse(body: object): Response {
    return new Response(
      new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer,
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  for (const city of [
    "Nürnberg",
    "München",
    "Düsseldorf",
    "Köln",
    "Würzburg",
    "Bückeburg",
  ]) {
    it(`preserves "${city}" through fetch → DB-ready string`, async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          utf8JsonResponse({ success: true, city, country_code: "DE" }),
        );
      vi.stubGlobal("fetch", fetchSpy);
      const { lookupIpLocation } = await import("../geo");

      expect(await lookupIpLocation("8.8.8.8")).toBe(`${city}, DE`);
    });
  }

  it('preserves the eszett ("ß") in country/region names', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      utf8JsonResponse({
        success: true,
        city: "Weißenfels",
        country_code: "DE",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Weißenfels, DE");
  });

  it("survives a Content-Type header that omits the charset", async () => {
    // Defensive: some upstream proxies strip `; charset=utf-8`. The body
    // stays UTF-8 bytes; the helper must not let Response.json()'s
    // charset-defaulting behaviour hide an umlaut.
    const headers = new Headers({ "content-type": "application/json" });
    const body = new TextEncoder().encode(
      JSON.stringify({ success: true, city: "Nürnberg", country_code: "DE" }),
    );
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(body.buffer as ArrayBuffer, {
        status: 200,
        headers,
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    expect(await lookupIpLocation("8.8.8.8")).toBe("Nürnberg, DE");
  });

  it("hints providers it wants localized names via Accept-Language", async () => {
    // ipwho.is and ip-api both honour Accept-Language for the city
    // field; without the hint, ip-api falls back to English ASCII fold
    // ("Nuremberg"). Setting de;q=1, en;q=0.5 keeps the user-facing
    // text close to the locale the audit-log overview renders in.
    const fetchSpy = vi.fn().mockResolvedValue(
      utf8JsonResponse({
        success: true,
        city: "Nürnberg",
        country_code: "DE",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpLocation } = await import("../geo");

    await lookupIpLocation("8.8.8.8");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(init?.headers ?? {});
    const al = headers.get("accept-language") ?? "";
    expect(al.toLowerCase()).toMatch(/de/);
  });
});

// v1.25.8: the network operator (carrier) is now mined from the same online
// provider response the location lookup fetched, so a host WITHOUT the
// optional offline GeoLite2-ASN MMDB still resolves a carrier. `lookupIpGeo`
// returns location + asn + carrier in one pass.
describe("lookupIpGeo carrier resolution (v1.25.8)", () => {
  function jsonOk(value: unknown): Response {
    return new Response(
      new TextEncoder().encode(JSON.stringify(value)).buffer as ArrayBuffer,
      {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  it("reads ip-api top-level isp + parses the AS number from `as`", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonOk({
        status: "success",
        city: "Bochum",
        countryCode: "DE",
        isp: "Deutsche Telekom AG",
        org: "Deutsche Telekom AG",
        as: "AS3320 Deutsche Telekom AG",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect(await lookupIpGeo("8.8.8.8")).toEqual({
      location: "Bochum, DE",
      asn: 3320,
      carrier: "Deutsche Telekom AG",
    });
  });

  it("reads ipwho.is nested connection.{isp,asn}", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonOk({
        success: true,
        city: "Berlin",
        country_code: "DE",
        connection: {
          asn: 3320,
          isp: "Deutsche Telekom AG",
          org: "Deutsche Telekom AG",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect(await lookupIpGeo("8.8.8.8")).toEqual({
      location: "Berlin, DE",
      asn: 3320,
      carrier: "Deutsche Telekom AG",
    });
  });

  it("resolves a carrier even when the AS number is absent", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonOk({
        status: "success",
        city: "Bochum",
        countryCode: "DE",
        isp: "Deutsche Telekom AG",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect(await lookupIpGeo("8.8.8.8")).toEqual({
      location: "Bochum, DE",
      asn: null,
      carrier: "Deutsche Telekom AG",
    });
  });

  it("falls back to org when no isp field is present", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonOk({
        status: "success",
        city: "Hamburg",
        countryCode: "DE",
        org: "Vodafone GmbH",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    const result = await lookupIpGeo("8.8.8.8");
    expect(result.carrier).toBe("Vodafone GmbH");
  });

  it("returns an all-null record for private addresses without a request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { lookupIpGeo } = await import("../geo");

    expect(await lookupIpGeo("10.0.0.5")).toEqual({
      location: null,
      asn: null,
      carrier: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resolveGeoProviderHost (task #162)", () => {
  it("returns the default ipwho.is host when IP_GEO_LOOKUP_URL is unset", async () => {
    const { resolveGeoProviderHost } = await import("../geo");
    expect(resolveGeoProviderHost()).toBe("ipwho.is");
  });

  it("returns the configured provider host", async () => {
    process.env.IP_GEO_LOOKUP_URL = "http://ip-api.com/json";
    const { resolveGeoProviderHost } = await import("../geo");
    expect(resolveGeoProviderHost()).toBe("ip-api.com");
  });

  it("preserves an explicit port in the host", async () => {
    process.env.IP_GEO_LOOKUP_URL = "https://geo.example.com:8443/lookup";
    const { resolveGeoProviderHost } = await import("../geo");
    expect(resolveGeoProviderHost()).toBe("geo.example.com:8443");
  });

  it("falls back to the default host for a blank env value", async () => {
    process.env.IP_GEO_LOOKUP_URL = "   ";
    const { resolveGeoProviderHost } = await import("../geo");
    expect(resolveGeoProviderHost()).toBe("ipwho.is");
  });

  it("falls back to the default host for an unparseable env value", async () => {
    process.env.IP_GEO_LOOKUP_URL = "not a url";
    const { resolveGeoProviderHost } = await import("../geo");
    expect(resolveGeoProviderHost()).toBe("ipwho.is");
  });
});
