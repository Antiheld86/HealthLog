import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIClient } from "../openai-client";
import { resetJsonModeDialectCache } from "../json-dialect";
import { singleUserTurn } from "../types";

/**
 * The OpenAI-compatible gateway provider (#470), at the wire.
 *
 * Two properties carry the security weight of this provider and are pinned
 * here rather than left to review:
 *
 *   1. The `codex` tag keeps `requirePublicHost: true` no matter what the
 *      operator allowlisted — its base URL is a repository constant. The
 *      gateway and `admin-key` tags — the two whose base URL a person can
 *      type — consult the allowlist, and without an allowlist entry a
 *      private host is refused exactly as before (v1.37.30).
 *   2. The SSRF floor under the gateway is `isPublicUrl`, which is the same
 *      floor the Local provider sits on, including every IPv4 / IPv6
 *      alt-notation class.
 *
 * `safeFetch` runs for real here (only the transport underneath it is
 * stubbed), so a private-host rejection in these tests is the production
 * rejection, not a mock of one.
 */

// safeFetch's requirePublicHost path runs through undici's own `fetch`
// (version-locked with its dispatcher). Delegate it to the global `fetch`
// stub these tests install so the interception still applies.
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

vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));

function okReply(content = '{"ok":true}') {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () =>
      Promise.resolve({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { total_tokens: 7 },
      }),
  });
}

function errorReply(status: number, body: string) {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  };
}

const jsonTurn = () =>
  singleUserTurn({
    system: "system",
    user: "user",
    responseFormat: "json",
  });

beforeEach(() => {
  vi.restoreAllMocks();
  resetJsonModeDialectCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("OpenAI-compatible gateway — wire", () => {
  it("posts to the configured base URL and reports its own provider tag", async () => {
    const fetchMock = okReply();
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAIClient({
      apiKey: "gateway-secret",
      model: "anthropic/claude-sonnet-4-6",
      baseUrl: "https://litellm.example.com/v1",
      providerType: "openai-compatible",
    });
    const result = await client.generateCompletion(jsonTurn());

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://litellm.example.com/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer gateway-secret",
    );
    expect(result.providerType).toBe("openai-compatible");
    expect(result.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("sends no Authorization header at all when the gateway needs no bearer", async () => {
    const fetchMock = okReply();
    vi.stubGlobal("fetch", fetchMock);

    await new OpenAIClient({
      apiKey: "",
      model: "llama3.1:70b",
      baseUrl: "https://gateway.example.com/v1",
      providerType: "openai-compatible",
    }).generateCompletion(jsonTurn());

    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
      "Authorization",
    );
  });
});

describe("OpenAI-compatible gateway — host policy", () => {
  it("refuses a private host that the operator has not allowlisted", async () => {
    vi.stubGlobal("fetch", okReply());
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "");

    await expect(
      new OpenAIClient({
        apiKey: "",
        model: "m",
        baseUrl: "http://192.168.1.5:4000/v1",
        providerType: "openai-compatible",
      }).generateCompletion(jsonTurn()),
    ).rejects.toMatchObject({ kind: "private_host" });
  });

  // The alt-notation classes `isPublicUrl` exists to catch. A gateway is the
  // one AI surface whose host a user types, so every one of these has to be
  // refused through the gateway arm too — not only through the Local one.
  it.each([
    ["decimal IPv4", "http://2130706433/v1"],
    ["hex IPv4", "http://0x7f000001/v1"],
    ["octal IPv4", "http://0177.0.0.1/v1"],
    ["cloud metadata", "http://169.254.169.254/v1"],
    ["IPv4-mapped IPv6", "http://[::ffff:169.254.169.254]/v1"],
    ["IPv6 ULA", "http://[fd00::1]/v1"],
    ["loopback", "http://127.0.0.1:8080/v1"],
  ])("refuses %s", async (_label, baseUrl) => {
    vi.stubGlobal("fetch", okReply());
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "");

    await expect(
      new OpenAIClient({
        apiKey: "",
        model: "m",
        baseUrl,
        providerType: "openai-compatible",
      }).generateCompletion(jsonTurn()),
    ).rejects.toMatchObject({ kind: "private_host" });
  });

  it("reaches a private host the operator allowlisted by name", async () => {
    const fetchMock = okReply();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "litellm.lan");

    await new OpenAIClient({
      apiKey: "",
      model: "m",
      baseUrl: "http://litellm.lan:4000/v1",
      providerType: "openai-compatible",
    }).generateCompletion(jsonTurn());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // v1.37.30 — the admin-key tag joined the allowlist policy: its base URL
  // is operator-typed in exactly one place (the global provider in the admin
  // settings, e.g. pointed at a private OpenAI-compatible OAuth proxy), and
  // the allowlist is the operator's own grant. The floor is unchanged: a
  // private host WITHOUT an allowlist entry is refused, and the codex tag
  // stays hard-pinned because its base URL is a repository constant. Note
  // that every non-operator admin-key construction in the app pins the
  // public `api.openai.com` constant, so the personal-key posture cannot
  // reach this branch.
  it("admin-key consults the allowlist for an operator-typed private host", async () => {
    const fetchMock = okReply();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "openai-oauth-proxy");

    await new OpenAIClient({
      apiKey: "unused-behind-proxy",
      model: "gpt-4o",
      baseUrl: "http://openai-oauth-proxy:10531/v1",
    }).generateCompletion(jsonTurn());

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("admin-key still refuses a private host the operator did not allowlist", async () => {
    vi.stubGlobal("fetch", okReply());
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "");

    await expect(
      new OpenAIClient({
        apiKey: "sk-user-openai-key",
        model: "gpt-4o",
        baseUrl: "http://192.168.1.5:4000/v1",
      }).generateCompletion(jsonTurn()),
    ).rejects.toMatchObject({ kind: "private_host" });
  });

  it("codex stays pinned to public hosts even under a blanket allowlist", async () => {
    vi.stubGlobal("fetch", okReply());
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");

    await expect(
      new OpenAIClient({
        apiKey: "codex-access-token",
        model: "gpt-5.4",
        baseUrl: "http://192.168.1.5:4000/v1",
        providerType: "codex",
      }).generateCompletion(jsonTurn()),
    ).rejects.toMatchObject({ kind: "private_host" });
  });
});

describe("OpenAI-compatible gateway — JSON-mode dialect", () => {
  it("retries once without response_format when the gateway rejects the field", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorReply(400, '{"error":"Unknown parameter: response_format"}'),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { total_tokens: 3 },
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OpenAIClient({
      apiKey: "k",
      model: "m",
      baseUrl: "https://strict-gateway.example.com/v1",
      providerType: "openai-compatible",
    }).generateCompletion(jsonTurn());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toHaveProperty(
      "response_format",
    );
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty(
      "response_format",
    );
    expect(result.content).toBe('{"ok":true}');
  });

  it("remembers the no-flag dialect for that endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        errorReply(400, '{"error":"response_format is not supported"}'),
      )
      .mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "{}" } }],
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const client = new OpenAIClient({
      apiKey: "k",
      model: "m",
      baseUrl: "https://strict-gateway.example.com/v1",
      providerType: "openai-compatible",
    });
    await client.generateCompletion(jsonTurn());
    await client.generateCompletion(jsonTurn());

    // Three calls total: the rejected probe, its retry, and the second
    // generation — which must not probe again.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).not.toHaveProperty(
      "response_format",
    );
  });

  it("does not retry an unrelated 4xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(errorReply(404, '{"error":"model not found"}'));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenAIClient({
        apiKey: "k",
        model: "nope",
        baseUrl: "https://gateway.example.com/v1",
        providerType: "openai-compatible",
      }).generateCompletion(jsonTurn()),
    ).rejects.toMatchObject({ httpStatus: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never probes or retries on the pinned OpenAI endpoint", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        errorReply(400, '{"error":"Unknown parameter: response_format"}'),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new OpenAIClient({
        apiKey: "sk-key",
        model: "gpt-4o",
        baseUrl: "https://api.openai.com/v1",
      }).generateCompletion(jsonTurn()),
    ).rejects.toThrow("OpenAI request failed (400)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
