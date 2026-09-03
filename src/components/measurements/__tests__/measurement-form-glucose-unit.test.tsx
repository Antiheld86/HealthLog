import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The manual entry form and the blood-glucose display unit.
 *
 * Glucose is stored in mg/dL and shown in whichever of mg/dL and mmol/L the
 * account picked. Until the preference could be set at all, the form could
 * hardcode "mg/dL" and be right by accident. It no longer can: a reader on
 * mmol/L types 5.3, and 5.3 filed as mg/dL is a severe hypo that the
 * plausibility band (20–800) accepts without a word and every surface then
 * reads back as real. So the label and the stored number have to move
 * together — the field asks in the account's unit and the submit path
 * inverts to canonical mg/dL.
 *
 * The label half is rendered. The submit half is asserted against the source:
 * this project runs SSR-only component tests (`@testing-library/react` is not
 * a dependency), so nothing here can type into the field and press save. What
 * the source assertion pins is the wiring — that the glucose branch inverts
 * through `toCanonicalMgdl` rather than sending the typed number on — and
 * `src/lib/__tests__/glucose.test.ts` proves the conversion itself.
 */

let glucoseUnit: string | null = null;

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      username: "testuser",
      role: "USER",
      unitPreference: "metric",
      glucoseUnit,
    },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    refetchQueries: vi.fn(),
  }),
}));

vi.mock("@/lib/api/api-fetch", () => ({
  apiPost: vi.fn().mockResolvedValue({}),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { MeasurementForm } from "../measurement-form";

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <MeasurementForm defaultType="BLOOD_GLUCOSE" />
    </I18nProvider>,
  );
}

const formSource = readFileSync(
  join(process.cwd(), "src/components/measurements/measurement-form.tsx"),
  "utf8",
);

describe("MeasurementForm — blood-glucose entry unit", () => {
  it("asks in mg/dL for an account that never chose", () => {
    glucoseUnit = null;
    const html = render();
    expect(html).toContain("mg/dL");
    expect(html).not.toContain("mmol/L");
    expect(html).toContain('placeholder="95"');
  });

  it("asks in mmol/L once the account chose it", () => {
    glucoseUnit = "mmol/L";
    const html = render();
    expect(html).toContain("mmol/L");
    // A mmol/L reader must not be shown a three-digit mg/dL example.
    expect(html).toContain('placeholder="5.3"');
    expect(html).not.toContain('placeholder="95"');
  });

  it("inverts a glucose entry to canonical mg/dL before it is sent", () => {
    expect(formSource).toMatch(
      /if \(isGlucoseMode\) \{\s*canonicalValue = toCanonicalMgdl\(typed, glucoseUnit\);/,
    );
  });

  it("resolves the unit from the account rather than assuming one", () => {
    expect(formSource).toMatch(
      /const glucoseUnit = resolveGlucoseUnit\(user\?\.glucoseUnit\)/,
    );
  });
});
