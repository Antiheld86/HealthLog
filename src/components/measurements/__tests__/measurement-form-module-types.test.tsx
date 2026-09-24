/**
 * The measurement form offers only types whose module is on.
 *
 * The add menu's "Measurement" entry (and every other mount of the form)
 * listed sleep and glucose with those modules switched off, so a person could
 * file a reading into a domain whose pages, charts and reads are all hidden,
 * or be refused by the route. The form now filters its types through the
 * surface map's type ownership (`summary:<type>`), which the test below holds
 * equal to the measurement-scope ownership the server gates on.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { MeasurementType } from "@/generated/prisma/client";
import { moduleForMeasurementType } from "@/lib/modules/measurement-scope";
import { surfaceModule } from "@/lib/modules/surface";

const auth = vi.hoisted(() => ({
  modules: undefined as Record<string, boolean> | undefined,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      role: "USER",
      unitPreference: "metric",
      glucoseUnit: null,
      modules: auth.modules,
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
import {
  MEASUREMENT_FORM_TYPE_VALUES,
  MeasurementForm,
  measurementFormTypes,
} from "../measurement-form";

describe("measurementFormTypes", () => {
  it("drops sleep and glucose while their modules are off", () => {
    const values = measurementFormTypes({ sleep: false, glucose: false }).map(
      (t) => t.value,
    );
    expect(values).not.toContain("SLEEP_DURATION");
    expect(values).not.toContain("BLOOD_GLUCOSE");
    expect(values).toContain("WEIGHT");
  });

  it("offers every type while the module map is unknown or all on", () => {
    expect(measurementFormTypes(undefined)).toHaveLength(
      MEASUREMENT_FORM_TYPE_VALUES.length,
    );
    expect(measurementFormTypes({ sleep: true, glucose: true })).toHaveLength(
      MEASUREMENT_FORM_TYPE_VALUES.length,
    );
  });

  it("reads the same ownership the server gates measurement types on", () => {
    let owned = 0;
    for (const type of MEASUREMENT_FORM_TYPE_VALUES) {
      const owner = moduleForMeasurementType(type as MeasurementType);
      if (owner) owned += 1;
      expect(surfaceModule(`summary:${type}`), type).toBe(owner ?? undefined);
    }
    expect(owned).toBeGreaterThan(0);
  });
});

describe("<MeasurementForm> with a type's module off", () => {
  it("does not open on that type, even when asked to", () => {
    auth.modules = { glucose: false };
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <MeasurementForm defaultType="BLOOD_GLUCOSE" />
      </I18nProvider>,
    );
    auth.modules = undefined;
    expect(html).not.toContain("mg/dL");
    expect(html).toContain("mmHg");
  });
});
