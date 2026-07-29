import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { safeFetch, SafeFetchError } from "../safe-fetch";

describe("safeFetch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("defaults init.redirect to 'manual'", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await safeFetch("https://example.com");

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("manual");
  });

  it("flips to 'follow' when opts.followRedirects is true", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await safeFetch("https://example.com", {}, { followRedirects: true });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("follow");
  });

  it("preserves an explicit init.redirect override", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await safeFetch("https://example.com", { redirect: "error" });

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("error");
  });

  it("aborts on timeout (override to a tight window for the test)", async () => {
    // Use a real, very short timeout. `AbortSignal.timeout` is a platform
    // primitive that vi.useFakeTimers cannot reliably advance, so the
    // assertion runs against actual wall-clock — but 25 ms is short
    // enough that the suite stays fast.
    fetchSpy.mockImplementationOnce(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        }),
    );

    await expect(
      safeFetch("https://example.com", {}, { timeoutMs: 25 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("respects a caller-supplied signal via AbortSignal.any", async () => {
    const controller = new AbortController();
    fetchSpy.mockImplementationOnce(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(signal.reason);
          });
        }),
    );

    const pending = safeFetch("https://example.com", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(SafeFetchError);
    await expect(pending).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects a private host when requirePublicHost is true", async () => {
    await expect(
      safeFetch(
        "http://169.254.169.254/latest/meta-data/",
        {},
        { requirePublicHost: true },
      ),
    ).rejects.toMatchObject({
      kind: "private_host",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects an RFC1918 host when requirePublicHost is true", async () => {
    await expect(
      safeFetch("http://10.0.0.5/admin", {}, { requirePublicHost: true }),
    ).rejects.toMatchObject({
      kind: "private_host",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT use global fetch on the pinned (requirePublicHost) path", async () => {
    // The pinned path must go through undici's own `fetch` so the dispatcher
    // and the fetch engine share one undici version (the version-skew fix).
    // Global `fetch` must therefore be bypassed entirely. The end-to-end 200
    // against a real server is asserted in `safe-fetch-pinned.test.ts`.
    await expect(
      safeFetch(
        // 192.0.2.0/24 is TEST-NET-1 (public-classified, unroutable) so the
        // connect fails fast without touching global fetch.
        "https://192.0.2.1/api",
        { signal: AbortSignal.timeout(300) },
        { requirePublicHost: true },
      ),
    ).rejects.toBeInstanceOf(SafeFetchError);
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);

  it("rejects mutually exclusive public and private destination policies", async () => {
    await expect(
      safeFetch(
        "https://example.com/api",
        {},
        {
          requirePublicHost: true,
          operatorApprovedPrivateOrigin: "https://example.com",
        },
      ),
    ).rejects.toMatchObject({ kind: "private_host" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a target outside the exact operator-approved origin", async () => {
    await expect(
      safeFetch(
        "http://192.168.1.51:1337/api",
        {},
        {
          operatorApprovedPrivateOrigin: "http://192.168.1.50:1337",
        },
      ),
    ).rejects.toMatchObject({ kind: "private_host" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a path-shaped value masquerading as an origin grant", async () => {
    await expect(
      safeFetch(
        "http://192.168.1.50:1337/api",
        {},
        {
          operatorApprovedPrivateOrigin:
            "http://192.168.1.50:1337/api?from=request",
        },
      ),
    ).rejects.toMatchObject({ kind: "private_host" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("forbids redirects on an operator-approved private origin", async () => {
    await expect(
      safeFetch(
        "http://192.168.1.50:1337/api",
        { redirect: "follow" },
        {
          operatorApprovedPrivateOrigin: "http://192.168.1.50:1337",
        },
      ),
    ).rejects.toMatchObject({ kind: "private_host" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wraps a native network error as kind: 'network'", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("network down"));

    await expect(safeFetch("https://example.com")).rejects.toMatchObject({
      kind: "network",
    });
  });

  it("accepts a URL object as the target", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await safeFetch(new URL("https://example.com/path"));

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/path");
  });
});
