import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetAiGrantsForTests,
  aiEgressPolicyFor,
  grantedAiOrigin,
  isLocalAiHostAllowed,
  legacyAnyHostConfigured,
  LEGACY_ANY_HOST_WARNING,
} from "../local-host-allowlist";

/**
 * v1.39.3 — AI base URLs on a private network are granted by exact origin
 * (`AI_PRIVATE_ORIGINS`), the grammar the notification and Nightscout grants
 * use, and dialled through the pinned operator-approved dispatcher. The legacy
 * host list keeps working; its `=true` form grants nothing.
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

  it("no longer opens every private host with `true`, and says so", () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    expect(isLocalAiHostAllowed("http://10.0.0.5:11434/v1")).toBe(false);
    expect(isLocalAiHostAllowed("http://169.254.169.254/latest/")).toBe(false);
    expect(warn).toHaveBeenCalledWith(LEGACY_ANY_HOST_WARNING);
    expect(legacyAnyHostConfigured()).toBe(true);
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
