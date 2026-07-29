import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SafeFetchError } from "@/lib/safe-fetch";

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return { ...actual, safeFetch: safeFetchMock };
});

import {
  buildEntriesUrl,
  fetchSgvEntries,
  mapSgvEntryToMeasurement,
  parseSgvEntries,
  sha1Hex,
  type NightscoutSgvEntry,
} from "../client";

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

const SAMPLE: NightscoutSgvEntry[] = [
  {
    _id: "abc123",
    type: "sgv",
    sgv: 112,
    date: 1718000000000,
    dateString: "2024-06-10T08:53:20.000Z",
  },
  {
    _id: "def456",
    type: "sgv",
    sgv: 98,
    date: 1718000300000,
    dateString: "2024-06-10T08:58:20.000Z",
  },
];

const ORIGINAL_PRIVATE_ORIGINS = process.env.NIGHTSCOUT_PRIVATE_ORIGINS;

beforeEach(() => {
  safeFetchMock.mockReset();
  delete process.env.NIGHTSCOUT_PRIVATE_ORIGINS;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_PRIVATE_ORIGINS === undefined) {
    delete process.env.NIGHTSCOUT_PRIVATE_ORIGINS;
  } else {
    process.env.NIGHTSCOUT_PRIVATE_ORIGINS = ORIGINAL_PRIVATE_ORIGINS;
  }
});

describe("parseSgvEntries", () => {
  it("keeps only SGV rows with a numeric value and timestamp", () => {
    const raw = [
      ...SAMPLE,
      { _id: "mbg1", type: "mbg", mbg: 100, date: 1718000600000 },
      { _id: "cal1", type: "cal", date: 1718000700000 },
      { _id: "bad", type: "sgv", sgv: null, date: 1718000800000 },
      { _id: "nodate", type: "sgv", sgv: 120 },
    ];
    const parsed = parseSgvEntries(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.sgv).toBe(112);
    expect(parsed[1]!.sgv).toBe(98);
  });

  it("returns an empty array for a non-array payload", () => {
    expect(parseSgvEntries(null)).toEqual([]);
    expect(parseSgvEntries({})).toEqual([]);
    expect(parseSgvEntries("nope")).toEqual([]);
  });
});

describe("mapSgvEntryToMeasurement", () => {
  it("maps a parsed SGV entry to a BLOOD_GLUCOSE mg/dL measurement", () => {
    const m = mapSgvEntryToMeasurement({
      id: "abc123",
      sgv: 112,
      date: 1718000000000,
    });
    expect(m.type).toBe("BLOOD_GLUCOSE");
    expect(m.unit).toBe("mg/dL");
    expect(m.value).toBe(112);
    expect(m.measuredAt.getTime()).toBe(1718000000000);
  });

  it("derives a stable externalId so re-sync is idempotent", () => {
    const entry = { id: "abc123", sgv: 112, date: 1718000000000 };
    const a = mapSgvEntryToMeasurement(entry);
    const b = mapSgvEntryToMeasurement(entry);
    expect(a.externalId).toBe(b.externalId);
    expect(a.externalId).toBe("ns:abc123");
  });

  it("falls back to the timestamp when the entry has no id", () => {
    const m = mapSgvEntryToMeasurement({
      id: null,
      sgv: 90,
      date: 1718000000000,
    });
    expect(m.externalId).toContain("1718000000000");
  });
});

describe("buildEntriesUrl", () => {
  it("requests SGV entries with the requested count", () => {
    const url = buildEntriesUrl("https://ns.example.com", 50);
    expect(url).toContain("/api/v1/entries.json");
    expect(url).toContain("count=50");
    expect(url).toContain("type=sgv");
  });

  it("normalises a trailing slash on the base URL", () => {
    const url = buildEntriesUrl("https://ns.example.com/", 10);
    expect(url).not.toContain("com//api");
  });

  it("appends the token as a query param when provided", () => {
    const url = buildEntriesUrl("https://ns.example.com", 10, "tok-abc");
    expect(url).toContain("token=tok-abc");
  });
});

describe("sha1Hex", () => {
  it("hashes the API secret as Nightscout expects (api-secret header)", () => {
    // Known SHA1 of "secret".
    expect(sha1Hex("secret")).toBe("e5e9fa1ba31ecd1ae84f75caaa474f3a663f05f4");
  });
});

describe("fetchSgvEntries — SSRF gating", () => {
  it("requires a public host by default (public instance)", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse(200, SAMPLE));
    await fetchSgvEntries({
      baseUrl: "https://ns.example.com",
      token: "",
      count: 10,
      allowPrivateHost: false,
    });
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const opts = safeFetchMock.mock.calls[0]![2];
    expect(opts.requirePublicHost).toBe(true);
  });

  it("keeps an exact operator-approved private origin functional", async () => {
    process.env.NIGHTSCOUT_PRIVATE_ORIGINS = "http://192.168.1.50:1337";
    safeFetchMock.mockResolvedValue(jsonResponse(200, SAMPLE));
    const entries = await fetchSgvEntries({
      baseUrl: "http://192.168.1.50:1337",
      token: "",
      count: 10,
      // Compatibility metadata is deliberately false: operator configuration,
      // not this user-controlled field, grants the private connection.
      allowPrivateHost: false,
    });

    expect(entries).toHaveLength(2);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not let the legacy user boolean authorize private egress", async () => {
    delete process.env.NIGHTSCOUT_PRIVATE_ORIGINS;

    await expect(
      fetchSgvEntries({
        baseUrl: "http://192.168.1.50:1337",
        token: "",
        count: 10,
        allowPrivateHost: true,
      }),
    ).rejects.toMatchObject({
      reasonCode: "private_origin_not_approved",
    });

    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("rejects the same private host on a different port before any network call", async () => {
    process.env.NIGHTSCOUT_PRIVATE_ORIGINS = "http://192.168.1.50:1337";

    await expect(
      fetchSgvEntries({
        baseUrl: "http://192.168.1.50:8080",
        token: "",
        count: 10,
        allowPrivateHost: true,
      }),
    ).rejects.toMatchObject({
      reasonCode: "private_origin_not_approved",
    });

    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it("maps a denied DNS answer or connect-time drift to one redacted policy reason", async () => {
    process.env.NIGHTSCOUT_PRIVATE_ORIGINS = "https://cgm.example.test";
    safeFetchMock.mockRejectedValue(
      new SafeFetchError(
        "safeFetch refused private resolved address for cgm.example.test/api/v1/entries.json?token=ns-secret",
        "private_host",
      ),
    );

    const rejected = fetchSgvEntries({
      baseUrl: "https://cgm.example.test",
      token: "ns-secret",
      count: 10,
      allowPrivateHost: true,
    });

    await expect(rejected).rejects.toMatchObject({
      message: "private_origin_not_approved",
      reasonCode: "private_origin_not_approved",
    });
    await expect(rejected).rejects.not.toMatchObject({
      message: expect.stringContaining("ns-secret"),
    });
  });

  it("pins redirect:manual + a timeout on every call", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse(200, SAMPLE));
    await fetchSgvEntries({
      baseUrl: "https://ns.example.com",
      token: "",
      count: 10,
      allowPrivateHost: false,
    });
    const opts = safeFetchMock.mock.calls[0]![2];
    expect(opts.followRedirects).toBeFalsy();
    expect(opts.timeoutMs).toBeGreaterThan(0);
  });

  it("surfaces a private-host rejection from safeFetch", async () => {
    safeFetchMock.mockRejectedValue(
      new SafeFetchError("refused", "private_host"),
    );
    await expect(
      fetchSgvEntries({
        baseUrl: "http://10.0.0.5",
        token: "",
        count: 10,
        allowPrivateHost: false,
      }),
    ).rejects.toThrow();
  });

  it("sends the api-secret SHA1 header when a token is supplied via header auth", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse(200, SAMPLE));
    await fetchSgvEntries({
      baseUrl: "https://ns.example.com",
      token: "secret",
      count: 10,
      allowPrivateHost: false,
      authMode: "header",
    });
    const init = safeFetchMock.mock.calls[0]![1];
    const headers = init.headers as Record<string, string>;
    expect(headers["api-secret"]).toBe(sha1Hex("secret"));
  });

  it("throws on a non-2xx upstream so the caller can classify", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse(401, { status: 401 }));
    await expect(
      fetchSgvEntries({
        baseUrl: "https://ns.example.com",
        token: "wrong",
        count: 10,
        allowPrivateHost: false,
      }),
    ).rejects.toThrow();
  });

  it("parses SGV rows from a successful response", async () => {
    safeFetchMock.mockResolvedValue(jsonResponse(200, SAMPLE));
    const entries = await fetchSgvEntries({
      baseUrl: "https://ns.example.com",
      token: "",
      count: 10,
      allowPrivateHost: false,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.sgv).toBe(112);
  });
});
