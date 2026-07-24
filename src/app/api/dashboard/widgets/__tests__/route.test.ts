/**
 * v1.4.42 W2 — multi-issue 422 envelope on PUT.
 *
 * Until v1.4.41 this route returned `parsed.error.issues[0].message`,
 * which dropped every issue past the first. iOS contract debugging
 * needed one round-trip per wrong field. The route now returns every
 * issue under `details.issues` AND writes a
 * `dashboard.widgets.validation-failed` audit-ledger row so the
 * operator can grep `/api/admin/audit` for the same trail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
      // v1.32.16 (issue #581) — the guarded optimistic-concurrency write.
      updateMany: vi.fn(),
    },
    auditLog: {
      create: vi.fn(),
    },
  },
  toJson: (v: unknown) => v,
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: vi.fn(),
}));

vi.mock("@/lib/logging/transports", () => ({
  emitIfSampled: vi.fn(),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/logging/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging/context")>();
  return {
    ...actual,
    annotate: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { GET, PUT, __resetAuditDedupMemoForTests } from "../route";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { annotate } from "@/lib/logging/context";
import { __resetAllCachesForTests } from "@/lib/cache/server-cache";
import {
  DASHBOARD_WIDGET_IDS,
  DASHBOARD_IOS_ONLY_WIDGET_IDS,
  DASHBOARD_WIDGET_CATALOGUE_IDS,
  DEFAULT_DASHBOARD_LAYOUT,
  serializeDashboardLayout,
  // v1.32.1 — the exact payload builder `ringMutation.mutationFn` calls
  // (see the settings component). Importing the shipped function rather
  // than re-implementing its shape means this test exercises the REAL
  // client contract against the REAL route, not a hand-rolled stand-in.
  buildRingMutationPayload,
  type DashboardLayout,
} from "@/lib/dashboard-layout";

const SESSION_OK = {
  session: { id: "sess-1", expiresAt: new Date(Date.now() + 3_600_000) },
  user: {
    id: "user-1",
    username: "tester",
    role: "USER" as const,
    displayName: null,
  },
};

const callPut = PUT as unknown as (req: NextRequest) => Promise<Response>;

function makeReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/dashboard/widgets", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  __resetAllCachesForTests();
  __resetAuditDedupMemoForTests();
  vi.mocked(getSession).mockResolvedValue(SESSION_OK as never);
  vi.mocked(prisma.auditLog.create).mockResolvedValue({} as never);
});

describe("PUT /api/dashboard/widgets — 422 multi-issue envelope (v1.4.42 W2)", () => {
  it("surfaces TWO simultaneous validation errors under details.issues", async () => {
    // version=2 (literal mismatch) + widgets=[] (min(1) violation).
    const res = await callPut(makeReq({ version: 2, widgets: [] }));
    expect(res.status).toBe(422);

    const body = (await res.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{ path: string; code: string; message: string }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues.length).toBe(2);
    const paths = body.details.issues.map((i) => i.path).sort();
    expect(paths).toEqual(["version", "widgets"]);

    // Every issue carries exactly path / code / message — issue.params
    // never leaks (it may echo the offending user input for some codes).
    for (const issue of body.details.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("surfaces THREE simultaneous validation errors", async () => {
    const res = await callPut(
      makeReq({
        version: 99,
        widgets: [],
        comparisonBaseline: "tomorrow",
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<{ path: string; code: string }> };
    };
    expect(body.details.issues.length).toBe(3);
    const paths = body.details.issues.map((i) => i.path).sort();
    expect(paths).toEqual(["comparisonBaseline", "version", "widgets"]);
  });

  it("writes one audit-ledger row keyed dashboard.widgets.validation-failed", async () => {
    const res = await callPut(makeReq({ version: 2, widgets: [] }));
    expect(res.status).toBe(422);

    // The audit row is fire-and-forget — let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 5));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { userId: string; action: string; details: string };
    };
    expect(call.data.userId).toBe("user-1");
    expect(call.data.action).toBe("dashboard.widgets.validation-failed");
    const details = JSON.parse(call.data.details) as {
      issues: Array<{ path: string; code: string }>;
    };
    expect(details.issues.length).toBe(2);
    for (const issue of details.issues) {
      // v1.4.49 — audit row is the persisted surface. `message`
      // strips here so a future Zod code that embeds the offending
      // value cannot leak into the ledger.
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });

  it("dedups the audit-ledger write across two sequential 422s for the same user (v1.4.43 B2)", async () => {
    // First 422 writes one row; the second 422 inside the 60 s window
    // returns the same envelope but skips the audit insert.
    const res1 = await callPut(makeReq({ version: 2, widgets: [] }));
    expect(res1.status).toBe(422);
    const res2 = await callPut(makeReq({ version: 2, widgets: [] }));
    expect(res2.status).toBe(422);

    await new Promise((r) => setTimeout(r, 5));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);

    // The full multi-issue envelope still rides on every 422 — the
    // dedup only suppresses the breadcrumb write, never the response.
    const body2 = (await res2.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body2.details.issues.length).toBe(2);
  });

  it("surfaces received_keys + received_shape_excerpt + zod_issues in the wide-event meta (v1.4.48 H-iOS-1)", async () => {
    const payload = { version: 2, widgets: [], extraGarbage: "from-ios" };
    const res = await callPut(makeReq(payload));
    expect(res.status).toBe(422);

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "dashboard.widgets.validation-failed",
      );
    expect(annotated, "validation-failed annotate call").toBeTruthy();
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;

    // Top-level keys mirror the iOS-sent payload (NOT the schema keys).
    expect(meta.received_keys).toEqual(
      expect.arrayContaining(["version", "widgets", "extraGarbage"]),
    );

    // Excerpt is a JSON-stringified prefix, hard-capped at 256 chars.
    expect(typeof meta.received_shape_excerpt).toBe("string");
    expect((meta.received_shape_excerpt as string).length).toBeLessThanOrEqual(
      256,
    );
    expect(meta.received_shape_excerpt as string).toContain('"version":2');

    // zod_issues is the same sanitised array surfaced under details.issues.
    const issues = meta.zod_issues as Array<{ path: string; code: string }>;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
    }
  });

  it("caps received_shape_excerpt at 256 chars even for a large iOS payload", async () => {
    // v1.7.0 #9 — unknown ids are now filtered out before Zod, so use a
    // KNOWN id (survives the filter) with an out-of-range `order` (>99)
    // and a long label to keep the payload large AND failing validation.
    const widgets = Array.from({ length: 30 }, (_, i) => ({
      id: DASHBOARD_WIDGET_IDS[0],
      visible: true,
      order: 999 + i,
      label: `${"x".repeat(20)}-${i}`,
    }));
    const res = await callPut(makeReq({ version: 99, widgets }));
    expect(res.status).toBe(422);

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "dashboard.widgets.validation-failed",
      );
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;
    expect((meta.received_shape_excerpt as string).length).toBe(256);
  });

  it("does not block the 422 response when the audit-row write rejects", async () => {
    vi.mocked(prisma.auditLog.create).mockRejectedValueOnce(
      new Error("db down"),
    );

    const res = await callPut(makeReq({ version: 2, widgets: [] }));
    // The response is the contract — the audit row is best-effort.
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      details: { issues: Array<unknown> };
    };
    expect(body.details.issues.length).toBe(2);
  });

  it("redacts sensitive keys before writing the wide-event received_shape_excerpt (v1.4.49)", async () => {
    // Caller adds a credential-shaped field — must not land in the
    // wide-event excerpt verbatim. The denylist also covers nested
    // members so `payload.apiKey` is redacted, while `version` /
    // `widgets` stay readable for operator debug.
    const payload = {
      version: 2,
      widgets: [],
      apnsToken: "ff".repeat(32),
      authorization: "Bearer leaked",
      payload: { apiKey: "sk_live_xxx" },
    };
    const res = await callPut(makeReq(payload));
    expect(res.status).toBe(422);

    const annotated = vi
      .mocked(annotate)
      .mock.calls.find(
        (call) =>
          (call[0] as { action?: { name?: string } })?.action?.name ===
          "dashboard.widgets.validation-failed",
      );
    const meta = (annotated![0] as { meta?: Record<string, unknown> }).meta!;
    const excerpt = meta.received_shape_excerpt as string;

    // Sensitive values are never written into the excerpt.
    expect(excerpt).not.toContain("ff".repeat(32));
    expect(excerpt).not.toContain("Bearer leaked");
    expect(excerpt).not.toContain("sk_live_xxx");
    // The redactor leaves the literal sentinel behind so an operator
    // can still see the shape of the rejected payload.
    expect(excerpt).toContain("[redacted]");
    // Non-sensitive keys still surface for debugging.
    expect(meta.received_keys).toEqual(
      expect.arrayContaining([
        "version",
        "widgets",
        "apnsToken",
        "authorization",
        "payload",
      ]),
    );
  });

  it("strips `message` from the audit-ledger issues row (v1.4.49)", async () => {
    // The wide-event meta keeps full message for operator debugging,
    // but the persisted auditLog row must only carry `path` + `code`
    // so a future Zod code that embeds the offending value cannot
    // leak into the ledger.
    await callPut(makeReq({ version: 2, widgets: [] }));

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.auditLog.create).mock.calls[0]?.[0] as {
      data: { details: string };
    };
    const parsed = JSON.parse(call.data.details) as {
      issues: Array<Record<string, unknown>>;
    };
    for (const issue of parsed.issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
    }
  });
});

describe("PUT /api/dashboard/widgets — accept-and-ignore unknown ids (v1.7.0 #9)", () => {
  const knownId = DASHBOARD_WIDGET_IDS[0];

  it("persists known ids, drops unknown ids, returns 200, and annotates", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [
          { id: knownId, visible: true, order: 0 },
          { id: "ios-only-future-tile", visible: true, order: 1 },
        ],
      }),
    );
    expect(res.status).toBe(200);

    // The persisted blob never carries the unknown id.
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { widgets: Array<{ id: string }> } };
    };
    const persistedIds = updateArg.data.dashboardWidgetsJson.widgets.map(
      (w) => w.id,
    );
    expect(persistedIds).toContain(knownId);
    expect(persistedIds).not.toContain("ios-only-future-tile");

    // The drop is greppable via the annotation.
    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "dashboard.widgets.unknown-id-dropped" },
        meta: expect.objectContaining({
          dropped_ids: ["ios-only-future-tile"],
          dropped_count: 1,
        }),
      }),
    );
  });

  it("caps the logged dropped_ids array at 20 while keeping the full dropped_count (v1.7.0)", async () => {
    // A large all-unknown payload — the unknown-id filter runs before
    // Zod's `.max(20)`, so the wide-event line must not carry every id.
    const widgets = Array.from({ length: 200 }, (_, i) => ({
      id: `ios-unknown-${i}`,
      visible: true,
      order: i,
    }));

    const res = await callPut(makeReq({ version: 1, widgets }));
    // All widgets unknown → surviving array is empty → 422 (min 1). The
    // annotation fires regardless, before the Zod parse.
    expect(res.status).toBe(422);

    const dropAnnotate = vi
      .mocked(annotate)
      .mock.calls.find(
        (c) =>
          (c[0] as { action?: { name?: string } }).action?.name ===
          "dashboard.widgets.unknown-id-dropped",
      );
    expect(dropAnnotate, "unknown-id-dropped annotate call").toBeTruthy();
    const meta = (dropAnnotate![0] as { meta?: Record<string, unknown> }).meta!;
    expect(meta.dropped_count).toBe(200);
    expect((meta.dropped_ids as string[]).length).toBe(20);
  });

  it("still 422s when a surviving entry is malformed (missing order)", async () => {
    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [
          { id: knownId, visible: true }, // no `order`
          { id: "ios-only-future-tile", visible: true, order: 1 },
        ],
      }),
    );
    expect(res.status).toBe(422);
  });
});

const callGet = GET as unknown as () => Promise<Response>;

describe("dashboard widgets — 27-id catalogue round-trip (v1.7.0 W1)", () => {
  it("PUT of a full 27-id layout persists every id (iOS-only round-trip)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const widgets = DASHBOARD_WIDGET_CATALOGUE_IDS.map((id, i) => ({
      id,
      visible: true,
      tileVisible: true,
      order: i,
    }));
    const res = await callPut(makeReq({ version: 1, widgets }));
    expect(res.status).toBe(200);

    // No id was dropped — the unknown-id annotation must NOT fire.
    const dropAnnotate = vi
      .mocked(annotate)
      .mock.calls.find(
        (c) =>
          (c[0] as { action?: { name?: string } }).action?.name ===
          "dashboard.widgets.unknown-id-dropped",
      );
    expect(dropAnnotate).toBeUndefined();

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { widgets: Array<{ id: string }> } };
    };
    const persistedIds = updateArg.data.dashboardWidgetsJson.widgets.map(
      (w) => w.id,
    );
    expect(persistedIds.sort()).toEqual(
      [...DASHBOARD_WIDGET_CATALOGUE_IDS].sort(),
    );
    // The response body echoes the full persisted layout.
    const body = (await res.json()) as {
      data: { widgets: Array<{ id: string }> };
    };
    expect(body.data.widgets.map((w) => w.id).sort()).toEqual(
      [...DASHBOARD_WIDGET_CATALOGUE_IDS].sort(),
    );
  });

  it("GET returns the full persisted layout including all 11 iOS-only ids", async () => {
    const stored: DashboardLayout = serializeDashboardLayout({
      version: 1,
      widgets: DASHBOARD_WIDGET_CATALOGUE_IDS.map((id, i) => ({
        id,
        visible: true,
        tileVisible: true,
        order: i,
      })),
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);

    const res = await callGet();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { widgets: Array<{ id: string }> };
    };
    const ids = body.data.widgets.map((w) => w.id);
    for (const iosId of DASHBOARD_IOS_ONLY_WIDGET_IDS) {
      expect(ids).toContain(iosId);
    }
    expect(ids.sort()).toEqual([...DASHBOARD_WIDGET_CATALOGUE_IDS].sort());
  });

  it("an id genuinely outside the 27-catalogue still drops on PUT", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [
          { id: "hrv", visible: true, tileVisible: true, order: 0 }, // iOS-only — survives
          { id: "glp1", visible: true, tileVisible: true, order: 1 }, // retired — drops
        ],
      }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { widgets: Array<{ id: string }> } };
    };
    const persistedIds = updateArg.data.dashboardWidgetsJson.widgets.map(
      (w) => w.id,
    );
    expect(persistedIds).toContain("hrv");
    expect(persistedIds).not.toContain("glp1");

    expect(annotate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "dashboard.widgets.unknown-id-dropped" },
        meta: expect.objectContaining({
          dropped_ids: ["glp1"],
          dropped_count: 1,
        }),
      }),
    );
  });
});

describe("dashboard widgets — preserve-when-absent on PUT", () => {
  it("keeps the stored comparisonBaseline when the client omits it", async () => {
    // The regression: a layout save from a client that doesn't know
    // `comparisonBaseline` (the native client documents the field as
    // web-only and never sends it) used to fall through to the serializer,
    // which clamps a missing baseline to "none". The user's web-chosen
    // comparison silently reset on every tile reorder from the phone.
    const stored: DashboardLayout = serializeDashboardLayout({
      version: 1,
      widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
      comparisonBaseline: "lastYear",
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [
          { id: "weight", visible: false, tileVisible: true, order: 0 },
        ],
      }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { comparisonBaseline: string } };
    };
    expect(updateArg.data.dashboardWidgetsJson.comparisonBaseline).toBe(
      "lastYear",
    );

    const body = (await res.json()) as {
      data: { comparisonBaseline: string };
    };
    expect(body.data.comparisonBaseline).toBe("lastYear");
  });

  it("honours an explicitly sent comparisonBaseline over the stored one", async () => {
    // Preserve-when-absent must not become preserve-always: the web
    // CompareToggle sends the field, including an explicit "none" to clear.
    const stored: DashboardLayout = serializeDashboardLayout({
      version: 1,
      widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
      comparisonBaseline: "lastYear",
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: stored,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [{ id: "weight", visible: true, tileVisible: true, order: 0 }],
        comparisonBaseline: "none",
      }),
    );
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { comparisonBaseline: string } };
    };
    expect(updateArg.data.dashboardWidgetsJson.comparisonBaseline).toBe("none");
  });

  it("persists the four clinical tiles the native client pins", async () => {
    // They used to hit the unknown-id filter ahead of Zod and vanish from
    // the persisted layout, so the placement was lost on every save.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const clinicalIds = [
      "gripStrength",
      "painNRS",
      "waistCircumference",
      "waistToHeight",
    ];
    const res = await callPut(
      makeReq({
        version: 1,
        widgets: clinicalIds.map((id, i) => ({
          id,
          visible: true,
          tileVisible: true,
          order: i,
        })),
      }),
    );
    expect(res.status).toBe(200);

    const dropAnnotate = vi
      .mocked(annotate)
      .mock.calls.find(
        (c) =>
          (c[0] as { action?: { name?: string } }).action?.name ===
          "dashboard.widgets.unknown-id-dropped",
      );
    expect(dropAnnotate).toBeUndefined();

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: { widgets: Array<{ id: string }> } };
    };
    const persistedIds = updateArg.data.dashboardWidgetsJson.widgets.map(
      (w) => w.id,
    );
    for (const id of clinicalIds) {
      expect(persistedIds).toContain(id);
    }
  });
});

/**
 * v1.32.1 — regression for issue #581: dashboard layout changes silently
 * overwritten by a concurrent score-ring save.
 *
 * The scenario from the report: the user edits tile/chart visibility
 * (local draft B), then reorders/toggles a hero score ring before hitting
 * Save. The ring PUT (`ringMutation`) fires immediately, built from
 * whatever layout the client had cached (layout A — the state BEFORE the
 * draft edit). The normal Save button then PUTs the full draft (layout B)
 * and commits first. If the earlier-fired ring request resolves AFTER
 * Save, its body — built from the stale A snapshot — used to carry
 * `widgets: A` explicitly, and an explicitly-present field always wins on
 * write. Save's B silently reverted to A even though the ring PUT reported
 * 200 and only meant to touch the ring selection.
 *
 * The fix is `buildRingMutationPayload` (imported from the real component
 * module, not re-implemented here): it never includes `widgets` at all.
 * This test proves the SERVER half of the fix — a PUT shaped exactly like
 * the shipped ring mutation's body preserves whatever layout is CURRENTLY
 * stored, so the request that resolves last can no longer matter.
 */
describe("dashboard widgets — ring-only PUT cannot race a concurrent full-layout Save (regression #581)", () => {
  it("preserves the widgets a concurrent Save already committed, even though the ring request started from a stale snapshot", async () => {
    // The state AFTER the normal Save committed layout B — a tile turned
    // off that was on in the stale snapshot A the ring mutation started
    // from. Starts from the FULL default widget catalogue (rather than a
    // single-widget array) so `resolveDashboardLayout`'s auto-upgrade
    // append (missing catalogue ids get seeded invisible) is a no-op here
    // and the persisted array can be compared for exact equality below.
    const savedLayoutB: DashboardLayout = serializeDashboardLayout({
      version: 1,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets.map((w) =>
        w.id === "weight" ? { ...w, visible: false, tileVisible: false } : w,
      ),
      comparisonBaseline: "lastYear",
      selectedScoreRings: ["MED_COMPLIANCE"],
      heroRingOrder: ["HEALTH_SCORE", "MED_COMPLIANCE"],
    });
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: savedLayoutB,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    // The ring mutation's real, shipped payload — built without any
    // knowledge of layout B. If this were still `{...staleA, ...}` the
    // stale `widgets`/`comparisonBaseline` would land here explicitly and
    // overwrite B; `buildRingMutationPayload` never carries them.
    const ringOnlyBody = buildRingMutationPayload({
      selectedScoreRings: ["READINESS"],
      heroRingOrder: ["HEALTH_SCORE", "READINESS"],
    });

    const res = await callPut(makeReq(ringOnlyBody));
    expect(res.status).toBe(200);

    const updateArg = vi.mocked(prisma.user.update).mock
      .calls[0]?.[0] as unknown as {
      data: { dashboardWidgetsJson: DashboardLayout };
    };
    // B's widgets (and comparisonBaseline) survive — the ring PUT never
    // touched them, so nothing it carries can outrace the Save that
    // already committed.
    expect(updateArg.data.dashboardWidgetsJson.widgets).toEqual(
      savedLayoutB.widgets,
    );
    expect(updateArg.data.dashboardWidgetsJson.comparisonBaseline).toBe(
      "lastYear",
    );
    // The ring selection itself DID apply.
    expect(updateArg.data.dashboardWidgetsJson.selectedScoreRings).toEqual([
      "READINESS",
    ]);

    const body = (await res.json()) as { data: DashboardLayout };
    expect(body.data.widgets[0].visible).toBe(false);
    expect(body.data.widgets[0].tileVisible).toBe(false);
    expect(body.data.selectedScoreRings).toEqual(["READINESS"]);
  });

  it("still accepts a normal full-layout Save (widgets present + replace semantics unchanged)", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);

    const res = await callPut(
      makeReq({
        version: 1,
        widgets: [
          { id: "weight", visible: false, tileVisible: false, order: 0 },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: DashboardLayout };
    expect(body.data.widgets[0].visible).toBe(false);
  });
});

/**
 * v1.32.16 — optimistic concurrency (issue #581). A Save that carries the
 * `baseUpdatedAt` it was made against writes CONDITIONALLY on the stored row
 * still carrying that token, so a committed Save can never be silently
 * reverted by a later request that started from an older snapshot. A full
 * layout with every top-level field present skips the preserve-read, so the
 * only `findUnique` here is the post-write token read.
 */
describe("dashboard widgets — optimistic concurrency (issue #581)", () => {
  // A full layout carrying every preserved field so `needsPreserveRead`
  // is false and the route takes the guarded write path directly.
  function fullLayoutBody(baseUpdatedAt?: string) {
    return {
      version: 1,
      widgets: DEFAULT_DASHBOARD_LAYOUT.widgets,
      comparisonBaseline: "none",
      chartOverlayPrefs: {},
      selectedScoreRings: ["MED_COMPLIANCE"],
      heroRingOrder: ["HEALTH_SCORE", "MED_COMPLIANCE"],
      ...(baseUpdatedAt !== undefined ? { baseUpdatedAt } : {}),
    };
  }

  it("guards the write on the base token and returns the advanced token", async () => {
    const base = new Date("2026-07-24T10:00:00.000Z");
    const advanced = new Date("2026-07-24T10:05:00.000Z");
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
    // The post-write token read.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      updatedAt: advanced,
    } as never);

    const res = await callPut(makeReq(fullLayoutBody(base.toISOString())));
    expect(res.status).toBe(200);

    // Wrote conditionally on the exact base token — never unconditionally.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    const whereArg = vi.mocked(prisma.user.updateMany).mock.calls[0]?.[0]
      ?.where as { id: string; updatedAt: Date };
    expect(whereArg.id).toBe("user-1");
    expect((whereArg.updatedAt as Date).toISOString()).toBe(base.toISOString());
    expect(prisma.user.update).not.toHaveBeenCalled();

    // The response echoes the advanced token so the client can rebase.
    const body = (await res.json()) as { data: { updatedAt: string } };
    expect(body.data.updatedAt).toBe(advanced.toISOString());
  });

  it("rejects a stale base token with 409 and writes nothing", async () => {
    // The guarded update matches zero rows — someone advanced updatedAt.
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);

    const res = await callPut(
      makeReq(fullLayoutBody("2026-07-24T09:00:00.000Z")),
    );
    expect(res.status).toBe(409);

    const body = (await res.json()) as {
      data: null;
      error: string;
      meta?: { errorCode?: string };
    };
    expect(body.data).toBeNull();
    expect(body.meta?.errorCode).toBe("dashboard_layout_conflict");

    // The conditional write matched no row; there is NO unconditional
    // fallback, so the stored layout is left exactly as it was.
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("422s a malformed base token without touching the row", async () => {
    const res = await callPut(makeReq(fullLayoutBody("not-a-date")));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("invalid_base_updated_at");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps the unconditional write when the client omits the token", async () => {
    // Backward-compatible path for older web builds / the native client.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      dashboardWidgetsJson: null,
    } as never);
    vi.mocked(prisma.user.update).mockResolvedValue({
      updatedAt: new Date("2026-07-24T11:00:00.000Z"),
    } as never);

    const res = await callPut(makeReq(fullLayoutBody()));
    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    const body = (await res.json()) as { data: { updatedAt: string } };
    expect(body.data.updatedAt).toBe("2026-07-24T11:00:00.000Z");
  });
});
