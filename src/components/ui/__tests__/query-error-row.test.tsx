import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { QueryErrorRow } from "../query-error-row";

function ssr(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("<QueryErrorRow>", () => {
  it("renders the compact alert row with foreground message text", () => {
    const html = ssr(<QueryErrorRow message="Could not load vitals" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-slot="query-error-row"');
    expect(html).toContain("Could not load vitals");
    // §3 — an alert IS the surface's content, so it is foreground. Both
    // hand-rolled copies this primitive replaces put it in the muted tier.
    expect(html).toContain("text-foreground");
    // The compact row shape, not the tall centred `<QueryErrorCard>`.
    expect(html).toContain("p-4");
    expect(html).not.toContain("py-10");
  });

  it("falls back to the generic load-failed copy", () => {
    expect(ssr(<QueryErrorRow />)).toContain("Could not load");
  });

  it("only renders the retry affordance when a handler is wired", () => {
    expect(ssr(<QueryErrorRow message="boom" />)).not.toContain("<button");

    const withRetry = ssr(<QueryErrorRow message="boom" onRetry={() => {}} />);
    expect(withRetry).toContain("<button");
    expect(withRetry).toContain("Retry");
    expect(withRetry).toContain('data-slot="query-error-row-retry"');
  });

  it("honours the slot overrides the converted surfaces depend on", () => {
    const html = ssr(
      <QueryErrorRow
        message="boom"
        onRetry={() => {}}
        slot="healthkit-metric-error"
        retrySlot="healthkit-metric-retry"
      />,
    );
    expect(html).toContain('data-slot="healthkit-metric-error"');
    expect(html).toContain('data-slot="healthkit-metric-retry"');
    expect(html).not.toContain('data-slot="query-error-row"');
  });

  it("takes a custom retry label", () => {
    expect(
      ssr(
        <QueryErrorRow message="boom" onRetry={() => {}} retryLabel="Again" />,
      ),
    ).toContain("Again");
  });
});
