/**
 * URL-owned filter state on the measurements management list (the
 * documents-vault pattern via `useUrlFilterSync`). Two directions, both
 * pinned:
 *
 *   - a filter change writes the serialised facet set to the page URL
 *     (push for the discrete selects, replace for the committed date
 *     bounds, bare pathname when everything clears);
 *   - mounting with a query string restores every facet — into the filter
 *     rail's controls AND into the list's TanStack query key, so the
 *     restored view refetches exactly what the shared link showed.
 *
 * SSR-only per project convention: the rail primitives are stubbed with
 * prop-capturing markers, and the captured callbacks stand in for the
 * user's click (post-render setState is a no-op under the server renderer;
 * the router spies record the navigation the click causes).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const baseMeasurements = [
  {
    id: "m-1",
    type: "WEIGHT",
    value: 81.5,
    unit: "kg",
    source: "MANUAL",
    measuredAt: "2026-05-09T08:30:00.000Z",
    notes: null,
  },
];

let mockSearch = "";
const pushMock = vi.fn();
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/measurements",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const recordedQueryKeys: unknown[] = [];
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown }) => {
    recordedQueryKeys.push(options.queryKey);
    return {
      data: { measurements: baseMeasurements, meta: { total: 1 } },
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
// date range, type, source, value range).
interface SelectProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
}
interface RangeProps {
  from?: string;
  to?: string;
  min?: string;
  max?: string;
  onFromChange?: (value: string) => void;
  onToChange?: (value: string) => void;
  onMinChange?: (value: string) => void;
  onMaxChange?: (value: string) => void;
}
let selects: SelectProps[] = [];
let barProps: { isFiltered: boolean; onReset: () => void } | null = null;
let dateRange: RangeProps | null = null;
let valueRange: RangeProps | null = null;
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
  FilterBarNumberRange: (props: RangeProps) => {
    valueRange = props;
    return <span data-slot="filter-bar-pill" />;
  },
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { MeasurementList } from "../measurement-list";

function render(search: string) {
  mockSearch = search;
  selects = [];
  barProps = null;
  dateRange = null;
  valueRange = null;
  recordedQueryKeys.length = 0;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MeasurementList />
    </I18nProvider>,
  );
}

const typeSelect = () => selects[0]!;
const sourceSelect = () => selects[1]!;

beforeEach(() => {
  pushMock.mockClear();
  replaceMock.mockClear();
});

describe("MeasurementList — filter changes write the URL", () => {
  it("pushes the type facet", () => {
    render("");
    typeSelect().onValueChange("WEIGHT");
    expect(pushMock).toHaveBeenCalledWith("/measurements?type=WEIGHT", {
      scroll: false,
    });
  });

  it("pushes the source facet on top of the active type", () => {
    render("type=WEIGHT");
    sourceSelect().onValueChange("WITHINGS");
    expect(pushMock).toHaveBeenCalledWith(
      "/measurements?type=WEIGHT&source=WITHINGS",
      { scroll: false },
    );
  });

  it("replaces (no history entry) for a committed date bound", () => {
    render("");
    dateRange!.onFromChange!("2026-05-01");
    expect(replaceMock).toHaveBeenCalledWith("/measurements?from=2026-05-01", {
      scroll: false,
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("clearing the last facet restores the bare pathname", () => {
    render("type=WEIGHT");
    typeSelect().onValueChange("ALL");
    expect(pushMock).toHaveBeenCalledWith("/measurements", { scroll: false });
  });

  it("reset clears every facet in one push", () => {
    render("type=WEIGHT&source=WITHINGS&from=2026-05-01&min=60");
    expect(barProps!.isFiltered).toBe(true);
    barProps!.onReset();
    expect(pushMock).toHaveBeenCalledWith("/measurements", { scroll: false });
  });
});

describe("MeasurementList — mounting with a query string restores the filters", () => {
  it("seeds every rail control from the URL", () => {
    render(
      "type=WEIGHT&source=WITHINGS&from=2026-05-01&to=2026-05-31&min=60&max=90",
    );
    expect(typeSelect().value).toBe("WEIGHT");
    expect(sourceSelect().value).toBe("WITHINGS");
    expect(dateRange!.from).toBe("2026-05-01");
    expect(dateRange!.to).toBe("2026-05-31");
    expect(valueRange!.min).toBe("60");
    expect(valueRange!.max).toBe("90");
    expect(barProps!.isFiltered).toBe(true);
  });

  it("keys the list query off the restored facets (TZ-pinned day bounds)", () => {
    render(
      "type=WEIGHT&source=WITHINGS&from=2026-05-01&to=2026-05-31&min=60&max=90",
    );
    // Suite TZ is pinned to UTC, so the local day bounds are deterministic.
    expect(recordedQueryKeys).toContainEqual(
      queryKeys.measurementsList({
        type: "WEIGHT",
        sourceEq: "WITHINGS",
        from: "2026-05-01T00:00:00.000Z",
        to: "2026-05-31T23:59:59.999Z",
        valueMin: 60,
        valueMax: 90,
        page: 1,
        sortBy: "measuredAt",
        sortDir: "desc",
        mode: "raw",
      }),
    );
  });

  it("drops an invalid facet instead of breaking the page", () => {
    render("type=NOT_A_TYPE&source=WITHINGS");
    expect(typeSelect().value).toBe("ALL");
    expect(sourceSelect().value).toBe("WITHINGS");
  });
});
