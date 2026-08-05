/**
 * `GET  /api/family-history` — newest-first list of the account's family-history
 *                             entries.
 * `POST /api/family-history` — create one condition-by-relative record.
 *
 * A structured FamilyMemberHistory-style RECORD, patient-reported — never a
 * clinical diagnosis the app asserts. `userId` is narrowed from auth and fed
 * to the Prisma `where`; it is never a body field. The `data` object is built
 * field-by-field (no mass assignment); the free-text `note` is encrypted at
 * rest.
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
  familyHistoryCreateSchema,
  familyHistoryListQuerySchema,
} from "@/lib/validations/family-history";
import { toFamilyHistoryEntryDTO } from "@/lib/records/dto";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = familyHistoryListQuerySchema.safeParse({
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "familyHistory.invalid",
    });
  }

  const limit = parsed.data.limit ?? 100;
  const rows = await prisma.familyHistoryEntry.findMany({
    where: { userId: user.id, deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  annotate({
    action: { name: "family-history.list", entity_type: "family_history" },
    meta: { count: rows.length },
  });

  return apiSuccess(rows.map(toFamilyHistoryEntryDTO));
});

export const POST = apiHandler(
  withIdempotency<[NextRequest]>(postFamilyHistory),
);

async function postFamilyHistory(request: NextRequest): Promise<Response> {
  // v1.36.x — not a delegated write, though the GET above is delegable. The
  // reasoning is written out at the sibling arm in `api/allergies/route.ts`
  // and is the same here: the only surface that posts to either route is the
  // manager in Settings → Anamnese, and `/settings/*` is closed inside a
  // shared record, so no delegate can reach the form at any level. An
  // admitted write with no reachable caller is a permission frozen ahead of
  // the surface that would exercise it.
  //
  // This arm carried an extra reason to wait. The row describes the record's
  // RELATIVES, so it is the one admitted write where third-party health
  // information is present by design — and frequently the delegate is that
  // relative, asserting a condition about themselves into somebody else's
  // record. The classification admitted it and named the discomfort. Landing
  // it together with the surface that offers it means the copy on that surface
  // can say whose statement the row is, which no route comment can.
  // v1.37.0 — MANAGE. Third-party data by design, admitted on the same
  // reasoning the read arm was: it is the record's own health background.
  const { user } = await requireRecordAuth("manage", "profile");

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = familyHistoryCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "family-history.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "familyHistory.invalid",
    });
  }

  const entry = parsed.data;

  // Field-by-field — never spread the parsed object whole.
  const created = await prisma.familyHistoryEntry.create({
    data: {
      userId: user.id,
      relationship: entry.relationship,
      condition: entry.condition,
      ageAtOnset: entry.ageAtOnset ?? null,
      notesEncrypted: entry.note ? encryptToBytes(entry.note) : null,
    },
  });

  await auditLog("family-history.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { entryId: created.id, relationship: created.relationship },
  });

  annotate({
    action: {
      name: "family-history.create",
      entity_type: "family_history",
      entity_id: created.id,
    },
    meta: { relationship: created.relationship },
  });

  return apiSuccess(toFamilyHistoryEntryDTO(created), 201);
}
