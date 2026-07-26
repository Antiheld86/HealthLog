/**
 * What the dose-history import card says before anything is written.
 *
 * Project convention is SSR-only component tests (vitest runs `node`;
 * `@testing-library/react` is not installed), so what is pinned here is the
 * markup each state renders rather than a click-through.
 *
 * The two claims: every column of the export has a visible verdict on the card
 * before a file is chosen, and every machine-readable refusal reason has a
 * sentence. A reason without one renders as "reason not recorded", which is a
 * refusal the person can read but cannot act on — the same class of defect as
 * dropping the column silently.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/settings/export",
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MEDICATION_IMPORT_SKIP_REASONS } from "@/lib/jobs/medication-intake-import";
import { AUTO_EXPORT_COLUMN_RULINGS } from "@/lib/medications/import/auto-export-format";
import { IntakeImportSkipGroups } from "@/components/medications/intake-import-result";

import { DoseHistoryColumnRulings } from "../dose-history-columns";
import { DoseHistoryImportCard } from "../dose-history-import-card";

function render(node: React.ReactElement) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
  );
}

describe("<DoseHistoryColumnRulings>", () => {
  const html = render(<DoseHistoryColumnRulings />);

  it("gives every column of the export a visible verdict", () => {
    for (const ruling of AUTO_EXPORT_COLUMN_RULINGS) {
      expect(html, `no row for ${ruling.column}`).toContain(
        `>${ruling.column}<`,
      );
      expect(html).toContain(`data-verdict="${ruling.verdict}"`);
    }
    const rows =
      html.split('data-testid="dose-history-column-ruling"').length - 1;
    expect(rows).toBe(AUTO_EXPORT_COLUMN_RULINGS.length);
  });

  it("says what happens to a column it does not read, rather than omitting it", () => {
    // `Codings` is the one column with a code HealthLog stores a field for and
    // still does not read. Leaving it off the list would be the silent drop.
    expect(html).toContain(">Codings<");
    expect(html).toContain("no documented encoding");
    expect(html).toContain("not read");
  });

  it("marks the fields only the JSON shape carries", () => {
    expect(html).toContain("JSON only");
    for (const ruling of AUTO_EXPORT_COLUMN_RULINGS.filter((r) => r.jsonOnly)) {
      expect(html).toContain(`>${ruling.column}<`);
    }
  });
});

describe("<DoseHistoryImportCard>", () => {
  const html = render(<DoseHistoryImportCard />);

  it("shows the column verdicts and both actions with no result claimed yet", () => {
    expect(html).toContain('data-testid="import-card-dose-history"');
    expect(html).toContain('data-testid="dose-history-columns"');
    expect(html).toContain('data-testid="import-dose-history-preview"');
    expect(html).toContain('data-testid="import-action-dose-history"');
    // Nothing has run, so no outcome and no success affordance.
    expect(html).not.toContain('data-testid="dose-history-verdict"');
    expect(html).not.toContain('data-outcome="success"');
    expect(html).not.toContain("text-success");
  });
});

describe("refusal reason sentences", () => {
  it("has plain language for every reason the importer can report", () => {
    const html = render(
      <IntakeImportSkipGroups
        groups={MEDICATION_IMPORT_SKIP_REASONS.map((reason) => ({
          reason,
          count: 1,
        }))}
      />,
    );
    const lines = html.split("<li>").length - 1;
    expect(lines).toBe(MEDICATION_IMPORT_SKIP_REASONS.length);
    // The fallback exists for a reason a future server sends that this client
    // does not know. It must not be reachable for one this client ships with.
    expect(html).not.toContain("reason not recorded");
  });
});
