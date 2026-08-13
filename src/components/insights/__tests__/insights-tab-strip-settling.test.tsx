import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Refs #786 — the regenerate button's settling state.
 *
 * While a timed-out force regenerate is settling (the server is still
 * generating; the hook polls for the outcome) the button may NOT offer a
 * retry or read as failed: it stays disabled, keeps the spinner, and its
 * label says the assessment is still being prepared. Static renders pin the
 * three visible facts; the toast edges live in the hook/strip effect and are
 * pinned by the outcome mapping (`regenerateToastKind`).
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/insights",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InsightsTabStrip, regenerateToastKind } from "../insights-tab-strip";
import { I18nProvider } from "@/lib/i18n/context";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<InsightsTabStrip> regenerate settling state (#786)", () => {
  it("settling: button disabled, spinner on, label says still being prepared", () => {
    const html = render(
      <InsightsTabStrip
        onRegenerate={() => {}}
        regenerating={false}
        regenerateSettling
      />,
    );
    expect(html).toContain('data-slot="insights-tab-strip-regenerate"');
    expect(html).toContain("Your assessment is still being prepared");
    expect(html).toContain("disabled");
    expect(html).toContain("animate-spin");
  });

  it("idle: button enabled with the regenerate label", () => {
    const html = render(
      <InsightsTabStrip onRegenerate={() => {}} regenerating={false} />,
    );
    expect(html).toContain("Re-run assessment");
    expect(html).not.toContain("Your assessment is still being prepared");
  });
});

describe("regenerateToastKind — falling-edge outcome mapping (#786)", () => {
  it("maps settle-failed to the honest settle error, never success", () => {
    expect(regenerateToastKind("settle-failed")).toEqual({
      kind: "error",
      messageKey: "insights.regenerateSettleFailed",
    });
  });

  it("keeps the existing mappings", () => {
    expect(regenerateToastKind("fresh")).toEqual({
      kind: "success",
      messageKey: "insights.regenerateSuccess",
    });
    expect(regenerateToastKind("timeout")).toEqual({
      kind: "error",
      messageKey: "insights.regenerateError",
    });
    expect(regenerateToastKind("rate-limited")).toEqual({
      kind: "error",
      messageKey: "insights.regenerateRateLimited",
    });
    expect(regenerateToastKind("empty")).toEqual({
      kind: "error",
      messageKey: "insights.regenerateUnavailable",
    });
    expect(regenerateToastKind("no-provider")).toBe(null);
    // Legacy mounts without an outcome keep the unconditional success.
    expect(regenerateToastKind(null)).toEqual({
      kind: "success",
      messageKey: "insights.regenerateSuccess",
    });
    expect(regenerateToastKind(undefined)).toEqual({
      kind: "success",
      messageKey: "insights.regenerateSuccess",
    });
  });
});
