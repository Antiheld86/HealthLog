/**
 * v1.7.0 — POST /api/export/health-record unit coverage.
 *
 * Mock-based (no testcontainers): pins the route contract — strict Zod
 * rejection paths (422 via returnAllZodIssues), rate-limit (429), the
 * three format outputs (PDF magic bytes, application/fhir+json valid
 * Bundle, application/zip), and that the user is narrowed from the
 * session (never the body).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PDFParse } from "pdf-parse";

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: vi.fn() },
    medication: { findMany: vi.fn() },
    medicationIntakeEvent: { findMany: vi.fn() },
    moodEntry: { findMany: vi.fn() },
    labResult: { findMany: vi.fn() },
    illnessEpisode: { findMany: vi.fn() },
    allergy: { findMany: vi.fn() },
    familyHistoryEntry: { findMany: vi.fn() },
    user: { findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/geo", () => ({ lookupIpLocation: vi.fn() }));
vi.mock("@/lib/logging/transports", () => ({ emitStructuredLog: vi.fn() }));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn().mockResolvedValue("Europe/Berlin"),
}));

// v1.18.0 — the health-record aggregator resolves the per-user module map
// so a disabled data-domain module never reaches the export. Stub the gate
// to "all modules enabled" (an empty map ⇒ default-on) so these pre-existing
// route tests don't stand up the real gate's DB reads.
vi.mock("@/lib/modules/gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/modules/gate")>();
  return {
    ...actual,
    resolveModuleMap: vi.fn(),
    isModuleEnabled: vi.fn(),
    requireModuleEnabled: vi.fn(),
  };
});

import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import {
  resolveModuleMap,
  isModuleEnabled,
  requireModuleEnabled,
} from "@/lib/modules/gate";

const SESSION_OK = {
  user: { id: "user-1", email: "test@example.com", role: "USER" },
} as const;

function mkReq(
  body: unknown,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest("http://localhost/api/export/health-record", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function pdfText(res: Response): Promise<string> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const parser = new PDFParse({ data: bytes });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveModuleMap).mockResolvedValue({} as never);
  vi.mocked(isModuleEnabled).mockResolvedValue(true);
  vi.mocked(requireModuleEnabled).mockResolvedValue({ enabled: true } as never);
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(checkRateLimit).mockResolvedValue({
    allowed: true,
    remaining: 9,
    resetAt: Date.now() + 3_600_000,
  } as never);
  vi.mocked(prisma.measurement.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medication.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.medicationIntakeEvent.findMany).mockResolvedValue(
    [] as never,
  );
  vi.mocked(prisma.moodEntry.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.labResult.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.illnessEpisode.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.allergy.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.familyHistoryEntry.findMany).mockResolvedValue([] as never);
  // First findUnique = aggregator profile select; second = route KVNR select.
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    username: "sample",
    dateOfBirth: null,
    gender: null,
    heightCm: null,
    glucoseUnit: null,
    thresholdsJson: null,
    fullName: null,
    insurerName: null,
    insuranceNumberEncrypted: null,
    insightsCachedText: null,
  } as never);
});

describe("POST /api/export/health-record — validation", () => {
  it("rejects an unknown format with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "xml" }));
    expect(res.status).toBe(422);
  });

  it("rejects a missing format with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({}));
    expect(res.status).toBe(422);
  });

  it("rejects a userId smuggled into the body with 422", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "pdf", userId: "user-2" }));
    expect(res.status).toBe(422);
  });

  it("returns 403 when the doctorReport module is disabled (B3 gate)", async () => {
    const { apiError } = await import("@/lib/api-response");
    vi.mocked(requireModuleEnabled).mockResolvedValue({
      enabled: false,
      response: apiError('Module "doctorReport" is not enabled', 403, {
        errorCode: "module.disabled",
        module: "doctorReport",
      }),
    } as never);
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir" }));
    expect(res.status).toBe(403);
    expect(requireModuleEnabled).toHaveBeenCalledWith("user-1", "doctorReport");
  });

  it("returns 429 when the export rate limit is exhausted", async () => {
    vi.mocked(checkRateLimit).mockResolvedValue({
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + 3_600_000,
    } as never);
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir" }));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/export/health-record — outputs", () => {
  it("format=fhir returns a valid FHIR document Bundle", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "fhir" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/fhir+json");
    const bundle = await res.json();
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("document");
    expect(bundle.entry[0].resource.resourceType).toBe("Composition");
  });

  it("format=pdf returns a PDF with the %PDF- magic bytes", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "pdf" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("format=package returns a zip", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "package" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const buf = Buffer.from(await res.arrayBuffer());
    // ZIP local-file-header magic: PK\x03\x04
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("renders the PDF in the explicit selection locale", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({ format: "pdf", locale: "de", practiceName: "Sample Practice" }),
    );
    const text = await pdfText(res);
    // German cover label.
    expect(text).toContain("Praxis:");
  });

  it("falls back to the healthlog-locale cookie when no locale is sent", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq(
        { format: "pdf", practiceName: "Sample Practice" },
        {
          // Browser default English, but the in-app cookie says German — the
          // cookie must win over Accept-Language.
          "accept-language": "en-US,en;q=0.9",
          cookie: "healthlog-locale=de",
        },
      ),
    );
    const text = await pdfText(res);
    expect(text).toContain("Praxis:");
    expect(text).not.toContain("Practice:");
  });

  it("uses Accept-Language only when neither selection nor cookie is present", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq(
        { format: "pdf", practiceName: "Sample Practice" },
        { "accept-language": "en-US,en;q=0.9" },
      ),
    );
    const text = await pdfText(res);
    expect(text).toContain("Practice:");
  });

  it("scopes the aggregator measurement read to the session user", async () => {
    const { POST } = await import("../route");
    await POST(mkReq({ format: "fhir", userId: "user-2" } as never));
    // userId smuggle is rejected above; here we confirm the read uses the
    // session user, not anything from the body, for a clean payload.
    await POST(mkReq({ format: "fhir" }));
    expect(prisma.measurement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1", deletedAt: null }),
      }),
    );
  });
});

/**
 * The practice name is a remembered preference (`User.lastReportPracticeName`),
 * so a monthly report does not ask for the clinic name again every time. The
 * write happens only once the artefact exists — a generation that throws must
 * not overwrite the remembered value with a half-typed one.
 *
 * Mutation check: drop the `rememberPracticeName` call in the route and the
 * first two cases go red; move it above the generation and the
 * failed-generation case goes red.
 */
describe("POST /api/export/health-record — remembered practice name", () => {
  it("persists the sanitised practice name after a PDF export", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({ format: "pdf", practiceName: "  Sample   Practice  " }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { lastReportPracticeName: "Sample Practice" },
    });
  });

  it("persists the practice name after a FHIR export", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({ format: "fhir", practiceName: "Sample Practice" }),
    );
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { lastReportPracticeName: "Sample Practice" },
    });
  });

  it("persists null when the user cleared the practice name", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "pdf" }));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { lastReportPracticeName: null },
    });
  });

  it("writes nothing when the selection is rejected", async () => {
    const { POST } = await import("../route");
    const res = await POST(mkReq({ format: "xml", practiceName: "Sample" }));
    expect(res.status).toBe(422);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("writes nothing when the generation fails", async () => {
    vi.mocked(prisma.measurement.findMany).mockRejectedValue(
      new Error("read failed"),
    );
    const { POST } = await import("../route");
    const res = await POST(
      mkReq({ format: "pdf", practiceName: "Sample Practice" }),
    );
    expect(res.status).toBe(500);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("narrows the update to the session user, never the body", async () => {
    const { POST } = await import("../route");
    await POST(mkReq({ format: "fhir", practiceName: "Sample Practice" }));
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "user-1" } }),
    );
  });
});
