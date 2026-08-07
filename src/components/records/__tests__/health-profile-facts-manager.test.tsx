import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { HealthProfileFactsManager } from "../health-profile-facts-manager";

const {
  MockApiError,
  apiDelete,
  apiPatch,
  confirmButtons,
  renderedButtons,
  removedAt,
} = vi.hoisted(() => {
  const removedAt = "2026-07-28T12:00:00.000Z";
  class MockApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    MockApiError,
    apiDelete: vi.fn(async () => ({
      id: "fact-1",
      kind: "SMOKING_STATUS" as const,
      removedAt,
    })),
    apiPatch: vi.fn(),
    confirmButtons: [] as Record<string, unknown>[],
    renderedButtons: [] as Record<string, unknown>[],
    removedAt,
  };
});

vi.mock("@/lib/api/api-fetch", () => ({
  ApiError: MockApiError,
  apiDelete,
  apiGet: vi.fn(),
  apiPatch,
  apiPost: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("@/components/outcome/outcome-toast", () => ({
  toastWrittenOutcome: vi.fn(),
}));
vi.mock("@/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    renderedButtons.push(props);
    return <button />;
  },
}));

vi.mock("@/components/ui/confirm-button", () => ({
  ConfirmButton: (props: Record<string, unknown>) => {
    confirmButtons.push(props);
    return (
      <button data-slot={String(props.slot)}>{String(props.label)}</button>
    );
  },
  ConfirmDialog: () => null,
}));

const fact = {
  id: "fact-1",
  kind: "SMOKING_STATUS" as const,
  value: "FORMER" as const,
  unreadable: false,
  validFrom: "2026-07-28T10:00:00.000Z",
  validUntil: null,
  provenance: "USER_REPORTED" as const,
  supersededByRevisionId: null,
  createdAt: "2026-07-28T10:00:00.000Z",
};

function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.healthProfileFacts(), {
    current: {
      SMOKING_STATUS: fact,
      ALCOHOL_PATTERN: null,
      SHIFT_SCHEDULE: null,
    },
    history: [fact],
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <HealthProfileFactsManager />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { client, html };
}

beforeEach(() => {
  confirmButtons.length = 0;
  renderedButtons.length = 0;
  apiDelete.mockClear();
  apiPatch.mockClear();
});

describe("health-profile fact removal control", () => {
  it("uses one Save label for new and existing lifestyle facts", () => {
    render();

    const actionLabels = renderedButtons
      .filter(
        (props) =>
          props.type === "button" &&
          // The Save control is the entry's PRIMARY action, so it carries the
          // default variant. Matching on `variant === "outline"` used to be the
          // discriminator and silently stopped matching anything when the
          // action row was rebuilt — the button was still there, the selector
          // was not.
          props.variant === undefined &&
          typeof props.onClick === "function",
      )
      .map((props) => {
        const children = Array.isArray(props.children)
          ? props.children
          : [props.children];
        return children.filter((child) => typeof child === "string").join("");
      });

    expect(actionLabels).toEqual(["Save", "Save", "Save"]);
    expect(actionLabels).not.toContain("Correct");
  });

  it("renders a confirmed removal action only for each recorded current fact", () => {
    const { html } = render();

    expect(confirmButtons).toHaveLength(1);
    // The visible label is short — three entries side by side each carrying
    // their own field name read as one run of words — but the ACCESSIBLE name
    // still says which entry it removes, and so does the dialog it opens.
    expect(confirmButtons[0]).toMatchObject({
      slot: "health-profile-fact-remove-SMOKING_STATUS",
      label: "Remove",
      ariaLabel: "Remove Smoking status",
      confirmLabel: "Remove Smoking status",
      title: "Remove Smoking status?",
      body: "The current value will become not recorded. Its dated history will be retained.",
    });
    expect(html).toContain("Remove");
    expect(apiDelete).not.toHaveBeenCalled();
  });

  it("uses the current revision id as the concurrency token after confirmation", async () => {
    render();

    (confirmButtons[0].onConfirm as () => void)();

    await vi.waitFor(() =>
      expect(apiDelete).toHaveBeenCalledWith("/api/anamnesis/facts/fact-1"),
    );
  });

  it("optimistically resolves the current fact as absent while retaining closed history", async () => {
    const { client } = render();

    (confirmButtons[0].onConfirm as () => void)();
    await vi.waitFor(() => {
      const data = client.getQueryData<{
        current: Record<string, unknown>;
        history: Array<{ id: string; validUntil: string | null }>;
      }>(queryKeys.healthProfileFacts());
      expect(data?.current.SMOKING_STATUS).toBeNull();
      expect(data?.history).toEqual([
        expect.objectContaining({ id: "fact-1", validUntil: removedAt }),
      ]);
    });
  });

  it("invalidates advisor data after a successful save or correction", async () => {
    const { client } = render();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const saveButton = renderedButtons.find(
      (props) =>
        props.type === "button" &&
        props.variant === undefined &&
        typeof props.onClick === "function",
    );

    expect(saveButton).toBeDefined();
    (saveButton!.onClick as () => void)();

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.insightsAdvisor(),
      }),
    );
  });

  it("invalidates advisor data after a successful removal", async () => {
    const { client } = render();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    (confirmButtons[0].onConfirm as () => void)();

    await vi.waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({
        queryKey: queryKeys.insightsAdvisor(),
      }),
    );
  });

  it("invalidates the facts read when save or correction finds a stale 404 target", async () => {
    apiPatch.mockRejectedValueOnce(new MockApiError("Not found", 404));
    const { client } = render();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const saveButton = renderedButtons.find(
      (props) =>
        props.type === "button" &&
        props.variant === undefined &&
        typeof props.onClick === "function",
    );

    expect(saveButton).toBeDefined();
    (saveButton!.onClick as () => void)();

    await vi.waitFor(() => expect(apiPatch).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.healthProfileFacts(),
    });
  });

  it("invalidates the facts read when removal finds a stale 404 target", async () => {
    apiDelete.mockRejectedValueOnce(new MockApiError("Not found", 404));
    const { client } = render();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    (confirmButtons[0].onConfirm as () => void)();

    await vi.waitFor(() => expect(apiDelete).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.healthProfileFacts(),
    });
  });
});
