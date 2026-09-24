import { describe, expect, it, vi } from "vitest";

import { eventStorage } from "@/lib/logging/context";
import { WideEventBuilder } from "@/lib/logging/event-builder";
import { memoizePerRequest } from "@/lib/request-cache";

function twice(kind: "http" | "background", fresh: boolean) {
  const factory = vi.fn(async () => Math.random());
  return eventStorage.run(new WideEventBuilder(kind), async () => {
    const options = fresh ? { freshInBackground: true } : {};
    await memoizePerRequest("k", factory, options);
    await memoizePerRequest("k", factory, options);
    return factory.mock.calls.length;
  });
}

describe("memoizePerRequest", () => {
  it("reads once per request", async () => {
    expect(await twice("http", false)).toBe(1);
    expect(await twice("http", true)).toBe(1);
  });

  it("reads once per background event unless the input must stay fresh", async () => {
    expect(await twice("background", false)).toBe(1);
    expect(await twice("background", true)).toBe(2);
  });
});
