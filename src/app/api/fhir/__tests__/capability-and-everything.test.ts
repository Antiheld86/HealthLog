/**
 * The CapabilityStatement must describe a face that exists, and
 * `Patient/$everything` must return the whole record.
 *
 * A statement is a promise a generic FHIR client acts on: it will issue a
 * `read` because the statement said `read` is there. So the advertised set is
 * checked against the route tree on disk, not against a second list. And the
 * whole-record operation is checked against the document export it mirrors —
 * "everything" that quietly omits a resource family is the kind of gap only a
 * clinician notices, when the family is the one they needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { existsSync } from "node:fs";
import path from "node:path";

vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/modules/gate", () => ({
  requireModuleEnabled: vi.fn(),
  isModuleEnabled: vi.fn(),
}));
vi.mock("@/lib/fhir/rest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fhir/rest")>();
  return { ...actual, loadFhirContext: vi.fn() };
});
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET as metadataGet } from "../metadata/route";
import { GET as everythingGet } from "../Patient/$everything/route";
import { GET as observationRead } from "../Observation/[id]/route";
import { GET as patientRead } from "../Patient/[id]/route";
import { GET as coverageRead } from "../Coverage/[id]/route";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { loadFhirContext, FHIR_REST_RESOURCE_TYPES } from "@/lib/fhir/rest";
import { requireModuleEnabled, isModuleEnabled } from "@/lib/modules/gate";
import { buildFhirDocumentBundle } from "@/lib/fhir/build-bundle";
import { computeGlucoseClinicalMetrics } from "@/lib/analytics/glucose-metrics";
import type { DoctorReportData } from "@/lib/doctor-report-data";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: { id: "user-1", username: "tester", role: "USER" as const },
};

const FIXED_NOW = new Date("2026-05-03T12:00:00.000Z");

const DATA = {
  period: {
    days: 90,
    since: "2026-02-02T00:00:00.000Z",
    start: "2026-02-02T00:00:00.000Z",
    end: "2026-05-03T12:00:00.000Z",
  },
  patient: {
    username: "sample-user",
    dateOfBirth: "1985-06-15T00:00:00.000Z",
    gender: "MALE",
    heightCm: 182,
    fullName: "Sample Patient",
    insurerName: "Example Insurer",
    insurerIkNumber: "101234567",
  },
  practiceName: null,
  measurements: {
    WEIGHT: [{ value: 79.5, measuredAt: "2026-04-30T08:00:00.000Z" }],
  },
  stats: {},
  glucoseStats: {},
  glucoseRanges: {},
  glucoseClinical: computeGlucoseClinicalMetrics([], { now: FIXED_NOW }),
  glucoseUnit: "mg/dL",
  bmi: 24.1,
  compliance: {},
  medications: [{ name: "Example Drug", dose: "5mg", schedules: [] }],
  medicationAdministrations: [
    {
      medicationName: "Example Drug",
      effectiveAt: "2026-04-30T08:00:00.000Z",
      status: "completed",
      doseText: "5mg",
      dose: { value: 5, unit: "mg" },
      injectionSite: null,
      atcCode: null,
      rxNormCode: null,
      deliveryForm: "ORAL",
    },
  ],
  illnessEpisodes: [
    {
      label: "Erkältung",
      type: "INFECTION",
      lifecycle: "ACUTE",
      onsetAt: "2026-04-01T00:00:00.000Z",
      resolvedAt: "2026-04-10T00:00:00.000Z",
    },
  ],
  cycle: {
    lastPeriodStart: "2026-04-20",
    recentCycles: [],
    observedCycleCount: 3,
    averageCycleLengthDays: 27.5,
    cycleLengthVariabilityDays: 0.5,
    averagePeriodLengthDays: 5,
    currentPhase: "LUTEAL",
  },
  mood: { avg: 3.8, count: 20 },
  glp1: null,
} as unknown as DoctorReportData;

const RECORDS = {
  allergies: [
    {
      id: "a1",
      substance: "Penicillin",
      category: "MEDICATION",
      type: "ALLERGY",
      status: "ACTIVE",
      severity: "SEVERE",
      reaction: "Rash",
      onsetAt: null,
      note: null,
    },
  ],
  familyHistory: [
    {
      id: "f1",
      relationship: "MOTHER",
      condition: "Hypertension",
      ageAtOnset: 50,
      note: null,
    },
  ],
} as never;

function req(pathname: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    count: 1,
    resetAt: Date.now(),
  } as never);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true });
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(loadFhirContext).mockResolvedValue({
    data: DATA,
    identity: { insuranceNumber: "A123456780" },
    germanAtc: false,
    records: RECORDS,
  });
});

interface CapabilityStatement {
  resourceType: string;
  implementation?: { description: string; url: string };
  software?: { name: string; version: string };
  description?: string;
  rest: Array<{
    resource: Array<{
      type: string;
      interaction?: Array<{ code: string }>;
      operation?: Array<{ name: string }>;
    }>;
  }>;
}

describe("GET /api/fhir/metadata — CapabilityStatement", () => {
  it("describes the instance it speaks for (cpb-2)", async () => {
    const res = await metadataGet(req("/api/fhir/metadata"));
    const body = (await res.json()) as CapabilityStatement;
    expect(body.resourceType).toBe("CapabilityStatement");
    expect(body.description?.length).toBeGreaterThan(0);
    expect(body.software?.name).toBe("HealthLog");
    expect(body.software?.version.length).toBeGreaterThan(0);
    expect(body.implementation?.description.length).toBeGreaterThan(0);
    expect(body.implementation?.url).toBe("http://localhost/api/fhir");
  });

  it("describes Patient exactly once, carrying the operation (cpb-9)", async () => {
    const res = await metadataGet(req("/api/fhir/metadata"));
    const body = (await res.json()) as CapabilityStatement;
    const resources = body.rest[0].resource;
    const types = resources.map((r) => r.type);
    expect(types.filter((t) => t === "Patient")).toHaveLength(1);
    expect(new Set(types).size).toBe(types.length);
    const patient = resources.find((r) => r.type === "Patient");
    expect(patient?.operation?.[0].name).toBe("everything");
    expect(patient?.interaction?.map((i) => i.code)).toEqual([
      "read",
      "search-type",
    ]);
  });

  it("advertises no interaction without a route behind it", async () => {
    const res = await metadataGet(req("/api/fhir/metadata"));
    const body = (await res.json()) as CapabilityStatement;
    const root = path.join(process.cwd(), "src/app/api/fhir");

    for (const resource of body.rest[0].resource) {
      for (const { code } of resource.interaction ?? []) {
        const file =
          code === "read"
            ? path.join(root, resource.type, "[id]", "route.ts")
            : path.join(root, resource.type, "route.ts");
        expect(existsSync(file), `${resource.type} ${code} → ${file}`).toBe(
          true,
        );
      }
      for (const { name } of resource.operation ?? []) {
        const file = path.join(root, resource.type, `$${name}`, "route.ts");
        expect(existsSync(file), `${resource.type} $${name} → ${file}`).toBe(
          true,
        );
      }
    }
    // …and the catalogue the statement derives from is the routed set.
    expect(body.rest[0].resource.map((r) => r.type)).toEqual([
      ...FHIR_REST_RESOURCE_TYPES,
    ]);
  });

  it("advertises no write interaction", async () => {
    const res = await metadataGet(req("/api/fhir/metadata"));
    const body = (await res.json()) as CapabilityStatement;
    const codes = body.rest[0].resource.flatMap((r) =>
      (r.interaction ?? []).map((i) => i.code),
    );
    for (const code of codes) {
      expect(["read", "search-type"]).toContain(code);
    }
  });
});

describe("GET /api/fhir/{type}/{id} — read", () => {
  it("serves the resource the searchset fullUrl points at", async () => {
    const res = await observationRead(req("/api/fhir/Observation/obs-1"), {
      params: Promise.resolve({ id: "obs-1" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/fhir+json");
    const body = (await res.json()) as { resourceType: string; id: string };
    expect(body.resourceType).toBe("Observation");
    expect(body.id).toBe("obs-1");
  });

  it("answers an id the record does not hold with a not-found OperationOutcome", async () => {
    const res = await observationRead(req("/api/fhir/Observation/obs-999"), {
      params: Promise.resolve({ id: "obs-999" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      resourceType: string;
      issue: Array<{ code: string }>;
    };
    expect(body.resourceType).toBe("OperationOutcome");
    expect(body.issue[0].code).toBe("not-found");
  });

  it("reads the Patient", async () => {
    const res = await patientRead(req("/api/fhir/Patient/patient-1"), {
      params: Promise.resolve({ id: "patient-1" }),
    });
    const body = (await res.json()) as { resourceType: string };
    expect(body.resourceType).toBe("Patient");
  });

  it("reads the Coverage", async () => {
    const res = await coverageRead(req("/api/fhir/Coverage/coverage-1"), {
      params: Promise.resolve({ id: "coverage-1" }),
    });
    const body = (await res.json()) as { resourceType: string };
    expect(body.resourceType).toBe("Coverage");
  });
});

describe("GET /api/fhir/Patient/$everything", () => {
  it("returns every resource family the document bundle carries", async () => {
    const res = await everythingGet(
      req("/api/fhir/Patient/$everything?_count=200"),
    );
    expect(res.status).toBe(200);
    const bundle = (await res.json()) as {
      type: string;
      total: number;
      entry: Array<{ fullUrl: string; resource: { resourceType: string } }>;
    };
    expect(bundle.type).toBe("searchset");

    const document = buildFhirDocumentBundle(
      DATA,
      { insuranceNumber: "A123456780" },
      FIXED_NOW,
      { germanAtc: false },
      RECORDS,
    );
    const expected = new Set(
      document.entry.map((e) => e.resource.resourceType),
    );
    const served = new Set(bundle.entry.map((e) => e.resource.resourceType));
    expect(served).toEqual(expected);
    expect(bundle.total).toBe(document.entry.length);

    // The families the operation used to drop.
    for (const type of [
      "Composition",
      "Device",
      "Condition",
      "Encounter",
      "AllergyIntolerance",
      "FamilyMemberHistory",
      "DiagnosticReport",
      "Coverage",
    ]) {
      expect(served.has(type), `missing ${type}`).toBe(true);
    }
    // …including the cycle Observations, which share a resourceType with the
    // vitals and would hide inside the set check above.
    const ids = bundle.entry.map(
      (e) => (e.resource as unknown as { id: string }).id,
    );
    expect(ids.some((id) => id.startsWith("obs-cycle-"))).toBe(true);
  });

  it("keeps the entry identities the references resolve against", async () => {
    const res = await everythingGet(
      req("/api/fhir/Patient/$everything?_count=200"),
    );
    const bundle = (await res.json()) as {
      entry: Array<{
        fullUrl: string;
        search: { mode: string };
        resource: { subject?: { reference?: string } };
      }>;
    };
    const urls = new Set(bundle.entry.map((e) => e.fullUrl));
    for (const entry of bundle.entry) {
      expect(entry.fullUrl.startsWith("urn:uuid:")).toBe(true);
      expect(entry.search.mode).toBe("match");
      const subject = entry.resource.subject?.reference;
      if (subject) expect(urls.has(subject)).toBe(true);
    }
  });
});
