/**
 * Issue #1028 — the Verlauf ledger's trailing window must be resolved when
 * the request fires, not when the tab mounts.
 *
 * The ledger used to pin `from` and `to` in state at mount and reuse them for
 * every fetch. A refetch after adding a dose therefore asked for rows up to
 * the moment the tab opened, and a dose recorded afterwards stayed out of
 * "Last 90 days" until a reload, while the unwindowed full history showed it.
 *
 * The test captures the query function the ledger hands to TanStack Query and
 * runs it twice at two different clock readings: both requests must reach the
 * present, which means no pinned `to` and a `from` that moves with the clock.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const captured: { queryFn?: () => Promise<unknown>; queryKey?: unknown } = {};

vi.mock("@tanstack/react-query", async (orig) => {
  const actual = await orig<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: (opts: {
      queryFn: () => Promise<unknown>;
      queryKey: unknown;
    }) => {
      captured.queryFn = opts.queryFn;
      captured.queryKey = opts.queryKey;
      return { data: undefined, isLoading: true, isError: false };
    },
    useQueryClient: () => ({}),
  };
});

vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn().mockResolvedValue({ rows: [] }),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiDelete: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "t", role: "USER", timezone: "Asia/Kolkata" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/use-record-capabilities", () => ({
  useRecordCapabilities: () => ({ canWriteDomain: () => true }),
  useActiveRecordName: () => null,
}));

import { I18nProvider } from "@/lib/i18n/context";
import { DoseHistoryLedger } from "@/components/medications/dose-history-ledger";
import { apiGet } from "@/lib/api/api-fetch";

afterEach(() => {
  vi.useRealTimers();
});

describe("DoseHistoryLedger request window (#1028)", () => {
  it("resolves the window at fetch time so a later refetch reaches the present", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const mountedAt = new Date("2026-09-22T10:00:00Z");
    vi.setSystemTime(mountedAt);

    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <DoseHistoryLedger
          medicationId="med-1"
          medicationName="Test"
          schedules={[]}
        />
      </I18nProvider>,
    );
    expect(captured.queryFn).toBeTypeOf("function");

    await captured.queryFn!();
    // An hour later the user adds a dose; the invalidation refetches.
    const later = new Date(mountedAt.getTime() + 3_600_000);
    vi.setSystemTime(later);
    await captured.queryFn!();

    const urls = vi.mocked(apiGet).mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const params = new URL(url, "http://x").searchParams;
      // No pinned upper bound: the server's `to` is its own now.
      expect(params.get("to")).toBeNull();
    }
    const secondFrom = new URL(urls[1], "http://x").searchParams.get("from");
    expect(secondFrom).toBe(
      new Date(later.getTime() - 90 * 86_400_000).toISOString(),
    );
    // The cache key carries no instant, so it stays stable across renders.
    expect(captured.queryKey).toEqual([
      "medications",
      "med-1",
      "dose-history",
      90,
    ]);
  });
});
