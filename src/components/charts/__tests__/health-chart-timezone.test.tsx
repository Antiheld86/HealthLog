import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * A chart mount that passes no `userTimezone` must still cut days in the
 * signed-in user's zone. Several mounts (the medications page, the coach
 * chat, the recovery section) pass none, and the component used to fall
 * back to a fixed Europe/Berlin, so a user in Asia/Kolkata saw those charts
 * bucketed and labelled in Berlin days while every other chart used their
 * own. The zone now comes from the account, which the server resolves.
 */

let lastKey: unknown[] | undefined;

vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: (previous: unknown) => previous,
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    lastKey = queryKey;
    return { data: [], isLoading: false };
  },
  useQueryClient: () => ({
    cancelQueries: () => Promise.resolve(),
    getQueryData: () => undefined,
    setQueryData: () => undefined,
    invalidateQueries: () => Promise.resolve(),
  }),
  useMutation: () => ({ mutate: () => undefined, isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isAuthenticated: true,
    user: { id: "u1", timezone: "Asia/Kolkata" },
    isLoading: false,
  }),
}));

describe("<HealthChart> timezone", () => {
  it("uses the account's zone when the mount passes none", async () => {
    const { I18nProvider } = await import("@/lib/i18n/context");
    const { HealthChart } = await import("../health-chart");

    renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <HealthChart types={["ACTIVITY_STEPS"]} title="Steps" unit="" />
      </I18nProvider>,
    );

    expect(lastKey).toBeDefined();
    expect(lastKey).toContain("Asia/Kolkata");
    expect(lastKey).not.toContain("Europe/Berlin");
  });
});
