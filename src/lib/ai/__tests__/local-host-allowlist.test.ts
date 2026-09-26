import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetAiGrantsForTests,
  aiEgressPolicyFor,
  grantedAiOrigin,
  isLocalAiHostAllowed,
  legacyAnyHostConfigured,
  LEGACY_ANY_HOST_WARNING,
  originNeedingAiGrant,
} from "../local-host-allowlist";

/**
 * v1.39.3 — AI base URLs on a private network are granted by exact origin
 * (`AI_PRIVATE_ORIGINS`), the grammar the notification and Nightscout grants
 * use, and dialled through the pinned operator-approved dispatcher. The legacy
 * host list keeps working; its deprecated `=true` form covers only the
 * operator's own configurations.
 */

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetAiGrantsForTests();
  vi.stubEnv("AI_PRIVATE_ORIGINS", "");
  vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "");
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe("AI_PRIVATE_ORIGINS", () => {
  it("grants nothing when unset", () => {
    expect(isLocalAiHostAllowed("http://10.0.0.5:11434/v1")).toBe(false);
    expect(isLocalAiHostAllowed("http://ollama.lan/v1")).toBe(false);
  });

  it("grants exactly the listed origin, not its siblings", () => {
    vi.stubEnv(
      "AI_PRIVATE_ORIGINS",
      "http://ollama.lan:11434, http://10.0.0.5:4000",
    );
    expect(grantedAiOrigin("http://ollama.lan:11434/v1/chat")).toBe(
      "http://ollama.lan:11434",
    );
    expect(isLocalAiHostAllowed("http://10.0.0.5:4000/v1")).toBe(true);
    // Another port, another scheme, a subdomain: all separate origins.
    expect(isLocalAiHostAllowed("http://ollama.lan:8080/v1")).toBe(false);
    expect(isLocalAiHostAllowed("https://ollama.lan:11434/v1")).toBe(false);
    expect(isLocalAiHostAllowed("http://evil.ollama.lan:11434/v1")).toBe(false);
    expect(isLocalAiHostAllowed("http://10.0.0.6:4000/v1")).toBe(false);
  });

  it("never grants metadata, link-local or the unspecified address, even when listed", () => {
    vi.stubEnv(
      "AI_PRIVATE_ORIGINS",
      "http://169.254.169.254,http://[fe80::1]:80,http://0.0.0.0:11434",
    );
    expect(isLocalAiHostAllowed("http://169.254.169.254/latest/")).toBe(false);
    expect(isLocalAiHostAllowed("http://[fe80::1]/v1")).toBe(false);
    expect(isLocalAiHostAllowed("http://0.0.0.0:11434/v1")).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe("ALLOW_LOCAL_AI_PRIVATE_HOSTS (legacy)", () => {
  it("still grants a listed host on any port", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", " Ollama.LAN , 10.0.0.5 ");
    expect(isLocalAiHostAllowed("http://ollama.lan:11434/v1")).toBe(true);
    expect(isLocalAiHostAllowed("http://10.0.0.5:8080/v1")).toBe(true);
    expect(isLocalAiHostAllowed("http://10.0.0.6/v1")).toBe(false);
  });

  it("`true` still covers an operator-owned configuration, pinned, and says it is deprecated", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    expect(
      aiEgressPolicyFor("http://10.0.0.5:11434/v1", { operatorTrusted: true }),
    ).toEqual({
      requirePublicHost: false,
      operatorApprovedPrivateOrigin: "http://10.0.0.5:11434",
    });
    expect(warn).toHaveBeenCalledWith(LEGACY_ANY_HOST_WARNING);
    expect(LEGACY_ANY_HOST_WARNING).toContain("deprecated");
    expect(LEGACY_ANY_HOST_WARNING).toContain("AI_PRIVATE_ORIGINS=");
    expect(legacyAnyHostConfigured()).toBe(true);
  });

  it("`true` no longer covers a non-admin account's own base URL", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    expect(isLocalAiHostAllowed("http://10.0.0.5:11434/v1")).toBe(false);
    expect(
      isLocalAiHostAllowed("http://10.0.0.5:11434/v1", {
        operatorTrusted: false,
      }),
    ).toBe(false);
    expect(aiEgressPolicyFor("http://10.0.0.5:11434/v1")).toEqual({
      requirePublicHost: true,
    });
  });

  it("`true` never opens metadata, link-local or the unspecified address, even for the operator", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://[fe80::1]/v1",
      "http://0.0.0.0:11434/v1",
      "http://[::ffff:169.254.169.254]/v1",
    ]) {
      expect(isLocalAiHostAllowed(url, { operatorTrusted: true }), url).toBe(
        false,
      );
    }
  });

  it("an exact origin grant covers every account, with or without `true`", () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", "http://ollama.lan:11434");
    expect(isLocalAiHostAllowed("http://ollama.lan:11434/v1")).toBe(true);
  });

  it("refuses a metadata literal and a host:port entry instead of granting a guess", () => {
    vi.stubEnv(
      "ALLOW_LOCAL_AI_PRIVATE_HOSTS",
      "169.254.169.254,ollama.lan:11434",
    );
    expect(isLocalAiHostAllowed("http://169.254.169.254/latest/")).toBe(false);
    expect(isLocalAiHostAllowed("http://ollama.lan:11434/v1")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("an unparseable URL is never granted", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "ollama.lan");
    expect(isLocalAiHostAllowed("not a url")).toBe(false);
  });
});

describe("aiEgressPolicyFor", () => {
  it("pins an ungranted URL to the public dispatcher", () => {
    expect(aiEgressPolicyFor("http://10.0.0.5/v1")).toEqual({
      requirePublicHost: true,
    });
    expect(aiEgressPolicyFor("https://api.example.com/v1")).toEqual({
      requirePublicHost: true,
    });
  });

  it("hands a granted URL to the operator-approved dispatcher for exactly its origin", () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", "http://ollama.lan:11434");
    expect(aiEgressPolicyFor("http://ollama.lan:11434/v1/chat")).toEqual({
      requirePublicHost: false,
      operatorApprovedPrivateOrigin: "http://ollama.lan:11434",
    });
  });
});

describe("originNeedingAiGrant", () => {
  it("names the origin of a LAN endpoint no grant covers yet", () => {
    for (const [url, origin] of [
      ["http://10.0.0.5:11434/v1", "http://10.0.0.5:11434"],
      ["http://ollama.lan:11434/v1", "http://ollama.lan:11434"],
      ["http://ollama:11434/v1", "http://ollama:11434"],
      ["http://nas.local:1234/v1", "http://nas.local:1234"],
      ["http://localhost:11434/v1", "http://localhost:11434"],
    ]) {
      expect(originNeedingAiGrant(url), url).toBe(origin);
    }
  });

  it("skips hosted endpoints, never-grantable addresses and origins already granted", () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", "http://10.0.0.5:11434");
    for (const url of [
      "https://openrouter.ai/api/v1",
      "https://api.openai.com/v1",
      "http://169.254.169.254/latest",
      "http://10.0.0.5:11434/v1",
      "not a url",
    ]) {
      expect(originNeedingAiGrant(url), url).toBeNull();
    }
  });
});
