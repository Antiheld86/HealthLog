/**
 * `GET  /api/allergies` — newest-first list of the account's allergies.
 * `POST /api/allergies` — create one allergy/intolerance record.
 *
 * A structured AllergyIntolerance-style RECORD, patient-reported — never a
 * clinical diagnosis the app asserts. `userId` is narrowed from auth and fed
 * to the Prisma `where`; it is never a body field. The `data` object is built
 * field-by-field (no mass assignment); the free-text `reaction` + `note` are
 * encrypted at rest.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { withIdempotency } from "@/lib/idempotency";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  allergyCreateSchema,
  allergyListQuerySchema,
} from "@/lib/validations/allergy";
import { toAllergyDTO } from "@/lib/records/dto";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = allergyListQuerySchema.safeParse({
    limit: params.get("limit") ?? undefined,
    includeInactive: params.get("includeInactive") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "allergy.invalid",
    });
  }

  const limit = parsed.data.limit ?? 100;
  const rows = await prisma.allergy.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      ...(parsed.data.includeInactive === "false" ? { status: "ACTIVE" } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  annotate({
    action: { name: "allergy.list", entity_type: "allergy" },
    meta: { count: rows.length },
  });

  return apiSuccess(rows.map(toAllergyDTO));
});

// `withIdempotency` lets an iOS retry / double-tap re-send the same
// `Idempotency-Key` without minting a duplicate record (the labs /
// illness create precedent).
export const POST = apiHandler(withIdempotency<[NextRequest]>(postAllergy));

async function postAllergy(request: NextRequest): Promise<Response> {
  // v1.36.x — the GET above is delegable and this is not, which is the
  // opposite of where the classification landed and worth the paragraph.
  //
  // Nothing about the row changed: it is still a plain statement about the
  // record's own body, still the single most useful thing a caregiver could
  // contribute, and the argument for admitting it still holds. What it does
  // not have is a caller. The only place in the product that posts here is the
  // allergy manager in Settings → Anamnese, and `/settings/*` is not a
  // shared-record destination — the shell shows the "not part of what was
  // shared" panel there, so no delegate can reach the form at any level.
  //
  // An admitted write with no reachable surface is the one-ended change this
  // repository keeps rediscovering (CLAUDE.md, "A two-ended change carries
  // both ends"): the permission ships, the consumer is the follow-up, and
  // nothing in the gate notices because every other check proves the other
  // end. The frozen list is built the other way round on purpose — its own
  // actor-surface note says the rest "arrive as their own diffs; naming them
  // before they exist would freeze a guess."
  //
  // So this arm waits for the surface that would exercise it, and the two
  // land together. Choosing that surface is design work, not a fix: allergies
  // and family history have exactly one home today, that home is a personal
  // account surface a switch rightly closes, and bolting a second copy onto a
  // shared page would split one concept across two places. Re-admitting is
  // one line here plus one entry in `sharing-surface-guard.test.ts` plus the
  // paragraph that argues it — which is exactly the reviewed diff that guard
  // exists to force.
  //
  // The half that was always the point is untouched: a caregiver can still
  // READ the allergy list inside the record.
  // v1.37.0 — MANAGE. Recording an allergy for somebody whose record you
  // manage is the case the level exists for; on a managed profile it is the
  // guardian's ordinary act. Additive, audited, and the row is the record's.
  const { user } = await requireRecordAuth("manage", "profile");

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = allergyCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "allergy.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "allergy.invalid",
    });
  }

  const entry = parsed.data;

  // Field-by-field — never spread the parsed object whole.
  const created = await prisma.allergy.create({
    data: {
      userId: user.id,
      substance: entry.substance,
      category: entry.category,
      type: entry.type,
      severity: entry.severity ?? null,
      status: entry.status,
      onsetAt: entry.onsetAt ? new Date(entry.onsetAt) : null,
      reactionEncrypted: entry.reaction ? encryptToBytes(entry.reaction) : null,
      notesEncrypted: entry.note ? encryptToBytes(entry.note) : null,
    },
  });

  await auditLog("allergy.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { allergyId: created.id, category: created.category },
  });

  annotate({
    action: {
      name: "allergy.create",
      entity_type: "allergy",
      entity_id: created.id,
    },
    meta: { category: created.category, type: created.type },
  });

  return apiSuccess(toAllergyDTO(created), 201);
}
