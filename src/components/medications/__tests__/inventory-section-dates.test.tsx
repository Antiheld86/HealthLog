/**
 * Bestand item-row dates: visible on the row, editable in the correction
 * dialog.
 *
 * Both dates decide the container's state — the printed expiry directly,
 * the opening date through the post-opening window on a pen or an
 * ampoule — and the opening date is written by the intake consumption
 * hook without the user ever typing it. Until now neither was rendered
 * anywhere and neither could be corrected, so a container could read
 * EXPIRED with nothing on screen to explain why.
 *
 * Project convention is SSR-only component tests (`renderToStaticMarkup`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// Now-anchored future expiry (the fixed 2027-06-01 was a fuse: once the
// calendar passes it, an "expiring later" fixture silently becomes an
// expired one and the assertions rot). ~300 days out keeps it a plainly
// future date on every run; the expected strings derive from the same
// instant so they can never drift from the fixture.
const FUTURE_EXPIRY = new Date(Date.now() + 300 * 24 * 60 * 60 * 1000);
const FUTURE_EXPIRY_YMD = FUTURE_EXPIRY.toISOString().slice(0, 10);
const FUTURE_EXPIRY_ISO = `${FUTURE_EXPIRY_YMD}T00:00:00.000Z`;
const [FE_Y, FE_M, FE_D] = FUTURE_EXPIRY_YMD.split("-");
const FUTURE_EXPIRY_DE = `${FE_D}.${FE_M}.${FE_Y}`;

const src = readFileSync(
  resolve(
    process.cwd(),
    "src/components/medications/sections/inventory-dialogs.tsx",
  ),
  "utf8",
);

// The Radix Dialog / Select portal at runtime, so their bodies never
// materialise in static markup. Collapse the primitives to plain
// wrappers (same trick as the AddInventoryDialog suite).
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

const { InventorySection, AddInventoryDialog, AdjustInventoryDialog } =
  await import("../sections/inventory-section");

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="de">{node}</I18nProvider>,
  );
}

function seedItems(items: unknown[]) {
  useQueryMock.mockReturnValue({
    data: { items, meta: { total: items.length } },
    isLoading: false,
  });
}

interface Row {
  id: string;
  state: "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";
  containerType: "PEN" | "AMPOULE" | "BLISTER" | "INHALER" | "BOTTLE" | "OTHER";
  unitsTotal: number | null;
  unitsRemaining: number | null;
  printedExpiry: string | null;
  firstUseAt: string | null;
}

const BASE = {
  id: "i1",
  state: "IN_USE",
  containerType: "BLISTER",
  unitsTotal: 60,
  unitsRemaining: 54,
} satisfies Omit<Row, "printedExpiry" | "firstUseAt">;

describe("<InventorySection> — item-row dates", () => {
  it("renders the opening date on the row", () => {
    seedItems([
      {
        ...BASE,
        firstUseAt: "2026-06-12T00:00:00.000Z",
        printedExpiry: null,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain('data-slot="inventory-item-dates"');
    expect(html).toContain("Geöffnet 12.06.2026");
  });

  it("renders the printed expiry on the row", () => {
    seedItems([
      {
        ...BASE,
        state: "ACTIVE",
        firstUseAt: null,
        printedExpiry: FUTURE_EXPIRY_ISO,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain(`Haltbar bis ${FUTURE_EXPIRY_DE}`);
  });

  it("separates the two dates when the row carries both", () => {
    seedItems([
      {
        ...BASE,
        firstUseAt: "2026-06-12T00:00:00.000Z",
        printedExpiry: FUTURE_EXPIRY_ISO,
      },
    ]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).toContain("Geöffnet 12.06.2026");
    expect(html).toContain(`Haltbar bis ${FUTURE_EXPIRY_DE}`);
    expect(html).toContain("<span>·</span>");
  });

  it("shows no date line when neither date is recorded", () => {
    // Absence reads as absence — no placeholder, no invented date.
    seedItems([{ ...BASE, firstUseAt: null, printedExpiry: null }]);
    const html = render(
      <InventorySection medicationId="med-1" unitsPerDose={1} />,
    );
    expect(html).not.toContain('data-slot="inventory-item-dates"');
  });
});

describe("<AdjustInventoryDialog> — editable dates", () => {
  const item: Row = {
    ...BASE,
    firstUseAt: "2026-06-12T00:00:00.000Z",
    printedExpiry: FUTURE_EXPIRY_ISO,
  };

  function renderDialog(over: Partial<Row> = {}): string {
    return render(
      <AdjustInventoryDialog
        medicationId="med-1"
        item={{ ...item, ...over }}
        onClose={() => {}}
      />,
    );
  }

  it("offers a printed-expiry field prefilled from the item", () => {
    const html = renderDialog();
    expect(html).toContain('id="inventory-edit-expiry"');
    expect(html).toContain("Aufgedrucktes Haltbarkeitsdatum");
    expect(html).toContain(`value="${FUTURE_EXPIRY_YMD}"`);
  });

  it("offers an opening-date field prefilled from the item", () => {
    const html = renderDialog();
    expect(html).toContain('id="inventory-edit-opened"');
    expect(html).toContain("Geöffnet am");
    expect(html).toContain('value="2026-06-12"');
  });

  it("leaves both date fields empty when the item records neither", () => {
    const html = renderDialog({ firstUseAt: null, printedExpiry: null });
    expect(html).toContain('id="inventory-edit-expiry"');
    expect(html).toContain('id="inventory-edit-opened"');
    expect(html).not.toContain(FUTURE_EXPIRY_YMD);
    expect(html).not.toContain("2026-06-12");
  });

  it("explains the 30-day window beside the opening date on a pen", () => {
    const html = renderDialog({ containerType: "PEN" });
    expect(html).toContain("30 Tage nach dem Öffnen");
  });

  it("omits the window explanation for a container that has none", () => {
    const html = renderDialog({ containerType: "BLISTER" });
    expect(html).not.toContain("30 Tage nach dem Öffnen");
    expect(html).toContain("noch verschlossen");
  });

  it("keeps the remaining-units correction alongside the dates", () => {
    const html = renderDialog();
    expect(html).toContain('id="inventory-adjust-remaining"');
  });

  // Submitting is out of SSR reach, so the wire contract is pinned
  // against the source (same approach as the register-dialog suite).
  it("sends each date only when it actually changed", () => {
    // Absent means untouched on the server: saving a unit correction
    // must not rewrite a date the user never opened.
    expect(src).toMatch(
      /\.\.\.\(expiry !== initialExpiry && \{\s*\n?\s*printedExpiry: fromLocalDayInput\(expiry\),/,
    );
    expect(src).toMatch(
      /\.\.\.\(opened !== initialOpened && \{\s*\n?\s*markAsFirstUseAt: fromLocalDayInput\(opened\),/,
    );
  });

  it("sends a cleared date as null, not as an empty string", () => {
    // null is the deliberate "there is no such date"; the route reads it
    // as a clear, which is the way back out of a wrong auto-open.
    expect(src).toMatch(
      /function fromLocalDayInput\(day: string\): string \| null \{\s*\n\s*if \(!day\) return null;/,
    );
  });
});

describe("<AddInventoryDialog> — printed expiry on create", () => {
  it("still offers the expiry field", () => {
    // Regression guard: the create path always offered the printed
    // expiry; the correction path is the addition.
    const html = render(
      <AddInventoryDialog
        medicationId="med-1"
        defaultUnitsTotal={30}
        unitsPerDose={1}
        initialContainerType="BLISTER"
        onClose={() => {}}
      />,
    );
    expect(html).toContain('id="inventory-add-expiry"');
  });
});
