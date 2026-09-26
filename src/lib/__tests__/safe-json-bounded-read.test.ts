/**
 * `safeJson`'s `maxBytes` bounds the READ, not just the parse.
 *
 * It used to call `request.text()` and compare afterwards, so the whole body
 * was held before the cap was consulted. That was tolerable while the proxy
 * truncated every body at a fixed ceiling; the large-upload routes no longer
 * pass through the proxy, so the cap has to hold on its own — including for a
 * body that declares no length.
 */
import { describe, expect, it } from "vitest";

import { readBodyText, safeJson } from "@/lib/api-response";

/** An endless body of 1 KB chunks that counts how many were pulled. */
function endless(): {
  stream: ReadableStream<Uint8Array>;
  pulled: () => number;
} {
  let pulls = 0;
  const chunk = new TextEncoder().encode("x".repeat(1024));
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
    },
  });
  return { stream, pulled: () => pulls };
}

function jsonRequest(
  body: BodyInit,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://localhost/api/x", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
    // Required by undici for a stream body.
    duplex: "half",
  } as RequestInit);
}

describe("bounded body read", () => {
  it("stops a body without a declared length at the cap", async () => {
    const { stream, pulled } = endless();
    const res = await safeJson(jsonRequest(stream), { maxBytes: 16 * 1024 });
    expect(res.error?.status).toBe(413);
    expect(pulled()).toBeLessThan(40);
  });

  it("refuses a declared oversize body before reading any of it", async () => {
    const { stream, pulled } = endless();
    const read = await readBodyText(
      jsonRequest(stream, { "content-length": String(50 * 1024 * 1024) }),
      1024 * 1024,
    );
    expect(read.tooLarge).toBe(true);
    // A pull may be scheduled when the stream is constructed; none after.
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("parses a body under the cap, multibyte text intact", async () => {
    const res = await safeJson<{ note: string }>(
      jsonRequest(JSON.stringify({ note: "Blutdruck gemessen – ok" })),
      { maxBytes: 1024 },
    );
    expect(res.data).toEqual({ note: "Blutdruck gemessen – ok" });
  });

  it("counts bytes, not characters", async () => {
    // 600 three-byte characters: 600 chars, 1800 bytes.
    const body = JSON.stringify({ s: "€".repeat(600) });
    const res = await safeJson(jsonRequest(body), { maxBytes: 1024 });
    expect(res.error?.status).toBe(413);
  });
});
