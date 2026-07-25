/**
 * v1.11.0 (Epic C, C8) — clinician-view scoped data load guarantees.
 *
 * The public clinician view aggregates ONLY the data the owner froze into the
 * link, and it must NEVER surface the insurance number (KVNR). KVNR is
 * default-OFF by construction: `loadShareViewData` calls the doctor-report
 * aggregator with the frozen window + section toggles and nothing else — no
 * identifier opt-in, no decrypt path. This test pins that contract so a future
 * change can't silently widen the clinician view to leak the KVNR.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/modules/gate", () => ({
  isModuleEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/doctor-report-data", () => ({
  collectDoctorReportData: vi.fn(),
}));
// The real prefs parser is used so the "no section enabled ⇒ documents-only"
// signal is exercised end to end (a stubbed parser would let the test lie
// about which sectionsJson resolves to an empty report scope).
vi.mock("@/lib/db", () => ({
  prisma: {
    clinicianShareLinkDocument: { findMany: vi.fn() },
  },
}));

import { loadShareViewData } from "../share-view-data";
import { isModuleEnabled } from "@/lib/modules/gate";
import { collectDoctorReportData } from "@/lib/doctor-report-data";
import { EMPTY_DOCTOR_REPORT_PREFS } from "@/lib/validations/doctor-report-prefs";
import { prisma } from "@/lib/db";
import type { ShareContext } from "../resolve-share-token";

const collect = collectDoctorReportData as ReturnType<typeof vi.fn>;
const findDocs = prisma.clinicianShareLinkDocument.findMany as ReturnType<
  typeof vi.fn
>;

function ctx(overrides: Partial<ShareContext> = {}): ShareContext {
  return {
    shareLinkId: "link-1",
    ownerUserId: "owner-1",
    label: "Clinic",
    rangeStart: new Date("2026-01-01T00:00:00Z"),
    rangeEnd: new Date("2026-02-01T00:00:00Z"),
    sectionsJson: { mood: false },
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  } as ShareContext;
}

describe("loadShareViewData — KVNR default OFF", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({
      patient: { displayName: "Shared record" },
    });
    findDocs.mockResolvedValue([]);
  });

  it("scopes the aggregator to the OWNER from the share context, never the wire", async () => {
    await loadShareViewData(ctx());
    expect(collect).toHaveBeenCalledTimes(1);
    expect(collect.mock.calls[0]![0]).toBe("owner-1");
  });

  it("never requests an identifier / KVNR opt-in from the aggregator", async () => {
    await loadShareViewData(ctx());
    const opts = collect.mock.calls[0]![2] as Record<string, unknown>;
    // The only option ever passed is the frozen section toggles — no
    // includeIdentifiers, no kvnr, no decrypt flag. Default-OFF by absence.
    expect(opts).toBeDefined();
    expect(opts).not.toHaveProperty("includeIdentifiers");
    expect(opts).not.toHaveProperty("kvnr");
    expect(opts).not.toHaveProperty("insuranceNumber");
    expect(Object.keys(opts)).toEqual(["sections"]);
  });

  it("returns a report payload carrying no insurance number", async () => {
    const { report } = await loadShareViewData(ctx());
    const patient = (report as { patient?: Record<string, unknown> }).patient;
    expect(patient).not.toHaveProperty("insuranceNumber");
    expect(patient).not.toHaveProperty("kvnr");
  });

  it("lists the frozen document set as metadata only (never bytes)", async () => {
    findDocs.mockResolvedValue([
      {
        document: {
          id: "doc-a",
          title: "Blood panel",
          kind: "LAB_REPORT",
          documentDate: new Date("2026-01-15T00:00:00Z"),
          byteSize: 12345,
          mimeType: "application/pdf",
        },
      },
      {
        document: {
          id: "doc-b",
          title: null,
          kind: "OTHER",
          documentDate: null,
          byteSize: 6789,
          mimeType: "application/msword",
        },
      },
    ]);

    const { documents } = await loadShareViewData(ctx());

    // Scoped to THIS link + owner + live rows; the blob column is never named.
    const arg = findDocs.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      select: { document: { select: Record<string, boolean> } };
    };
    expect(arg.where).toEqual({
      shareLinkId: "link-1",
      document: { userId: "owner-1", deletedAt: null },
    });
    expect(arg.select.document.select).not.toHaveProperty("contentEncrypted");

    expect(documents).toEqual([
      {
        id: "doc-a",
        title: "Blood panel",
        kind: "LAB_REPORT",
        documentDate: "2026-01-15",
        byteSize: 12345,
        mimeType: "application/pdf",
        servingClass: "inline",
      },
      {
        id: "doc-b",
        title: null,
        kind: "OTHER",
        documentDate: null,
        byteSize: 6789,
        mimeType: "application/msword",
        servingClass: "attachment",
      },
    ]);
  });

  it("uses the frozen rangeStart and resolves a rolling rangeEnd to now", async () => {
    const now = Date.now();
    await loadShareViewData(ctx({ rangeEnd: null }));
    const range = collect.mock.calls[0]![1] as {
      start: Date;
      end: Date;
      days: number;
    };
    expect(range.start.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    // Rolling end materialises near "now", never before the frozen start.
    expect(range.end.getTime()).toBeGreaterThanOrEqual(now - 5_000);
    expect(range.days).toBeGreaterThan(0);
  });
});

/**
 * The load-bearing privacy guarantee: a documents-only share (every report
 * section OFF) serves ZERO health metrics. The doctor-report aggregator is
 * never called, so no vital / lab / medication / wellness figure ever leaves
 * the database — the recipient sees only the attached document(s). "Share this
 * document" means the document, not the whole record.
 */
describe("loadShareViewData — documents-only share exposes no health data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);
  });

  it("never aggregates a report and returns report=null when no section is enabled", async () => {
    findDocs.mockResolvedValue([
      {
        document: {
          id: "doc-a",
          title: "Blood panel",
          kind: "LAB_REPORT",
          documentDate: new Date("2026-01-15T00:00:00Z"),
          byteSize: 12345,
          mimeType: "application/pdf",
        },
      },
    ]);

    const { report, documentOnly, documents } = await loadShareViewData(
      ctx({ sectionsJson: EMPTY_DOCTOR_REPORT_PREFS }),
    );

    // The one guarantee: the aggregator is NEVER invoked — no health data is
    // read from the DB, let alone served.
    expect(collect).not.toHaveBeenCalled();
    expect(report).toBeNull();
    expect(documentOnly).toBe(true);

    // The attached document is still surfaced (metadata only, never bytes).
    expect(documents).toEqual([
      {
        id: "doc-a",
        title: "Blood panel",
        kind: "LAB_REPORT",
        documentDate: "2026-01-15",
        byteSize: 12345,
        mimeType: "application/pdf",
        servingClass: "inline",
      },
    ]);
  });

  it("still aggregates for a record share (defaults resolve to an enabled scope)", async () => {
    // `{}` / null sections resolve to the documented defaults (a full record
    // share), so the aggregator DOES run — the empty-scope short-circuit must
    // not swallow a normal record share.
    const { report, documentOnly } = await loadShareViewData(
      ctx({ sectionsJson: {}, documentOnly: false }),
    );
    expect(collect).toHaveBeenCalledTimes(1);
    expect(documentOnly).toBe(false);
    expect(report).not.toBeNull();
  });
});

/**
 * v1.28.16 — the frozen `documentOnly` COLUMN is authoritative. Once a link is
 * created documents-only, it stays documents-only regardless of what the report
 * sections resolve to — so a report section added to the prefs shape LATER can
 * never re-open an existing documents-only link. The legacy fallback (derive
 * from "all sections off") still holds for pre-column links where the flag is
 * false.
 */
describe("loadShareViewData — documentOnly column is authoritative", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);
  });

  it("serves no report when the column is set, even if sections would aggregate", async () => {
    // Sections that resolve to an ENABLED scope (defaults) — the derived check
    // alone would run the aggregator. The frozen column must veto it. This is
    // the exact future-leak the column closes: a new section defaulting on can
    // no longer widen an old documents-only link.
    const { report, documentOnly } = await loadShareViewData(
      ctx({ sectionsJson: { bp: true }, documentOnly: true }),
    );
    expect(collect).not.toHaveBeenCalled();
    expect(report).toBeNull();
    expect(documentOnly).toBe(true);
  });

  it("falls back to the derived all-off check for a legacy link (column false)", async () => {
    // A pre-column documents-only link reads `documentOnly:false` from the row
    // but still has every section off — the derived fallback keeps it closed.
    const { report, documentOnly } = await loadShareViewData(
      ctx({ sectionsJson: EMPTY_DOCTOR_REPORT_PREFS, documentOnly: false }),
    );
    expect(collect).not.toHaveBeenCalled();
    expect(report).toBeNull();
    expect(documentOnly).toBe(true);
  });
});

/**
 * v1.28.17 — the create schema accepts the GROUPED export sections shape
 * (`{ vitals: { bp, weight, … }, activity: { sleep }, medications: { … } }`)
 * and persists it raw. The clinician-view loader MUST fold that grouped shape
 * down to the flat toggles the aggregator consumes — reading it through the
 * flat doctor-report parser silently drops every grouped toggle and re-defaults
 * the section back ON, re-widening a scope the owner explicitly narrowed. This
 * pins that a section switched OFF in the grouped shape reaches the aggregator
 * as OFF, not as a defaults-on leak.
 */
describe("loadShareViewData — grouped sections are folded, not silently defaulted", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);
  });

  it("honours grouped OFF toggles instead of falling back to defaults-ON", async () => {
    // Owner froze a labs-focused share: vitals OFF, but the grouped keys live
    // under `vitals` where the flat parser cannot see them. Pre-fix, bp/weight/
    // pulse resolved to the defaults (ON) and leaked to the clinician.
    await loadShareViewData(
      ctx({
        sectionsJson: {
          vitals: { bp: false, weight: false, pulse: false },
          activity: { sleep: false },
          labs: true,
        },
        documentOnly: false,
      }),
    );

    expect(collect).toHaveBeenCalledTimes(1);
    const opts = collect.mock.calls[0]![2] as {
      sections: Record<string, boolean>;
    };
    // The grouped OFF toggles must survive the fold.
    expect(opts.sections.bp).toBe(false);
    expect(opts.sections.weight).toBe(false);
    expect(opts.sections.pulse).toBe(false);
    expect(opts.sections.sleep).toBe(false);
    // A toggle the owner left ON stays ON.
    expect(opts.sections.labs).toBe(true);
  });

  it("folds a grouped glucose=OFF toggle down to sections.glucose=false", async () => {
    // A diabetic owner withholds glucose from THIS share without disabling the
    // glucose module app-wide. The grouped `glucose` toggle must survive the
    // fold and reach the aggregator so no glucose panel is built.
    await loadShareViewData(
      ctx({
        sectionsJson: {
          vitals: { bp: true },
          glucose: false,
        },
        documentOnly: false,
      }),
    );
    const opts = collect.mock.calls[0]![2] as {
      sections: Record<string, boolean>;
    };
    expect(opts.sections.glucose).toBe(false);
    // A share that leaves glucose unspecified keeps the default-ON behaviour.
    vi.clearAllMocks();
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);
    await loadShareViewData(
      ctx({ sectionsJson: { vitals: { bp: true } }, documentOnly: false }),
    );
    const opts2 = collect.mock.calls[0]![2] as {
      sections: Record<string, boolean>;
    };
    expect(opts2.sections.glucose).toBe(true);
  });

  it("still resolves a flat legacy blob through the flat parser unchanged", async () => {
    // A flat shape has no grouped-only key, so it keeps the exact legacy path.
    await loadShareViewData(
      ctx({ sectionsJson: { bp: false, mood: true }, documentOnly: false }),
    );
    const opts = collect.mock.calls[0]![2] as {
      sections: Record<string, boolean>;
    };
    expect(opts.sections.bp).toBe(false);
    expect(opts.sections.mood).toBe(true);
    // Unspecified flat keys fall back to the documented defaults.
    expect(opts.sections.weight).toBe(true);
  });
});

/**
 * v1.30.22 — the owner's `doctorReport` module gates this surface too.
 *
 * Found while tracing every caller of the whole-record aggregate for the MCP
 * fix: this link serves that same payload to an unauthenticated third party
 * and never consulted the module key, so an owner (or an operator, via the
 * availability switch ANDed above the user toggle) who turned the module off
 * still had the full record served.
 *
 * Degrades to the share's OWN documents-only state rather than throwing:
 * `documentOnly` is an existing, load-bearing privacy mode here (report
 * `null`, aggregator never called), so a disabled module collapses the link to
 * exactly the documents the owner attached — fail-closed for the health record
 * without 500-ing a public link.
 */
describe("clinician share — owner doctorReport module gate", () => {
  beforeEach(() => {
    // Sibling of the suite above, so the outer reset does not reach here.
    vi.clearAllMocks();
    vi.mocked(isModuleEnabled).mockImplementation(async () => true);
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
  });

  it("aggregates normally with the module on", async () => {
    collect.mockResolvedValue({ patient: { displayName: "Shared record" } });
    findDocs.mockResolvedValue([]);

    const res = await loadShareViewData(
      ctx({ sectionsJson: { bp: true }, documentOnly: false }),
    );

    expect(res.documentOnly).toBe(false);
    expect(res.report).not.toBeNull();
    expect(collect).toHaveBeenCalled();
  });

  it("collapses to documents-only with the module off", async () => {
    vi.mocked(isModuleEnabled).mockImplementation(async () => false);
    findDocs.mockResolvedValue([]);

    const res = await loadShareViewData(
      ctx({ sectionsJson: { bp: true }, documentOnly: false }),
    );

    expect(res.documentOnly).toBe(true);
    expect(res.report).toBeNull();
    // Load-bearing: the aggregator is never called, so no health data leaves
    // the DB at all — not built-then-withheld.
    expect(collect).not.toHaveBeenCalled();
  });

  it("gates on the OWNER's module state, not a viewer's", async () => {
    // The link is public; there is no viewer session. The owner id must come
    // from the frozen share context.
    findDocs.mockResolvedValue([]);
    await loadShareViewData(
      ctx({ sectionsJson: { bp: true }, documentOnly: false }),
    );
    expect(isModuleEnabled).toHaveBeenCalledWith("owner-1", "doctorReport");
  });

  it("closes the operator kill-switch path too", async () => {
    vi.mocked(isModuleEnabled).mockImplementation(
      async (_u: string, key: string) => key !== "doctorReport",
    );
    findDocs.mockResolvedValue([]);

    const res = await loadShareViewData(
      ctx({ sectionsJson: { bp: true }, documentOnly: false }),
    );

    expect(res.documentOnly).toBe(true);
    expect(collect).not.toHaveBeenCalled();
  });
});
