import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { TargetEditSheet } from "../target-edit-sheet";

/**
 * v1.4.25 W3f — target-edit dialog. SSR-style assertions because the
 * Radix Dialog body is portalled at runtime; we only check the
 * outer Dialog wiring + the body-mount toggle.
 *
 * Branches covered:
 *   1. open=false → renders no portal markup at all (Dialog content
 *      not mounted; query hooks never instantiated).
 *   2. open=true (editable metric) → the Dialog wrapper is present;
 *      the inner body would render the input rows if it weren't
 *      portalled (we can't see inside but we CAN assert the body
 *      mount path doesn't throw).
 *   3. open=true (derived metric like BMI) → same, with the derived
 *      hint path exercised.
 *
 * A separate `focus-management` test asserts the open=true mount
 * doesn't crash under React's strict-mode render.
 */

function withProviders(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return (
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>
  );
}

describe("<TargetEditSheet>", () => {
  it("renders no Dialog content when open=false (hooks never instantiate)", () => {
    // Closed dialog: zero markup beyond the Radix root container.
    const html = renderToStaticMarkup(
      withProviders(
        <TargetEditSheet
          targetType="WEIGHT"
          targetLabel="Weight"
          unit="kg"
          initialRange={{ min: 60, max: 80 }}
          open={false}
          onOpenChange={vi.fn()}
        />,
      ),
    );
    // Body is not mounted while closed — no data-slot for the body.
    expect(html).not.toContain('data-slot="target-edit-sheet"');
  });

  it("mounts the body without throwing for an editable metric (WEIGHT)", () => {
    // Radix portals the DialogContent so it's not in SSR markup, but
    // mounting the body must not throw — the QueryClientProvider above
    // provides the necessary context.
    expect(() =>
      renderToStaticMarkup(
        withProviders(
          <TargetEditSheet
            targetType="WEIGHT"
            targetLabel="Weight"
            unit="kg"
            initialRange={{ min: 60, max: 80 }}
            open={true}
            onOpenChange={vi.fn()}
          />,
        ),
      ),
    ).not.toThrow();
  });

  it("mounts the body without throwing for a BP target (two range pairs)", () => {
    // BP gets BOTH sys + dia input rows.
    expect(() =>
      renderToStaticMarkup(
        withProviders(
          <TargetEditSheet
            targetType="BLOOD_PRESSURE"
            targetLabel="Blood pressure"
            unit="mmHg"
            initialRange={{ min: 110, max: 130 }}
            initialDiastolicRange={{ min: 70, max: 85 }}
            open={true}
            onOpenChange={vi.fn()}
          />,
        ),
      ),
    ).not.toThrow();
  });

  it("mounts a glucose target seeded in mmol/L without throwing", () => {
    // The parent hands a mmol/L-converted range + unit="mmol/L"; the
    // sheet now seeds/validates in mmol/L and converts back to mg/dL on
    // save. Smoke-check the new conversion path mounts cleanly.
    expect(() =>
      renderToStaticMarkup(
        withProviders(
          <TargetEditSheet
            targetType="BLOOD_GLUCOSE_FASTING"
            targetLabel="Fasting glucose"
            unit="mmol/L"
            initialRange={{ min: 3.9, max: 5.5 }}
            open={true}
            onOpenChange={vi.fn()}
          />,
        ),
      ),
    ).not.toThrow();
  });

  it("mounts a weight target seeded in pounds without throwing", () => {
    // v1.32.27 — an imperial account gets `unit="lb"` and a
    // pound-converted seed from the panel; the sheet projects the
    // kilogram guardrails into the same unit and inverts on save. The
    // arithmetic itself is pinned in `target-unit-display.test.ts`
    // (Radix portals the body, so SSR cannot read the fields back);
    // this covers the mount path composing cleanly.
    expect(() =>
      renderToStaticMarkup(
        withProviders(
          <TargetEditSheet
            targetType="WEIGHT"
            targetLabel="Weight"
            unit="lb"
            initialRange={{ min: 132.3, max: 176.4 }}
            open={true}
            onOpenChange={vi.fn()}
          />,
        ),
      ),
    ).not.toThrow();
  });

  it("mounts the body without throwing for a derived metric (BMI)", () => {
    // BMI is derived from weight + height — the body shows the
    // explanatory hint instead of the editable inputs.
    expect(() =>
      renderToStaticMarkup(
        withProviders(
          <TargetEditSheet
            targetType="BMI"
            targetLabel="BMI"
            unit=""
            initialRange={{ min: 18.5, max: 24.9 }}
            open={true}
            onOpenChange={vi.fn()}
          />,
        ),
      ),
    ).not.toThrow();
  });

  it("re-renders cleanly when open flips from false → true", () => {
    // Verifies the lazy-mount: closed render produces zero body
    // markup; opening it instantiates the body without conflicting
    // with the prior render.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const closedHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <TargetEditSheet
            targetType="PULSE"
            targetLabel="Resting pulse"
            unit="bpm"
            initialRange={{ min: 60, max: 100 }}
            open={false}
            onOpenChange={vi.fn()}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(closedHtml).not.toContain('data-slot="target-edit-sheet"');

    const openHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <TargetEditSheet
            targetType="PULSE"
            targetLabel="Resting pulse"
            unit="bpm"
            initialRange={{ min: 60, max: 100 }}
            open={true}
            onOpenChange={vi.fn()}
          />
        </I18nProvider>
      </QueryClientProvider>,
    );
    // No crash; the Radix Dialog root is in the markup.
    expect(openHtml).toBeTypeOf("string");
  });

  /**
   * v1.4.25 W3f — focus-management contract. The dialog's
   * `onOpenAutoFocus` handler must steal focus from Radix's default
   * (the close X button) and place it on the first numeric input so a
   * keyboard user lands on the editable field. We verify the handler
   * is wired up via the SSR output: Radix renders Dialog content
   * lazily, so we check that the component compiles + the ref pattern
   * doesn't throw under render (a defensive smoke; the actual focus
   * shift is exercised by Playwright in the v1.4.25 verification
   * phase).
   */
  describe("focus management (v1.4.25 W3f)", () => {
    it("does not throw when the dialog opens with a valid ref target", () => {
      // The body's onOpenAutoFocus handler reads firstInputRef.current
      // — this is null at SSR time. The handler is guarded by an
      // `if (firstInputRef.current)` check so the SSR render never
      // dereferences null. This test pins that contract: the open
      // mount must not throw, even though the DOM ref isn't set yet.
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      expect(() =>
        renderToStaticMarkup(
          <QueryClientProvider client={client}>
            <I18nProvider initialLocale="en">
              <TargetEditSheet
                targetType="BODY_FAT"
                targetLabel="Body fat"
                unit="%"
                initialRange={{ min: 10, max: 22 }}
                open={true}
                onOpenChange={vi.fn()}
              />
            </I18nProvider>
          </QueryClientProvider>,
        ),
      ).not.toThrow();
    });
  });
});
