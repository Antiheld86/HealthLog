import { afterEach, describe, expect, it, vi } from "vitest";

import {
  configuredDocumentSourceOrigins,
  documentSourcesAvailable,
  evaluateSourceBaseUrl,
  listedDocumentSourceOrigins,
} from "../origins";

const ORIGINAL = process.env.DOCUMENT_SOURCE_ORIGINS;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.DOCUMENT_SOURCE_ORIGINS;
  else process.env.DOCUMENT_SOURCE_ORIGINS = ORIGINAL;
  vi.restoreAllMocks();
});

describe("DOCUMENT_SOURCE_ORIGINS", () => {
  it("is off when unset or empty", () => {
    delete process.env.DOCUMENT_SOURCE_ORIGINS;
    expect(documentSourcesAvailable()).toBe(false);
    process.env.DOCUMENT_SOURCE_ORIGINS = "  ";
    expect(documentSourcesAvailable()).toBe(false);
  });

  it("keeps valid exact origins and drops malformed ones with a redacted warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.DOCUMENT_SOURCE_ORIGINS =
      "https://paperless.example.com, http://papra.lan:1221, https://user:secret@bad.example/x?token=abc, http://169.254.169.254";
    const origins = configuredDocumentSourceOrigins();
    expect([...origins].sort()).toEqual([
      "http://papra.lan:1221",
      "https://paperless.example.com",
    ]);
    expect(documentSourcesAvailable()).toBe(true);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("DOCUMENT_SOURCE_ORIGINS");
    expect(logged).not.toContain("secret");
    expect(logged).not.toContain("token=abc");
  });

  it("lists the origins for the settings card", () => {
    process.env.DOCUMENT_SOURCE_ORIGINS =
      "https://paperless.example.com,http://papra.lan:1221";
    expect(listedDocumentSourceOrigins()).toEqual([
      "http://papra.lan:1221",
      "https://paperless.example.com",
    ]);
  });
});

describe("evaluateSourceBaseUrl", () => {
  const listed = new Set(["https://paperless.example.com", "http://10.0.0.5"]);

  it("accepts a listed origin and keeps a base path without the trailing slash", () => {
    expect(
      evaluateSourceBaseUrl("https://paperless.example.com/paperless/", listed),
    ).toEqual({
      ok: true,
      origin: "https://paperless.example.com",
      baseUrl: "https://paperless.example.com/paperless",
    });
    expect(evaluateSourceBaseUrl("http://10.0.0.5", listed)).toEqual({
      ok: true,
      origin: "http://10.0.0.5",
      baseUrl: "http://10.0.0.5",
    });
  });

  it("refuses an origin that is not listed, public or private", () => {
    for (const url of [
      "https://example.org",
      "http://10.0.0.6",
      "http://192.168.1.10:8000",
      "http://169.254.169.254",
      "http://localhost:8000",
    ]) {
      expect(evaluateSourceBaseUrl(url, listed), url).toEqual({
        ok: false,
        reason: "notAllowed",
      });
    }
  });

  it("does not turn a listed host into a suffix, sibling port or other scheme grant", () => {
    for (const url of [
      "https://evil.paperless.example.com",
      "https://paperless.example.com:8443",
      "http://paperless.example.com",
      "https://paperless.example.com.evil.test",
    ]) {
      expect(evaluateSourceBaseUrl(url, listed).ok, url).toBe(false);
    }
  });

  it("refuses userinfo, a query, a fragment and non-http schemes", () => {
    for (const url of [
      "https://user:pass@paperless.example.com",
      "https://paperless.example.com/?token=x",
      "https://paperless.example.com/#x",
      "ftp://paperless.example.com",
      "not a url",
    ]) {
      expect(evaluateSourceBaseUrl(url, listed), url).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });
});
