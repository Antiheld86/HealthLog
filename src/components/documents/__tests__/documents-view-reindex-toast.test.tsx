import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Refs #776 — the "index all" toast's count honesty.
 *
 * The reindex route reports `enqueued` as a NUMBER (documents still to
 * index); the toast interpolates it into "Indexing {count} document(s)".
 * Before the route fix the wire carried `Boolean(jobId)` and the toast said
 * "Indexing true document(s)". This pins the component end of that contract:
 * fed the real wire shape, the success toast renders the count and NEVER the
 * word "true"; a 0 says "everything is already indexed" instead of promising
 * queued work.
 *
 * House convention: `renderToStaticMarkup` + handler exercised via a mocked
 * child reference (the filter bar captures `onIndexAll`), no DOM events.
 */

let mockSearch = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/documents",
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", modules: { inboundDocuments: true } },
    isLoading: false,
    isAuthenticated: true,
  }),
}));

vi.mock("@/lib/api/api-fetch", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/api-fetch")>(
    "@/lib/api/api-fetch",
  );
  return {
    ...actual,
    apiGet: () => new Promise(() => {}),
    apiPatch: vi.fn(),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
  };
});

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

// Capture the view's index-all handler through the filter bar's prop — the
// static render cannot click, so the mocked child is the seam.
let capturedOnIndexAll: (() => void) | undefined;
vi.mock("../document-filter-bar", () => ({
  DocumentFilterBar: (props: { onIndexAll?: () => void }) => {
    capturedOnIndexAll = props.onIndexAll;
    return null;
  },
}));

// The reindex mutation resolves synchronously with a configurable wire
// payload — exactly what `apiPost` would unwrap from the route envelope.
let wirePayload: { enqueued: number };
vi.mock("../use-content-index", () => ({
  useIndexDocument: () => ({ mutate: vi.fn(), isPending: false }),
  useReindexAll: () => ({
    mutate: (
      _vars: void,
      opts?: { onSuccess?: (result: { enqueued: number }) => void },
    ) => {
      opts?.onSuccess?.(wirePayload);
    },
    isPending: false,
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { DocumentsView } from "../documents-view";

function render() {
  mockSearch = "";
  capturedOnIndexAll = undefined;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">
        <DocumentsView />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<DocumentsView> index-all toast (#776)", () => {
  it("renders the remaining count — never the word 'true'", () => {
    wirePayload = { enqueued: 3 };
    render();
    expect(capturedOnIndexAll).toBeDefined();

    capturedOnIndexAll!();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const message = String(toastSuccess.mock.calls[0]![0]);
    expect(message).toContain("3");
    expect(message).not.toContain("true");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("says everything is indexed on an honest 0, not 'indexing 0 documents'", () => {
    wirePayload = { enqueued: 0 };
    render();

    capturedOnIndexAll!();

    expect(toastSuccess).toHaveBeenCalledTimes(1);
    const message = String(toastSuccess.mock.calls[0]![0]);
    expect(message).toContain("already indexed");
    expect(message).not.toContain("true");
  });
});
