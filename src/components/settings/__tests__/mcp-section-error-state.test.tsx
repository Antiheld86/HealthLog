/**
 * A read failure on the MCP connector cards (connected assistants, connector
 * tokens) must not read as "nothing connected / no tokens". Both queries are
 * forced into their error state; each card has to render the `query-error-card`
 * slot with retry and never fall through to its empty copy — the §6
 * fall-through on another security surface.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: true,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "u1", role: "USER", modules: { mcp: true } },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { McpSection } from "../mcp-section";

function render() {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <McpSection />
    </I18nProvider>,
  );
}

describe("McpSection — a read failure is honest, not empty", () => {
  it("renders query-error cards with retry and never the empty copy on error", () => {
    const html = render();
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain('data-slot="query-error-retry"');
    // Neither empty copy may appear when the reads failed.
    expect(html).not.toContain("No connected assistants");
    expect(html).not.toContain("No active tokens");
  });
});
