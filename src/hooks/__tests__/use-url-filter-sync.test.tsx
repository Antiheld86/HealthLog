/**
 * The shared URL-owned-filter hook (`use-url-filter-sync.ts`) — the
 * documents-vault pattern extracted for the measurements and mood lists.
 * Pinned here: mount parses the live query string, a filter change writes
 * the serialised form back through the router (push by default, replace on
 * request), an empty filter set restores the bare pathname, and
 * `syncToUrl: false` detaches the state from the URL entirely.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

let mockSearch = "";
const pushMock = vi.fn();
const replaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  usePathname: () => "/measurements",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

import { useUrlFilterSync } from "../use-url-filter-sync";

interface ProbeFilters {
  type?: string;
  source?: string;
}

function parse(params: URLSearchParams): ProbeFilters {
  const filters: ProbeFilters = {};
  const type = params.get("type");
  if (type) filters.type = type;
  const source = params.get("source");
  if (source) filters.source = source;
  return filters;
}

function serialise(filters: ProbeFilters): string {
  const sp = new URLSearchParams();
  if (filters.type) sp.set("type", filters.type);
  if (filters.source) sp.set("source", filters.source);
  return sp.toString();
}

interface ProbeResult {
  filters: ProbeFilters;
  applyFilters: (next: ProbeFilters, mode?: "push" | "replace") => void;
}

function mount(search: string, syncToUrl?: boolean): ProbeResult {
  mockSearch = search;
  // Ref-shaped capture cell: the render-scoped assignment happens inside a
  // closure the control-flow analysis cannot see through.
  const captured: { current: ProbeResult | null } = { current: null };
  function Probe() {
    captured.current = useUrlFilterSync<ProbeFilters>({
      parse,
      serialise,
      syncToUrl,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!captured.current) throw new Error("probe did not render");
  return captured.current;
}

beforeEach(() => {
  pushMock.mockClear();
  replaceMock.mockClear();
});

describe("useUrlFilterSync", () => {
  it("parses the mounted query string into the filter object", () => {
    const { filters } = mount("type=WEIGHT&source=WITHINGS");
    expect(filters).toEqual({ type: "WEIGHT", source: "WITHINGS" });
  });

  it("writes a filter change to the URL via push by default", () => {
    const { applyFilters } = mount("");
    applyFilters({ type: "WEIGHT" });
    expect(pushMock).toHaveBeenCalledWith("/measurements?type=WEIGHT", {
      scroll: false,
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("writes via replace when asked (high-frequency input)", () => {
    const { applyFilters } = mount("");
    applyFilters({ source: "MANUAL" }, "replace");
    expect(replaceMock).toHaveBeenCalledWith("/measurements?source=MANUAL", {
      scroll: false,
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("restores the bare pathname when every facet clears", () => {
    const { applyFilters } = mount("type=WEIGHT");
    applyFilters({});
    expect(pushMock).toHaveBeenCalledWith("/measurements", { scroll: false });
  });

  it("syncToUrl: false ignores the URL and never navigates", () => {
    const { filters, applyFilters } = mount("type=WEIGHT", false);
    expect(filters).toEqual({});
    applyFilters({ type: "PULSE" });
    expect(pushMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });
});
