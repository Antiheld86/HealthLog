/**
 * URL-owned filter state on the mood management list (the documents-vault
 * pattern via `useUrlFilterSync`), mirroring the measurements-list guard:
 * a filter change writes the serialised facet set to the page URL, and
 * mounting with a query string restores every facet into the rail's
 * controls and the list's TanStack query key.
 *
 * SSR-only per project convention: the rail primitives are stubbed with
 * prop-capturing markers, and the captured callbacks stand in for the
 * user's click (post-render setState is a no-op under the server renderer;
 * the router spies record the navigation the click causes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const baseEntries = [
  {
    id: "e-1",
    date: "2026-05-09",
    mood: "GUT",
    score: 4,
    tags: [],
    tagKeys: [],
    note: null,
    source: "MANUAL",
    moodLoggedAt: "2026-05-09T20:00:00.000Z",
  },
];

let mockSearch = "";
const pushMock = vi.fn();
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/mood",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const recordedQueryKeys: unknown[] = [];
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown }) => {
    recordedQueryKeys.push(options.queryKey);
    return {
      data: { entries: baseEntries, meta: { total: 1 } },
      isLoading: false,
    };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "testuser", role: "USER" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

// Prop-capturing stubs for the rail primitives (render order in the list:
// date range, mood, source).
interface SelectProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
}
interface RangeProps {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}
let selects: SelectProps[] = [];
let barProps: { isFiltered: boolean; onReset: () => void } | null = null;
let dateRange: RangeProps | null = null;
vi.mock("@/components/ui/filter-bar", () => ({
  FilterBar: (props: {
    isFiltered: boolean;
    onReset: () => void;
    children?: unknown;
  }) => {
    barProps = { isFiltered: props.isFiltered, onReset: props.onReset };
    return <div data-slot="filter-bar">{props.children as never}</div>;
  },
  FilterBarSelect: (props: SelectProps) => {
    selects.push(props);
    return <span data-slot="filter-bar-pill" />;
  },
  FilterBarDateRange: (props: RangeProps) => {
    dateRange = props;
    return <span data-slot="filter-bar-pill" />;
  },
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { MoodList } from "../mood-list";

function render(search: string) {
  mockSearch = search;
  selects = [];
  barProps = null;
  dateRange = null;
  recordedQueryKeys.length = 0;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MoodList />
    </I18nProvider>,
  );
}

const moodSelect = () => selects[0]!;
const sourceSelect = () => selects[1]!;

beforeEach(() => {
  pushMock.mockClear();
  replaceMock.mockClear();
});

describe("MoodList — filter changes write the URL", () => {
  it("pushes the mood facet", () => {
    render("");
    moodSelect().onValueChange("GUT");
    expect(pushMock).toHaveBeenCalledWith("/mood?mood=GUT", { scroll: false });
  });

  it("pushes the source facet on top of the active mood", () => {
    render("mood=GUT");
    sourceSelect().onValueChange("TELEGRAM");
    expect(pushMock).toHaveBeenCalledWith("/mood?mood=GUT&source=TELEGRAM", {
      scroll: false,
    });
  });

  it("replaces (no history entry) for a committed date bound", () => {
    render("");
    dateRange!.onToChange("2026-05-31");
    expect(replaceMock).toHaveBeenCalledWith("/mood?to=2026-05-31", {
      scroll: false,
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("clearing the last facet restores the bare pathname", () => {
    render("mood=GUT");
    moodSelect().onValueChange("ALL");
    expect(pushMock).toHaveBeenCalledWith("/mood", { scroll: false });
  });

  it("reset clears every facet in one push", () => {
    render("mood=GUT&source=TELEGRAM&from=2026-05-01");
    expect(barProps!.isFiltered).toBe(true);
    barProps!.onReset();
    expect(pushMock).toHaveBeenCalledWith("/mood", { scroll: false });
  });
});

describe("MoodList — mounting with a query string restores the filters", () => {
  it("seeds every rail control from the URL", () => {
    render("mood=OKAY&source=MOODLOG&from=2026-05-01&to=2026-05-31");
    expect(moodSelect().value).toBe("OKAY");
    expect(sourceSelect().value).toBe("MOODLOG");
    expect(dateRange!.from).toBe("2026-05-01");
    expect(dateRange!.to).toBe("2026-05-31");
    expect(barProps!.isFiltered).toBe(true);
  });

  it("keys the list query off the restored facets", () => {
    render("mood=OKAY&source=MOODLOG&from=2026-05-01&to=2026-05-31");
    expect(recordedQueryKeys).toContainEqual(
      queryKeys.moodEntriesList({
        mood: "OKAY",
        source: "MOODLOG",
        from: "2026-05-01",
        to: "2026-05-31",
        page: 1,
        sortBy: "moodLoggedAt",
        sortDir: "desc",
      }),
    );
  });

  it("drops an invalid facet instead of breaking the page", () => {
    render("mood=ECSTATIC&source=WEB");
    expect(moodSelect().value).toBe("ALL");
    expect(sourceSelect().value).toBe("WEB");
  });
});
