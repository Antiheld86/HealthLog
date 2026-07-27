/**
 * v1.16.10 — `<AddInventoryDialog>` register-flow coverage.
 *
 * Pins the multi-unit quantity input: the segmented Dosen | Einheiten
 * control only surfaces when a dose spans more than one unit, the live
 * conversion line renders next to the quantity, the POST always carries
 * UNITS, and the container-type select defaults from the delivery form.
 *
 * Project convention is SSR-only component tests (`renderToStaticMarkup`,
 * no `@testing-library/react`) plus source-string structural assertions
 * for the interactive plumbing an SSR mount can't exercise.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// The Radix Dialog / Select portal at runtime, so their bodies never
// materialise in static markup. Collapse the primitives to plain
// wrappers (same trick as the LogInjectionSiteDialog suite).
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: ({ children }: { children?: React.ReactNode }) => (
      <div data-slot="mock-dialog">{children}</div>
    ),
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});

vi.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Select: ({
      value,
      children,
    }: {
      value: string;
      children?: React.ReactNode;
    }) => <div data-mock-select-value={value}>{children}</div>,
    SelectContent: Pass,
    SelectItem: ({ children }: { children?: React.ReactNode }) => (
      <div data-slot="mock-select-item">{children}</div>
    ),
    SelectTrigger: Pass,
    SelectValue: () => null,
  };
});

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => ({ data: undefined, isLoading: false })),
  useQueryClient: () => ({
    invalidateQueries: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const { AddInventoryDialog } = await import("../sections/inventory-section");

function render(node: React.ReactNode, locale: "en" | "de" = "de"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const src = readFileSync(
  resolve(__dirname, "../sections/inventory-dialogs.tsx"),
  "utf8",
);

describe("<AddInventoryDialog>", () => {
  it("surfaces the Dosen | Einheiten segmented control only for multi-unit doses", () => {
    const multi = render(
      <AddInventoryDialog
        medicationId="med-1"
        defaultUnitsTotal={28}
        unitsPerDose={4}
        initialContainerType="BLISTER"
        onClose={() => {}}
      />,
    );
    expect(multi).toContain('data-slot="inventory-quantity-mode"');
    expect(multi).toContain(">Dosen<");
    expect(multi).toContain(">Einheiten<");

    const single = render(
      <AddInventoryDialog
        medicationId="med-1"
        defaultUnitsTotal={28}
        unitsPerDose={1}
        initialContainerType="BLISTER"
        onClose={() => {}}
      />,
    );
    expect(single).not.toContain('data-slot="inventory-quantity-mode"');
  });

  it("renders the live conversion next to the prefilled quantity (units mode → dose equivalent)", () => {
    // Prefill 28 units at 4 units per dose → "≈ 7 Dosen".
    const html = render(
      <AddInventoryDialog
        medicationId="med-1"
        defaultUnitsTotal={28}
        unitsPerDose={4}
        initialContainerType="BLISTER"
        onClose={() => {}}
      />,
    );
    expect(html).toContain('data-slot="inventory-quantity-conversion"');
    expect(html).toContain("≈ 7 Dosen");
  });

  it("defaults the container type from the caller (delivery-form mapping upstream)", () => {
    const html = render(
      <AddInventoryDialog
        medicationId="med-1"
        defaultUnitsTotal={null}
        unitsPerDose={1}
        initialContainerType="PEN"
        onClose={() => {}}
      />,
    );
    expect(html).toContain('data-mock-select-value="PEN"');
    // All six container kinds are offered.
    for (const label of [
      "Pen",
      "Ampulle",
      "Tablettenpackung",
      "Inhalator",
      "Flasche",
      "Sonstiges",
    ]) {
      expect(html).toContain(label);
    }
  });

  it("always submits UNITS: dose-mode input multiplies by unitsPerDose before the POST", () => {
    // Interactive mode-switching is out of SSR reach; the structural
    // contract lives in the source: the submitted value is the converted
    // unit count on the v1.16.10 symmetric wire field `unitsTotal`.
    expect(src).toMatch(
      /const units =\s*\n?\s*effectiveMode === "doses" \? parsed \* unitsPerDose : parsed;/,
    );
    expect(src).toMatch(/unitsTotal: units,/);
    expect(src).toMatch(/containerType,/);
  });

  it("renders '< 1 Dosis' instead of '≈ 0 Dosen' for a sub-dose unit count", () => {
    // 3 units at 4 units per dose is less than one dose — the
    // conversion line must say so rather than rounding to zero.
    const html = render(
      <AddInventoryDialog
        medicationId="med-1"
        defaultUnitsTotal={3}
        unitsPerDose={4}
        initialContainerType="BLISTER"
        onClose={() => {}}
      />,
    );
    expect(html).toContain("&lt; 1 Dosis");
    expect(html).not.toContain("≈ 0 Dosen");
  });

  it("bounds the quantity to 1000 units (dose mode scales the max down)", () => {
    expect(src).toContain("units >= 1 && units <= 1000");
    expect(src).toContain("Math.floor(1000 / unitsPerDose)");
  });

  it("maps the delivery form onto the register default (PEN for INJECTION, BLISTER for ORAL, OTHER otherwise)", () => {
    expect(src).toMatch(
      /if \(deliveryForm === "INJECTION"\) return "PEN";\s*\n\s*if \(deliveryForm === "ORAL"\) return "BLISTER";\s*\n\s*return "OTHER";/,
    );
  });
});
