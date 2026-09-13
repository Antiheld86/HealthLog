import { describe, expect, it } from "vitest";

import {
  readUpstreamBody,
  secretsInHeaderValue,
  secretsInUrl,
  UPSTREAM_BODY_MAX_CHARS,
} from "@/lib/notifications/upstream-body";

function res(body: string, status = 400): Response {
  return new Response(body, { status });
}

const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);
const BELL = String.fromCodePoint(0x07);

describe("readUpstreamBody", () => {
  it("returns a short JSON error body as it arrived", async () => {
    const body =
      '{"error":"Bad Request","errorCode":400,"errorDescription":"priority must be an integer"}';
    await expect(readUpstreamBody(res(body), [])).resolves.toBe(body);
  });

  it("removes control and bidirectional characters and collapses whitespace", async () => {
    const body = `line one\r\n\tline two ${RIGHT_TO_LEFT_OVERRIDE}evil${ZERO_WIDTH_SPACE}${BELL}`;
    await expect(readUpstreamBody(res(body), [])).resolves.toBe(
      "line one line two evil",
    );
  });

  it("cuts a long body to the cap, marked with an ellipsis", async () => {
    const result = await readUpstreamBody(res("x".repeat(5000)), []);
    expect(Array.from(result ?? "")).toHaveLength(UPSTREAM_BODY_MAX_CHARS);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("reads at most a bounded prefix of an endless body", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("y".repeat(1024)));
      },
    });
    const result = await readUpstreamBody(
      new Response(stream, { status: 502 }),
      [],
    );
    expect(result?.startsWith("yyyy")).toBe(true);
    // 4 KB in 1 KB chunks: the body is abandoned after a few pulls.
    expect(pulled).toBeLessThan(10);
  });

  it("refuses a secret-shaped body", async () => {
    await expect(
      readUpstreamBody(res('{"error":"bad key sk-ant-api03-abcdefgh"}'), []),
    ).resolves.toBeUndefined();
  });

  it("refuses a body that echoes a configured secret", async () => {
    await expect(
      readUpstreamBody(res("token AbCdEf123 is not valid"), [
        undefined,
        "AbCdEf123",
      ]),
    ).resolves.toBeUndefined();
  });

  it("ignores a configured value too short to be a secret", async () => {
    await expect(
      readUpstreamBody(res("priority 5 rejected"), ["5"]),
    ).resolves.toBe("priority 5 rejected");
  });

  it("returns nothing for an empty or unreadable body", async () => {
    await expect(readUpstreamBody(res("   \n"), [])).resolves.toBeUndefined();
    await expect(
      readUpstreamBody({ ok: false, status: 400 } as Response, []),
    ).resolves.toBeUndefined();
    await expect(
      readUpstreamBody(
        {
          text: () => Promise.reject(new Error("aborted")),
        } as unknown as Response,
        [],
      ),
    ).resolves.toBeUndefined();
  });
});

describe("secret extraction", () => {
  it("finds query values and userinfo in a URL", () => {
    expect(
      secretsInUrl(
        "https://user:pa%20ss@gotify.example.com/message?token=Abc123",
      ),
    ).toEqual(expect.arrayContaining(["Abc123", "user", "pa%20ss", "pa ss"]));
    expect(secretsInUrl("not a url")).toEqual([]);
  });

  it("keeps the token of a scheme-prefixed header value", () => {
    expect(secretsInHeaderValue("Bearer tok123")).toEqual([
      "Bearer tok123",
      "tok123",
    ]);
    expect(secretsInHeaderValue("AppToken")).toEqual(["AppToken"]);
    expect(secretsInHeaderValue(undefined)).toEqual([]);
  });
});

describe("secret matching survives encoding and malformed parts (review L4)", () => {
  it("keeps the query token when the userinfo holds a malformed escape", () => {
    const found = secretsInUrl(
      "https://us%ZZer:pw@gotify.example.com/message?token=Abc12345",
    );
    expect(found).toContain("Abc12345");
    expect(found).toContain("us%ZZer");
  });

  it("keeps the other query values when one holds a malformed escape", () => {
    const found = secretsInUrl(
      "https://gotify.example.com/message?a=%ZZ&token=Abc12345",
    );
    expect(found).toContain("Abc12345");
    expect(found).toContain("%ZZ");
  });

  it("treats long path segments as secrets and short ones not", () => {
    const found = secretsInUrl(
      "https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrSt",
    );
    expect(found).toContain("123456789012345678");
    expect(found).toContain("AbCdEfGhIjKlMnOpQrSt");
    expect(found).not.toContain("webhooks");
    expect(found).not.toContain("api");
  });

  it("refuses a body echoing a path token", async () => {
    await expect(
      readUpstreamBody(
        res('{"message":"Unknown Webhook AbCdEfGhIjKlMnOpQrSt"}', 404),
        secretsInUrl(
          "https://discord.com/api/webhooks/123/AbCdEfGhIjKlMnOpQrSt",
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it("refuses a JSON-escaped echo with an escaped slash", async () => {
    await expect(
      readUpstreamBody(res('{"auth":"Basic dXNlcj\\/wYXNz"}'), [
        "dXNlcj/wYXNz",
      ]),
    ).resolves.toBeUndefined();
  });

  it("refuses a JSON-escaped echo with an escaped quote", async () => {
    await expect(
      readUpstreamBody(res('{"got":"ab\\"cd1234"}'), ['ab"cd1234']),
    ).resolves.toBeUndefined();
  });

  it("refuses a percent-encoded echo, in either hex case", async () => {
    await expect(
      readUpstreamBody(res("bad token p%40ss%20word!"), ["p@ss word!"]),
    ).resolves.toBeUndefined();
    await expect(
      readUpstreamBody(res("bad token a%2fb%2Bc1234"), ["a/b+c1234"]),
    ).resolves.toBeUndefined();
  });
});
