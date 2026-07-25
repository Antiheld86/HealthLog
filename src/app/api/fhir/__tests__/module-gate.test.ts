/**
 * `/api/fhir/*` — doctorReport module gate.
 *
 * The FHIR REST face serves the same whole-record aggregate as
 * `/api/export/health-record`, including the decrypted insurance number on
 * the Patient resource. The export gates on the `doctorReport` module; the
 * FHIR routes did not, so the module could be off and `$everything` still
 * returned the full Bundle to the same token.
 *
 * REFUSE, not omit — a whole-record export has no truthful partial answer.
 * Every data route 403s with the shared `module.disabled` envelope; only the
 * static CapabilityStatement at `/api/fhir/metadata` stays open (server
 * metadata, no user data).
 *
 * Behavioural: the assertions read status codes and check that no aggregate
 * was ever loaded, so removing a gate turns them red.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
// The module gate itself is NOT mocked — the whole point is to exercise the
// real resolver and the real 403 envelope. Only its data sources are stubbed,
// so the module state is driven the same way production drives it: through
// the persisted `modulePreferencesJson` allowlist.
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
vi.mock("@/lib/fhir/rest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fhir/rest")>();
  return { ...actual, loadFhirContext: vi.fn() };
});
vi.mock("@/lib/fhir/resources", () => ({
  GERMAN_ATC_DEFAULT_LOCALES: ["de"],
  PATIENT_RESOURCE_ID: "patient-1",
  patientResource: vi.fn(() => ({ resourceType: "Patient", id: "patient-1" })),
  coverageResource: vi.fn(() => null),
  observationsFromReportData: vi.fn(() => []),
  cycleObservationsFromReportData: vi.fn(() => []),
  conditionsFromReportData: vi.fn(() => ({ conditions: [], encounters: [] })),
  medicationStatementsFromReportData: vi.fn(() => []),
  medicationAdministrationsFromReportData: vi.fn(() => []),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET as patientGet } from "../Patient/route";
import { GET as coverageGet } from "../Coverage/route";
import { GET as patientRead } from "../Patient/[id]/route";
import { GET as coverageRead } from "../Coverage/[id]/route";
import { GET as observationRead } from "../Observation/[id]/route";
import { GET as medStatementRead } from "../MedicationStatement/[id]/route";
import { GET as medAdminRead } from "../MedicationAdministration/[id]/route";
import { GET as observationGet } from "../Observation/route";
import { GET as medStatementGet } from "../MedicationStatement/route";
import { GET as medAdminGet } from "../MedicationAdministration/route";
import { GET as everythingGet } from "../Patient/$everything/route";
import { GET as metadataGet } from "../metadata/route";

import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { MODULE_DISABLED_ERROR_CODE, MODULE_KEYS } from "@/lib/modules/gate";
import { getOperatorModuleAvailability } from "@/lib/modules/operator-availability";
import { loadFhirContext } from "@/lib/fhir/rest";
import { prisma } from "@/lib/db";

/**
 * Drive the REAL gate the way production does — through the persisted
 * `modulePreferencesJson` disabled-allowlist, where only a literal `false`
 * turns a module off.
 */
function setDoctorReportModule(enabled: boolean): void {
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    gender: null,
    disableCoach: false,
    modulePreferencesJson: enabled ? {} : { doctorReport: false },
  } as never);
  vi.mocked(prisma.cycleProfile.findUnique).mockResolvedValue(null as never);
}

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

/**
 * Every data route under `/api/fhir`, by the path a caller would hit. The
 * `/{type}/{id}` reads are here too: a route that 403s on search and serves on
 * read would leak the same record through the other door.
 */
const DATA_ROUTES: ReadonlyArray<
  [string, (req: NextRequest) => Promise<Response>]
> = [
  ["Patient", patientGet],
  ["Coverage", coverageGet],
  ["Observation", observationGet],
  ["MedicationStatement", medStatementGet],
  ["MedicationAdministration", medAdminGet],
  ["Patient/$everything", everythingGet],
];

/**
 * The `/{type}/{id}` reads. Same gate, different success shape (a bare
 * resource, not a Bundle) — a route that 403s on search and serves on read
 * would leak the same record through the other door.
 */
function idCtx(id: string) {
  return { params: Promise.resolve({ id }) };
}

const READ_ROUTES: ReadonlyArray<
  [string, (req: NextRequest) => Promise<Response>]
> = [
  ["Patient/patient-1", (req) => patientRead(req, idCtx("patient-1"))],
  ["Coverage/coverage-1", (req) => coverageRead(req, idCtx("coverage-1"))],
  ["Observation/obs-1", (req) => observationRead(req, idCtx("obs-1"))],
  ["MedicationStatement/med-1", (req) => medStatementRead(req, idCtx("med-1"))],
  [
    "MedicationAdministration/medadmin-1",
    (req) => medAdminRead(req, idCtx("medadmin-1")),
  ],
];

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost/api/fhir/${path}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now(),
  } as never);
  // Operator layer available for every module; the per-user layer is what
  // each test drives.
  vi.mocked(getOperatorModuleAvailability).mockResolvedValue(
    Object.fromEntries(MODULE_KEYS.map((k) => [k, true])) as never,
  );
  vi.mocked(loadFhirContext).mockResolvedValue({
    data: {
      period: {
        days: 90,
        since: "2026-02-02T00:00:00.000Z",
        start: "2026-02-02T00:00:00.000Z",
        end: "2026-05-03T00:00:00.000Z",
      },
      patient: {},
    } as never,
    identity: { insuranceNumber: "A123456789" },
    germanAtc: false,
    records: {},
  });
});

describe("/api/fhir/* — doctorReport module gate", () => {
  describe.each(DATA_ROUTES)("GET /api/fhir/%s", (path, handler) => {
    it("403s with module.disabled when the module is off", async () => {
      setDoctorReportModule(false);

      const res = await handler(req(path));
      expect(res.status).toBe(403);

      const body = (await res.json()) as {
        data: unknown;
        error: string;
        meta?: { errorCode?: string; module?: string };
      };
      expect(body.data).toBeNull();
      expect(body.meta?.errorCode).toBe(MODULE_DISABLED_ERROR_CODE);
      expect(body.meta?.module).toBe("doctorReport");

      // Refused before any record was assembled — the insurance number
      // never left the store.
      expect(loadFhirContext).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain("A123456789");
    });

    it("serves the Bundle when the module is on", async () => {
      setDoctorReportModule(true);

      const res = await handler(req(path));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(
        "application/fhir+json",
      );

      const bundle = (await res.json()) as { resourceType: string };
      expect(bundle.resourceType).toBe("Bundle");
      expect(loadFhirContext).toHaveBeenCalledWith("user-1");
    });
  });

  describe.each(READ_ROUTES)("GET /api/fhir/%s", (path, handler) => {
    it("403s with module.disabled when the module is off", async () => {
      setDoctorReportModule(false);

      const res = await handler(req(path));
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        meta?: { errorCode?: string; module?: string };
      };
      expect(body.meta?.errorCode).toBe(MODULE_DISABLED_ERROR_CODE);
      expect(body.meta?.module).toBe("doctorReport");
      expect(loadFhirContext).not.toHaveBeenCalled();
      expect(JSON.stringify(body)).not.toContain("A123456789");
    });

    it("reaches the record when the module is on", async () => {
      setDoctorReportModule(true);

      const res = await handler(req(path));
      // The emitters are stubbed empty here, so the honest answer is a
      // `not-found` OperationOutcome — what matters is that the gate did not
      // refuse and the aggregate was assembled.
      expect(res.status).not.toBe(403);
      expect(loadFhirContext).toHaveBeenCalledWith("user-1");
    });
  });

  it("leaves the static CapabilityStatement reachable while the module is off", async () => {
    // Server metadata, no user data — the one FHIR route that stays open.
    setDoctorReportModule(false);
    const res = await metadataGet(req("metadata"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resourceType: string };
    expect(body.resourceType).toBe("CapabilityStatement");
  });
});
