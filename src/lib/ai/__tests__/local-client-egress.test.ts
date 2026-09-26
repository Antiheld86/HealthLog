/**
 * v1.39.3 — the destination policy an AI call is dialled with.
 *
 * A granted private origin goes to `safeFetch` as an exact
 * `operatorApprovedPrivateOrigin`, which routes the connect through the pinned
 * operator-approved dispatcher: redirects forbidden, metadata, link-local and
 * the unspecified address dropped at dial time even for a granted name. Before
 * this release a granted host was dialled with no pin at all. Everything else
 * is pinned to public hosts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { safeFetch } = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@/lib/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/safe-fetch")>()),
  safeFetch,
}));

import { LocalOpenAICompatibleClient } from "../local-client";
import { _resetAiGrantsForTests } from "../local-host-allowlist";
import { singleUserTurn } from "../types";

function client(baseUrl: string) {
  return new LocalOpenAICompatibleClient({
    apiKey: null,
    model: "llama3:8b",
    baseUrl,
  });
}

beforeEach(() => {
  _resetAiGrantsForTests();
  safeFetch.mockReset();
  safeFetch.mockResolvedValue(
    new Response(
      JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  vi.stubEnv("AI_PRIVATE_ORIGINS", "");
  vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const call = singleUserTurn({ system: "sys", user: "hi" });

describe("Local AI egress policy", () => {
  it("dials a granted origin through the operator-approved pin", async () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", "http://ollama.lan:11434");
    await client("http://ollama.lan:11434/v1").generateCompletion(call);
    const opts = safeFetch.mock.calls[0][2];
    expect(opts).toMatchObject({
      requirePublicHost: false,
      operatorApprovedPrivateOrigin: "http://ollama.lan:11434",
    });
  });

  it("pins an ungranted private URL to public hosts, so safeFetch refuses it", async () => {
    await client("http://10.0.0.5:11434/v1").generateCompletion(call);
    const opts = safeFetch.mock.calls[0][2];
    expect(opts.requirePublicHost).toBe(true);
    expect(opts).not.toHaveProperty("operatorApprovedPrivateOrigin");
  });

  it("the deprecated `=true` no longer covers a non-admin account's endpoint", async () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    await client("http://10.0.0.5:11434/v1").generateCompletion(call);
    expect(safeFetch.mock.calls[0][2].requirePublicHost).toBe(true);
  });

  it("the deprecated `=true` still covers the operator's own endpoint, pinned", async () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    await new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://10.0.0.5:11434/v1",
      operatorTrusted: true,
    }).generateCompletion(call);
    expect(safeFetch.mock.calls[0][2]).toMatchObject({
      requirePublicHost: false,
      operatorApprovedPrivateOrigin: "http://10.0.0.5:11434",
    });
  });

  it("streams through the same policy", async () => {
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "ollama.lan");
    await client("http://ollama.lan:11434/v1")
      .generateCompletionStream(call, () => {})
      .catch(() => undefined);
    expect(safeFetch.mock.calls[0][2]).toMatchObject({
      requirePublicHost: false,
      operatorApprovedPrivateOrigin: "http://ollama.lan:11434",
    });
  });
});
