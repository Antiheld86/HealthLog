import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api-handler", () => ({
  apiHandler: <T extends (...args: unknown[]) => unknown>(fn: T) => fn,
  requireAuth: vi.fn().mockResolvedValue({ user: { id: "u1" } }),
}));

const safeFetchMock = vi.fn();
vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetchMock(...args),
}));

import { GET } from "../route";

const call = () => (GET as unknown as () => Promise<Response>)();

afterEach(() => {
  vi.unstubAllEnvs();
  safeFetchMock.mockReset();
});

describe("GET /api/version/check-updates", () => {
  it.each(["1", "true", "yes"])(
    "makes no outbound request when UPDATE_CHECK_DISABLED=%s",
    async (value) => {
      vi.stubEnv("UPDATE_CHECK_DISABLED", value);
      const body = (await (await call()).json()) as {
        data: { status: string; reason: string };
      };
      expect(body.data.status).toBe("unknown");
      expect(body.data.reason).toBe("disabled");
      expect(safeFetchMock).not.toHaveBeenCalled();
    },
  );

  it("asks the release feed when the switch is unset or empty", async () => {
    vi.stubEnv("UPDATE_CHECK_DISABLED", "");
    safeFetchMock.mockResolvedValue(
      Response.json({ tag_name: "v999.0.0", html_url: "https://x.test" }),
    );
    const body = (await (await call()).json()) as {
      data: { status: string };
    };
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    expect(body.data.status).toBe("newer_available");
  });
});
