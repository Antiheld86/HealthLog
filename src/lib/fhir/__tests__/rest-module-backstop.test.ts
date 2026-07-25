/**
 * `loadFhirContext` — doctorReport module backstop.
 *
 * The loader is the one door to the whole-record aggregate the FHIR face
 * serves, including the decrypted insurance number. Every `/api/fhir/*` data
 * route carries its own `requireModuleEnabled` gate (that is what produces the
 * clean 403); this test pins the SECOND layer — the loader refuses outright
 * rather than trusting that every present and future caller remembered.
 *
 * The gate resolver is exercised for real; only its data sources are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    cycleProfile: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/modules/operator-availability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/modules/operator-availability")
    >();
  return { ...actual, getOperatorModuleAvailability: vi.fn() };
});
vi.mock("@/lib/doctor-report-data", () => ({
  collectDoctorReportData: vi.fn(),
  normaliseDateRange: vi.fn(() => ({ from: new Date(0), to: new Date() })),
}));
vi.mock("@/lib/crypto", () => ({ decrypt: vi.fn(() => "A123456789") }));
// The REST face replays the owner's saved selection; this test is about the
// module backstop, so the selection is fixed to one that names the insurance
// leaf — otherwise the identity assertion below would be testing the
// selection resolver instead.
vi.mock("@/lib/report-selection/saved-profile", () => ({
  resolveSavedSelection: vi.fn(async () => selectionFromLeaves(["INSURANCE"])),
}));

import { loadFhirContext } from "@/lib/fhir/rest";
import { MODULE_KEYS } from "@/lib/modules/gate";
import { getOperatorModuleAvailability } from "@/lib/modules/operator-availability";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { prisma } from "@/lib/db";
import { selectionFromLeaves } from "@/lib/report-selection/selection";

function setDoctorReportModule(enabled: boolean): void {
  vi.mocked(prisma.user.findUnique).mockImplementation((async (args: {
    select?: Record<string, boolean>;
  }) => {
    // The gate's own read and the loader's identity read hit the same model.
    if (args?.select?.modulePreferencesJson) {
      return {
        gender: null,
        disableCoach: false,
        modulePreferencesJson: enabled ? {} : { doctorReport: false },
      };
    }
    return { insuranceNumberEncrypted: "cipher", locale: "de" };
  }) as never);
  vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(null as never);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getOperatorModuleAvailability).mockResolvedValue(
    Object.fromEntries(MODULE_KEYS.map((k) => [k, true])) as never,
  );
  vi.mocked(collectDoctorReportData).mockResolvedValue({} as never);
});

describe("loadFhirContext — doctorReport backstop", () => {
  it("refuses to assemble the record when the module is off", async () => {
    setDoctorReportModule(false);

    await expect(loadFhirContext("user-1")).rejects.toThrow(
      /doctorReport.*disabled/,
    );

    // Nothing was aggregated and nothing was decrypted.
    expect(collectDoctorReportData).not.toHaveBeenCalled();
  });

  it("assembles the record when the module is on", async () => {
    setDoctorReportModule(true);

    const ctx = await loadFhirContext("user-1");
    expect(collectDoctorReportData).toHaveBeenCalledTimes(1);
    expect(ctx.identity.insuranceNumber).toBe("A123456789");
  });
});
