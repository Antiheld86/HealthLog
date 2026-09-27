import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The client's destination policy has its own suite
// (`local-host-allowlist.test.ts`, `local-client-egress.test.ts`). Here the
// grant is stubbed to "no policy" so the request shape can be asserted
// against the stubbed global fetch; the pinned dispatchers drive undici's own
// fetch, which a global stub cannot see.
vi.mock("../local-host-allowlist", () => ({ aiEgressPolicyFor: () => ({}) }));
import {
  LocalOpenAICompatibleClient,
  resetLocalJsonDialectCache,
} from "../local-client";
import { singleUserTurn } from "../types";

describe("LocalOpenAICompatibleClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // v1.28.28 (#470) — the JSON dialect is cached per baseUrl for the
    // process; clear it so each test starts from the default dialect.
    resetLocalJsonDialectCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("targets the configured baseUrl + /chat/completions", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"local"}' } }],
          usage: { total_tokens: 17 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "system", user: "user-input" }),
    );

    expect(result.content).toBe('{"summary":"local"}');
    expect(result.tokensUsed).toBe(17);
    expect(result.model).toBe("llama3:8b");
    expect(result.providerType).toBe("local");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");

    const body = JSON.parse(init.body);
    expect(body.model).toBe("llama3:8b");
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toEqual({ role: "system", content: "system" });
    // User message should be prefixed with the strict-JSON instruction.
    expect(body.messages[1].role).toBe("user");
    expect(body.messages[1].content).toContain("user-input");
    expect(body.messages[1].content.toLowerCase()).toContain("json");

    // No JSON opt-in → neither the standard flag nor the legacy Ollama one.
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("format");
  });

  // v1.28.28 (#470) — the JSON opt-in sends the STANDARD OpenAI field so
  // strict OpenAI-compatible gateways (LiteLLM / OpenRouter / vLLM) accept
  // the request. The Ollama-native top-level `format` field is gone from
  // the wire entirely.
  it("sends standard `response_format` (and never `format`) when the caller opts into JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: '{"summary":"x"}' } }],
          usage: { total_tokens: 3 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });

    await client.generateCompletion(
      singleUserTurn({
        system: "s",
        user: "u",
        responseFormat: "json",
        seed: 99,
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body).not.toHaveProperty("format");
    expect(body.seed).toBe(99);
  });

  it("self-heals a response_format rejection: one retry without the flag + cached dialect", async () => {
    const okReply = {
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [
            { message: { content: '{"summary":"x"}' }, finish_reason: "stop" },
          ],
          usage: { total_tokens: 3 },
        }),
    };
    const mockFetch = vi
      .fn()
      // 1st: strict gateway 400s on the unknown field.
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            '{"error":{"message":"litellm.BadRequestError: response_format is not supported by this endpoint"}}',
          ),
      })
      // 2nd (the healed retry) + 3rd (a fresh call) succeed.
      .mockResolvedValue(okReply);
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });
    const params = singleUserTurn({
      system: "s",
      user: "u",
      responseFormat: "json",
    });

    const result = await client.generateCompletion(params);
    expect(result.content).toBe('{"summary":"x"}');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First attempt carried the standard flag; the healed retry dropped it
    // (and did NOT resurrect the legacy Ollama `format` field).
    const first = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(first.response_format).toEqual({ type: "json_object" });
    const retry = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(retry).not.toHaveProperty("response_format");
    expect(retry).not.toHaveProperty("format");

    // The dialect is cached per baseUrl: the next call goes straight to the
    // no-flag wire with no extra probe.
    await client.generateCompletion(params);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const third = JSON.parse(mockFetch.mock.calls[2][1].body);
    expect(third).not.toHaveProperty("response_format");
  });

  it("does NOT retry an unrelated 4xx (surfaces the structured error once)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: () =>
        Promise.resolve('{"error":{"message":"model llama9 does not exist"}}'),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama9",
      baseUrl: "http://localhost:11434/v1",
    });

    await expect(
      client.generateCompletion(
        singleUserTurn({ system: "s", user: "u", responseFormat: "json" }),
      ),
    ).rejects.toThrow("Local AI request failed (400)");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("surfaces finish_reason 'length' as finishReason on the buffered path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: { content: '{"summary":"cut off mid' },
                finish_reason: "length",
              },
            ],
            usage: { total_tokens: 1500 },
          }),
      }),
    );

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    const result = await client.generateCompletion(
      singleUserTurn({ system: "s", user: "u", responseFormat: "json" }),
    );
    expect(result.finishReason).toBe("length");
  });

  it("omits Authorization header when no API key is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}" } }],
          usage: { total_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: "",
      model: "phi3",
      baseUrl: "http://localhost:11434/v1",
    });

    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    const init = mockFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("sends Bearer Authorization when an API key is provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}" } }],
          usage: { total_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: "lm-studio-secret",
      model: "phi3",
      baseUrl: "http://192.168.1.20:1234/v1",
    });

    await client.generateCompletion(singleUserTurn({ system: "s", user: "u" }));

    const init = mockFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer lm-studio-secret");
  });

  it("captures structured error fields and redacts bearer tokens on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () =>
          Promise.resolve(
            "upstream rejected: Bearer sk-localabcdef12345 hit /v1",
          ),
      }),
    );

    const client = new LocalOpenAICompatibleClient({
      apiKey: "sk-local-test",
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    let caught: unknown;
    try {
      await client.generateCompletion(
        singleUserTurn({ system: "s", user: "u" }),
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      httpStatus?: number;
      upstream?: string;
      bodyExcerpt?: string;
      baseUrl?: string;
    };
    expect(err.message).toBe("Local AI request failed (500)");
    expect(err.httpStatus).toBe(500);
    expect(err.upstream).toBe("local");
    expect(err.baseUrl).toBe("http://localhost:11434/v1");
    expect(err.bodyExcerpt).toContain("Bearer ***redacted***");
    expect(err.bodyExcerpt).not.toContain("sk-localabcdef12345");
  });

  it("throws when content is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ choices: [{ message: { content: "" } }] }),
      }),
    );

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    await expect(
      client.generateCompletion(singleUserTurn({ system: "s", user: "u" })),
    ).rejects.toThrow("Local AI returned empty content");
  });

  // ── v1.22 (#89) — true token streaming ──────────────────────────
  function sseStreamResponse(chunks: string[]) {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      headers: {
        get: (k: string) => (k === "content-type" ? "text/event-stream" : null),
      },
      body,
    };
  }

  it("streams token deltas over stream:true and assembles the full reply", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValue(
        sseStreamResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
          'data: {"choices":[{"delta":{}}],"usage":{"total_tokens":42}}\n\n',
          "data: [DONE]\n\n",
        ]),
      );
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3:8b",
      baseUrl: "http://localhost:11434/v1",
    });

    const deltas: string[] = [];
    const result = await client.generateCompletionStream(
      singleUserTurn({ system: "s", user: "u" }),
      (d) => deltas.push(d),
    );

    expect(deltas).toEqual(["Hel", "lo", " world"]);
    expect(result.content).toBe("Hello world");
    expect(result.tokensUsed).toBe(42);
    expect(result.providerType).toBe("local");

    // The request opted into streaming.
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it("falls back to the buffered body when the server ignores stream:true", async () => {
    // 200 OK but a normal JSON completion (not event-stream).
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      body: null,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "buffered reply" } }],
          usage: { total_tokens: 7 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    const deltas: string[] = [];
    const result = await client.generateCompletionStream(
      singleUserTurn({ system: "s", user: "u" }),
      (d) => deltas.push(d),
    );

    expect(result.content).toBe("buffered reply");
    expect(result.tokensUsed).toBe(7);
    // The whole buffered body is emitted as one delta.
    expect(deltas).toEqual(["buffered reply"]);
  });

  it("falls back to non-streaming generateCompletion when streaming is rejected", async () => {
    const mockFetch = vi
      .fn()
      // 1st call: the streaming attempt is rejected (server 400s on stream).
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        headers: { get: () => "application/json" },
        text: () => Promise.resolve("stream not supported"),
      })
      // 2nd call: the buffered retry succeeds.
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "non-stream reply" } }],
            usage: { total_tokens: 5 },
          }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });

    const result = await client.generateCompletionStream(
      singleUserTurn({ system: "s", user: "u" }),
      () => {},
    );

    expect(result.content).toBe("non-stream reply");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // The retry was the buffered (non-streaming) request shape.
    const retryBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(retryBody).not.toHaveProperty("stream");
  });

  it("degrades tools silently — never forwards a `tools` field", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: "{}" } }],
          usage: { total_tokens: 1 },
        }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const client = new LocalOpenAICompatibleClient({
      apiKey: null,
      model: "llama3",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(client.supportsTools).toBe(false);

    await client.generateCompletion(
      singleUserTurn({
        system: "s",
        user: "u",
        tools: [{ name: "t", description: "d", parameters: {} }],
        toolChoice: "auto",
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });
});
