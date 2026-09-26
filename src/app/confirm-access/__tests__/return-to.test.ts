import { describe, expect, it } from "vitest";

import { confirmReturnTo } from "../return-to";

describe("confirmReturnTo", () => {
  it("returns to the connection consent it came from", () => {
    expect(
      confirmReturnTo("/api/mcp/oauth/authorize?client_id=a&state=b"),
    ).toBe("/api/mcp/oauth/authorize?client_id=a&state=b");
  });

  it.each([
    null,
    "",
    "/",
    "/settings",
    "https://evil.example/api/mcp/oauth/authorize?x=1",
    "//evil.example/api/mcp/oauth/authorize?x=1",
    "/api/mcp/oauth/authorize",
    "/api/mcp/oauth/authorize/../token?x=1",
  ])("goes nowhere for %s", (next) => {
    expect(confirmReturnTo(next)).toBeNull();
  });
});
