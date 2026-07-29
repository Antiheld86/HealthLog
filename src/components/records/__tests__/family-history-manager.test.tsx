import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: mocks.rows,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api/api-fetch", () => ({
  apiDelete: vi.fn(),
  apiGet: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/responsive-sheet", () => ({
  ResponsiveSheet: () => null,
}));
vi.mock("@/components/data-list", () => ({
  DeleteButton: (props: { title: string }) => (
    <button aria-label={props.title}>Delete</button>
  ),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { FamilyHistoryManager } from "../family-history-manager";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <FamilyHistoryManager />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.rows = [];
});

describe("<FamilyHistoryManager> action grammar", () => {
  it("shows exactly one first-entry action and no duplicate top add action when empty", () => {
    const html = render();

    expect(html.match(/Add your first entry/g)).toHaveLength(1);
    expect(html).not.toMatch(/>Add entry<\/button>/);
  });

  it("shows one normal top add action plus edit/delete controls when populated", () => {
    mocks.rows = [
      {
        id: "family-1",
        relationship: "MOTHER",
        condition: "Type 2 diabetes",
        ageAtOnset: 55,
        note: null,
        createdAt: "2026-07-28T10:00:00.000Z",
        updatedAt: "2026-07-28T10:00:00.000Z",
      },
    ];

    const html = render();

    expect(html.match(/>Add entry<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain("Add your first entry");
    expect(html).toContain('aria-label="Edit"');
    expect(html).toContain('aria-label="Delete this entry?"');
    expect(html).toContain("Type 2 diabetes");
    expect(html).toContain("Mother");
  });
});
