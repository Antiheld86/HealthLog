/**
 * v1.16.10 — Bestand summary availability semantics.
 *
 * Renders `<InventorySection>` with a seeded query cache and pins the
 * release-QA scenario: a single EXPIRED pen with units left shows ZERO
 * available doses in the headline, with the expired units as a muted
 * suffix — matching the list payload and the GLP-1 endpoint instead of
 * counting expired stock as supply.
 *
 * v1.19.0 (iOS#25) — the headline is now server-authoritative: the GET
 * response carries a `summary` computed server-side via `summariseSupply`,
 * and the component RENDERS it (no client-side derivation). The seed
 * builds that summary with the same canonical helper the server uses, so
 * these scenarios assert the component renders the server DTO faithfully.
 *
 * Project convention is SSR-only component tests (`renderToStaticMarkup`).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { summariseSupply } from "@/lib/medications/inventory/summary";

const useQueryMock = vi.fn();

vi.mock("@tanstack/react-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
  useQueryClient: () => ({
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { InventorySection } = await import("../sections/inventory-section");

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="de">{node}</I18nProvider>,
  );
}

function seedItems(
  items: Array<{
    state: "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";
    unitsTotal: number;
    unitsRemaining: number;
    [key: string]: unknown;
  }>,
  unitsPerDose = 1,
) {
  // The server computes the canonical summary; reproduce it here with the
  // one source of truth so the seed mirrors the real DTO the route ships.
  const summary = summariseSupply(
    items.map((i) => ({
      state: i.state,
      unitsTotal: i.unitsTotal,
      unitsRemaining: i.unitsRemaining,
    })),
    unitsPerDose,
  );
  useQueryMock.mockReturnValue({
    data: { items, summary, meta: { total: items.length } },
    isLoading: false,
  });
}

describe("<InventorySection> — summary availability", () => {
  it("only expired stock ⇒ the headline says so instead of '0 of 0'", () => {
    // "0 von 0 Dosen übrig" beside "+ 4 Einheiten abgelaufen" reads as
    // two contradicting statements: the first says nothing was ever
    // recorded, the second says stock was written off. One honest line
    // replaces both.
    seedItems([
      {
        id: "i1",
        state: "EXPIRED",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 4,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain("Kein nutzbarer Bestand: 4 Einheiten");
    expect(html).not.toContain("0 von 0 Dosen übrig");
    expect(html).not.toContain('data-slot="inventory-expired-suffix"');
    // The item row itself stays visible with its state badge.
    expect(html).toContain("Abgelaufen");
  });

  it("usable stock counts; expired suffix absent when nothing expired", () => {
    seedItems([
      {
        id: "i1",
        state: "ACTIVE",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 4,
      },
      {
        id: "i2",
        state: "USED_UP",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 0,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain("4 von 4 Dosen übrig");
    expect(html).not.toContain('data-slot="inventory-expired-suffix"');
  });

  it("mixed usable + expired: headline counts only the usable pool", () => {
    seedItems([
      {
        id: "i1",
        state: "IN_USE",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 2,
      },
      {
        id: "i2",
        state: "EXPIRED",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 3,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain("2 von 4 Dosen übrig");
    expect(html).toContain("+ 3 Einheiten abgelaufen");
    expect(html).not.toContain("Kein nutzbarer Bestand");
  });

  it("keeps the plain empty-supply reading when nothing was written off", () => {
    // Every container drained: zero available AND zero expired. That is
    // the honest "0 of 0", and it must not be replaced.
    seedItems([
      {
        id: "i1",
        state: "USED_UP",
        containerType: "PEN",
        unitsTotal: 4,
        unitsRemaining: 0,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain("0 von 0 Dosen übrig");
    expect(html).not.toContain("Kein nutzbarer Bestand");
  });
});
