import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  mutationOptions: [] as Array<{ onSuccess?: () => void }>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      aboutMe: null,
      conditions: null,
      allergies: null,
      coachFocus: null,
      aiIncludedSections: ["ABOUT_ME"],
      updatedAt: "2026-07-28T12:00:00.000Z",
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
    getQueryData: vi.fn(),
  }),
  useMutation: (options: unknown) => {
    mocks.mutationOptions.push(options as { onSuccess?: () => void });
    return {
      mutate: vi.fn(),
      isPending: false,
    };
  },
}));
vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: vi.fn(),
  apiPut: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/outcome/outcome-toast", () => ({
  toastWrittenOutcome: vi.fn(),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { AiProfileInclusionManager } from "../ai-profile-inclusion-manager";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AiProfileInclusionManager />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.invalidateQueries.mockClear();
  mocks.mutationOptions.length = 0;
});

describe("AI profile inclusion persistence", () => {
  it("invalidates the centralized Insights advisor query after a successful save", () => {
    render();
    const onSuccess = mocks.mutationOptions[0]?.onSuccess;

    expect(onSuccess).toBeTypeOf("function");
    onSuccess!();

    expect(mocks.invalidateQueries).toHaveBeenCalledWith({
      queryKey: queryKeys.insightsAdvisor(),
    });
  });
});
