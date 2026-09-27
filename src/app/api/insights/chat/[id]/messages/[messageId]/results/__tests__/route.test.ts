import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type * as ApiHandlerModule from "@/lib/api-handler";

const { requireAuth, readMessageResults, resolveModuleMap } = vi.hoisted(
  () => ({
    requireAuth: vi.fn(),
    readMessageResults: vi.fn(),
    resolveModuleMap: vi.fn(),
  }),
);

vi.mock("@/lib/api-handler", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiHandlerModule>();
  return {
    ...actual,
    apiHandler: <T extends (...args: never[]) => unknown>(handler: T) =>
      handler,
    requireAuth,
  };
});
vi.mock("@/lib/logging/context", () => ({ annotate: vi.fn() }));
vi.mock("@/lib/modules/gate", () => ({ resolveModuleMap }));
vi.mock("@/lib/ai/coach/persistence", () => ({ readMessageResults }));

import { GET } from "../route";

const USER_ID = "user-1";

function call(id = "c1", messageId = "m1") {
  return GET(
    new NextRequest(
      `http://localhost/api/insights/chat/${id}/messages/${messageId}/results`,
    ),
    { params: Promise.resolve({ id, messageId }) },
  ) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuth.mockResolvedValue({ user: { id: USER_ID } });
  resolveModuleMap.mockResolvedValue({ sleep: false, mood: true });
});

describe("GET /api/insights/chat/[id]/messages/[messageId]/results", () => {
  it("reads under the caller's own id and the path ids only", async () => {
    readMessageResults.mockResolvedValue([]);
    const response = await call("c1", "m1");
    expect(response.status).toBe(200);
    expect(readMessageResults).toHaveBeenCalledWith(
      USER_ID,
      "c1",
      "m1",
      expect.any(Function),
    );
    expect(await response.json()).toEqual({
      data: { results: [] },
      error: null,
    });
  });

  it("answers 404 for a message the caller does not own", async () => {
    readMessageResults.mockResolvedValue(null);
    const response = await call();
    expect(response.status).toBe(404);
  });

  it("withholds a domain whose module is switched off, and only that one", async () => {
    readMessageResults.mockResolvedValue([]);
    await call();
    const withhold = readMessageResults.mock.calls[0][3] as (
      domain: string,
    ) => boolean;
    expect(withhold("sleep")).toBe(true);
    expect(withhold("mood")).toBe(false);
    // No module owns blood pressure or labs: never withheld.
    expect(withhold("bp")).toBe(false);
    expect(withhold("labs")).toBe(false);
  });

  it("refuses an unauthenticated caller before any read", async () => {
    requireAuth.mockRejectedValue(new Error("Not authenticated"));
    await expect(call()).rejects.toThrow("Not authenticated");
    expect(readMessageResults).not.toHaveBeenCalled();
  });
});
