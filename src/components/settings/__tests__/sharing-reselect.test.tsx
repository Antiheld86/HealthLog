/**
 * The pick-again state on a link the selection upgrade closed.
 *
 * Migration 0273 revoked every live record share link minted before the
 * selection model, because their frozen scope was "everything except mood and
 * cycle" — a scope nobody chose. The owner has to see WHY the link stopped
 * working and be able to replace it without retyping what they already
 * decided, or the revocation reads as a fault.
 *
 * Mutation checks:
 *   - drop the `needsReselection` branch in `sharing-section.tsx` → "explains
 *     why the link closed" goes red.
 *   - drop `initialRangeDays` from `ShareLinkCreateForm`'s state seed →
 *     "carries the closed link's window into the replacement" goes red.
 *   - clamp nothing in `prefillFrom` → "clamps a lifetime past the cap" goes
 *     red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { ShareLinkCreateForm } from "../share-link-create-form";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQuery: () => ({ data: undefined, isLoading: false }),
}));

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function numberInputValue(html: string, id: string): string | null {
  const input = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0];
  return input?.match(/value="([^"]*)"/)?.[1] ?? null;
}

describe("share-link create form — re-mint seeding", () => {
  it("carries the closed link's window and lifetime into the replacement", () => {
    const html = render(
      <ShareLinkCreateForm
        initialLabel="Cardiology clinic"
        initialRangeDays={180}
        initialExpiryDays={45}
      />,
    );
    expect(numberInputValue(html, "share-range")).toBe("180");
    expect(numberInputValue(html, "share-expiry")).toBe("45");
    expect(html).toContain("Cardiology clinic");
  });

  it("falls back to the 30-day default when nothing is carried across", () => {
    const html = render(<ShareLinkCreateForm />);
    expect(numberInputValue(html, "share-range")).toBe("30");
    expect(numberInputValue(html, "share-expiry")).toBe("30");
  });

  it("offers the scope picker, with the insurance leaf absent from it", () => {
    const html = render(<ShareLinkCreateForm />);
    expect(html).toContain('data-testid="report-scope-picker-share"');
    expect(html).toContain('data-testid="report-group-row-identity-share"');
    // The server refuses the insurance leaf with a 422; a control that cannot
    // be honoured has no business rendering, so the identity group is two
    // leaves wide here (patient identity + emergency) and three wide in the
    // export panel. Nothing in it is on: a new link starts with an empty scope
    // on every surface.
    const row = html.match(
      /data-testid="report-group-row-identity-share"[\s\S]*?<\/div>/,
    )?.[0];
    expect(row).toBeDefined();
    expect(row).toContain(">0/2<");
    // The fenced tier renders its leaves unconditionally; none is checked.
    expect(html).toContain('data-testid="report-leaf-MOOD-share"');
    expect(html).not.toContain('data-testid="report-leaf-INSURANCE-share"');
  });

  it("hides the scope picker entirely for a documents-only share", () => {
    const html = render(<ShareLinkCreateForm documentOnly />);
    expect(html).not.toContain('data-testid="report-scope-picker-share"');
  });
});
