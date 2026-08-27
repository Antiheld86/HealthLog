import { apiHandler, requireAdmin } from "@/lib/api-handler";
import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

/**
 * v1.37.31 — per-provider delivery health for the operator.
 *
 * The per-user retry ledger (`provider_health`) has recorded every AI
 * delivery outcome for a long time, but no surface ever read it for the
 * operator: a central provider (`admin-openai` / `admin-codex`) could fail
 * on every call for weeks and the admin console said nothing. This endpoint
 * folds the ledger into one row per provider type so the console can show
 * it. Read-only, admin-cookie-only, and it exposes counts and timestamps
 * only — never which user a row belongs to.
 */

interface ProviderHealthSummary {
  providerType: string;
  /** Users whose chain has recorded at least one outcome for this type. */
  tracked: number;
  /** Users whose LAST outcome for this type was a failure. */
  failing: number;
  /** Highest uninterrupted failure run across those users. */
  maxConsecutiveFailures: number;
  lastOkAt: string | null;
  lastFailureAt: string | null;
}

/** The two operator-managed tags sort first — they affect every user on the chain. */
const CENTRAL_TYPES = ["admin-openai", "admin-codex"];

export const GET = apiHandler(async () => {
  await requireAdmin();
  annotate({ action: { name: "admin.provider-health.get" } });

  const groups = await prisma.providerHealth.groupBy({
    by: ["providerType", "lastResult"],
    _count: { _all: true },
    _max: {
      consecutiveFailures: true,
      lastFailureAt: true,
      lastOkAt: true,
    },
  });

  const byType = new Map<string, ProviderHealthSummary>();
  for (const g of groups) {
    const row = byType.get(g.providerType) ?? {
      providerType: g.providerType,
      tracked: 0,
      failing: 0,
      maxConsecutiveFailures: 0,
      lastOkAt: null,
      lastFailureAt: null,
    };
    row.tracked += g._count._all;
    if (g.lastResult !== "ok") {
      row.failing += g._count._all;
      row.maxConsecutiveFailures = Math.max(
        row.maxConsecutiveFailures,
        g._max.consecutiveFailures ?? 0,
      );
    }
    const ok = g._max.lastOkAt?.toISOString() ?? null;
    if (ok && (!row.lastOkAt || ok > row.lastOkAt)) row.lastOkAt = ok;
    const fail = g._max.lastFailureAt?.toISOString() ?? null;
    if (fail && (!row.lastFailureAt || fail > row.lastFailureAt)) {
      row.lastFailureAt = fail;
    }
    byType.set(g.providerType, row);
  }

  const providers = [...byType.values()].sort((a, b) => {
    const ca = CENTRAL_TYPES.indexOf(a.providerType);
    const cb = CENTRAL_TYPES.indexOf(b.providerType);
    if (ca !== -1 || cb !== -1) {
      return (
        (ca === -1 ? CENTRAL_TYPES.length : ca) -
        (cb === -1 ? CENTRAL_TYPES.length : cb)
      );
    }
    return a.providerType.localeCompare(b.providerType);
  });

  return apiSuccess({ providers });
});
