import { afterEach, describe, expect, it, vi } from "vitest";
import { HydrationBoundary, hashKey } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { queryKeys } from "@/lib/query-keys";
import { MOOD_LIST_PAGE_SIZE } from "@/lib/mood/list-page-size";

/**
 * The `/mood` server-prefetch key crux + fail-soft.
 *
 * The RSC wrapper (`src/app/mood/page.tsx`) dehydrates the mood list's FIRST
 * page under the parameterised `queryKeys.moodEntriesList(…)` tuple the
 * client list mounts with (no filters, page 1, `moodLoggedAt desc`), via the
 * shared `listMoodEntriesPage` read. These tests pin the seeded key
 * (byte-identical hash), the first-mount parameters (`MOOD_LIST_PAGE_SIZE`,
 * offset 0), the module-gate parity, and the fail-soft paths.
 */

const getUnswitchedSession = vi.fn();
const listMoodEntriesPage = vi.fn();
const resolveModuleMap = vi.fn();

vi.mock("@/lib/auth/acting-carrier", () => ({
  getUnswitchedSession: () => getUnswitchedSession(),
}));
vi.mock("@/lib/mood/list-read", () => ({
  listMoodEntriesPage: (userId: string, params: unknown) =>
    listMoodEntriesPage(userId, params),
}));
vi.mock("@/lib/modules/gate", () => ({
  resolveModuleMap: (userId: string) => resolveModuleMap(userId),
}));
vi.mock("../page-client", () => ({ default: () => null }));

import MoodPage from "../page";

const SESSION = { user: { id: "u1", timezone: "Europe/Berlin" } };

/** The client list's first-mount key (no filters, page 1, default sort). */
const FIRST_MOUNT_KEY = queryKeys.moodEntriesList({
  mood: undefined,
  source: undefined,
  from: undefined,
  to: undefined,
  page: 1,
  sortBy: "moodLoggedAt",
  sortDir: "desc",
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.DASHBOARD_SSR_PREFETCH;
});

function queriesOf(
  el: ReactElement,
): { queryHash: string; state: { data: unknown } }[] {
  if (el.type !== HydrationBoundary) return [];
  const props = el.props as {
    state?: { queries: { queryHash: string; state: { data: unknown } }[] };
  };
  return props.state?.queries ?? [];
}

describe("/mood RSC prefetch", () => {
  it("dehydrates the first list page under the client's first-mount key", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({});
    listMoodEntriesPage.mockResolvedValue({
      entries: [],
      meta: { total: 0, limit: MOOD_LIST_PAGE_SIZE, offset: 0 },
    });

    const el = (await MoodPage()) as ReactElement;
    const hashes = queriesOf(el).map((q) => q.queryHash);
    expect(hashes).toContain(hashKey(FIRST_MOUNT_KEY));
    // The read runs with the client's first-mount slice parameters.
    expect(listMoodEntriesPage).toHaveBeenCalledWith("u1", {
      limit: MOOD_LIST_PAGE_SIZE,
      offset: 0,
      sortBy: "moodLoggedAt",
      sortDir: "desc",
    });
  });

  it("JSON-round-trips the page body to the wire shape", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({});
    const loggedAt = new Date("2026-07-18T06:00:00.000Z");
    listMoodEntriesPage.mockResolvedValue({
      entries: [{ id: "m1", moodLoggedAt: loggedAt }],
      meta: { total: 1, limit: MOOD_LIST_PAGE_SIZE, offset: 0 },
    });

    const el = (await MoodPage()) as ReactElement;
    const seeded = queriesOf(el).find(
      (q) => q.queryHash === hashKey(FIRST_MOUNT_KEY),
    );
    const data = seeded!.state.data as {
      entries: { moodLoggedAt: unknown }[];
    };
    expect(data.entries[0]!.moodLoggedAt).toBe(loggedAt.toISOString());
  });

  it("skips the prefetch when the mood module is explicitly off", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({ mood: false });
    const el = (await MoodPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(listMoodEntriesPage).not.toHaveBeenCalled();
  });

  it("fails soft to the bare client when the read throws", async () => {
    getUnswitchedSession.mockResolvedValue(SESSION);
    resolveModuleMap.mockResolvedValue({});
    listMoodEntriesPage.mockRejectedValue(new Error("db blip"));

    const el = (await MoodPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
  });

  // Null also means "acting on somebody else's record" — `getUnswitchedSession`
  // collapses both into the same answer, and the page treats them the same.
  it("fails soft when there is no session", async () => {
    getUnswitchedSession.mockResolvedValue(null);
    const el = (await MoodPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(listMoodEntriesPage).not.toHaveBeenCalled();
  });

  it("honours the DASHBOARD_SSR_PREFETCH kill-switch", async () => {
    process.env.DASHBOARD_SSR_PREFETCH = "false";
    const el = (await MoodPage()) as ReactElement;
    expect(el.type).not.toBe(HydrationBoundary);
    expect(getUnswitchedSession).not.toHaveBeenCalled();
  });
});
