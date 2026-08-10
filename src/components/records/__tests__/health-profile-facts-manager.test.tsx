import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { HealthProfileFactsManager } from "../health-profile-facts-manager";

const {
  MockApiError,
  apiDelete,
  apiPatch,
  apiPost,
  toastError,
  toastWritten,
  confirmButtons,
  renderedButtons,
  selects,
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
    apiPost: vi.fn(),
    toastError: vi.fn(),
    toastWritten: vi.fn(),
    confirmButtons: [] as Record<string, unknown>[],
    renderedButtons: [] as Record<string, unknown>[],
    selects: [] as Record<string, unknown>[],
    removedAt,
  };
});

vi.mock("@/lib/api/api-fetch", () => ({
  ApiError: MockApiError,
  apiDelete,
  apiGet: vi.fn(),
  apiPatch,
  apiPost,
}));
vi.mock("sonner", () => ({ toast: { error: toastError } }));
vi.mock("@/components/outcome/outcome-toast", () => ({
  toastWrittenOutcome: toastWritten,
}));
vi.mock("@/components/ui/button", () => ({
  Button: (props: Record<string, unknown>) => {
    renderedButtons.push(props);
    return <button />;
  },
}));

// The real Radix Select hides its `onValueChange` behind the trigger, so the
// draft edits the interactions drive can't reach it. A thin mock exposes the
// callback (kinds render in `HEALTH_PROFILE_FACT_KINDS` order) so a test can set
// a draft the one footer Save then writes.
vi.mock("@/components/ui/select", () => ({
  Select: (props: Record<string, unknown>) => {
    selects.push(props);
    return <div>{props.children as ReactNode}</div>;
  },
  SelectContent: (props: Record<string, unknown>) => (
    <>{props.children as ReactNode}</>
  ),
  SelectItem: (props: Record<string, unknown>) => (
    <>{props.children as ReactNode}</>
  ),
  SelectTrigger: (props: Record<string, unknown>) => (
    <>{props.children as ReactNode}</>
  ),
  SelectValue: () => null,
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

// The one primary action: default variant, a button-type, its own onClick.
function saveButton() {
  return renderedButtons.find(
    (props) =>
      props.type === "button" &&
      props.variant === undefined &&
      typeof props.onClick === "function",
  );
}

function editDraft(index: number, value: string) {
  (selects[index].onValueChange as (next: string) => void)(value);
}

beforeEach(() => {
  confirmButtons.length = 0;
  renderedButtons.length = 0;
  selects.length = 0;
  apiDelete.mockClear();
  apiPatch.mockReset();
  apiPost.mockReset();
  toastError.mockClear();
  toastWritten.mockClear();
});

describe("health-profile fact save + removal controls", () => {
  it("renders exactly one Save for the whole lifestyle-context tile", () => {
    render();

    const actionButtons = renderedButtons.filter(
      (props) =>
        props.type === "button" &&
        props.variant === undefined &&
        typeof props.onClick === "function",
    );
    const labels = actionButtons.map((props) => {
      const children = Array.isArray(props.children)
        ? props.children
        : [props.children];
      return children.filter((child) => typeof child === "string").join("");
    });

    expect(labels).toEqual(["Save"]);
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

  it("invalidates advisor data after a successful save", async () => {
    apiPatch.mockResolvedValueOnce({ ...fact, value: "NEVER" });
    const { client } = render();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    // Revise the recorded smoking status, then hit the one Save.
    editDraft(0, "NEVER");
    (saveButton()!.onClick as () => void)();

    await vi.waitFor(() =>
      expect(apiPatch).toHaveBeenCalledWith("/api/anamnesis/facts/fact-1", {
        value: "NEVER",
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.insightsAdvisor(),
    });
    expect(toastWritten).toHaveBeenCalledWith(
      "success",
      "Lifestyle context saved",
    );
  });

  it("invalidates the facts read when a save finds a stale 404 target", async () => {
    apiPatch.mockRejectedValueOnce(new MockApiError("Not found", 404));
    const { client } = render();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    editDraft(0, "NEVER");
    (saveButton()!.onClick as () => void)();

    await vi.waitFor(() => expect(apiPatch).toHaveBeenCalledOnce());
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.healthProfileFacts(),
    });
    // A stale target is a failure, never a green toast.
    expect(toastWritten).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalled();
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

  it("writes every dirty kind and keeps a conflicted kind while the other persists", async () => {
    // Two dirty kinds: SMOKING revises an existing fact (PATCH), ALCOHOL is a
    // first value (POST). Force the PATCH to 409 and prove the POST still lands,
    // the failure is surfaced per-kind, and the conflicted draft survives.
    apiPatch.mockRejectedValue(new MockApiError("Stale", 409));
    apiPost.mockResolvedValue({
      id: "fact-2",
      kind: "ALCOHOL_PATTERN",
      value: "WEEKLY",
    });
    render();

    editDraft(0, "NEVER"); // SMOKING_STATUS, differs from FORMER
    editDraft(1, "WEEKLY"); // ALCOHOL_PATTERN, first value
    (saveButton()!.onClick as () => void)();

    // Both writes reach the real endpoints in one Save.
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(apiPatch).toHaveBeenCalledWith("/api/anamnesis/facts/fact-1", {
      value: "NEVER",
    });
    expect(apiPost).toHaveBeenCalledWith("/api/anamnesis/facts", {
      kind: "ALCOHOL_PATTERN",
      value: "WEEKLY",
    });

    // The partial failure is not hidden behind a green toast: the error names
    // the kind that did not land, and no success toast fired.
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining("Smoking status"),
    );
    expect(toastWritten).not.toHaveBeenCalled();

    // The conflicted draft survives while the persisted one is consumed: a
    // second Save re-attempts only SMOKING and never re-POSTs ALCOHOL.
    apiPatch.mockClear();
    apiPost.mockClear();
    (saveButton()!.onClick as () => void)();

    await vi.waitFor(() => expect(apiPatch).toHaveBeenCalledOnce());
    expect(apiPatch).toHaveBeenCalledWith("/api/anamnesis/facts/fact-1", {
      value: "NEVER",
    });
    expect(apiPost).not.toHaveBeenCalled();
  });
});
