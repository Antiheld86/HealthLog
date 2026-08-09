/**
 * `GET  /api/practitioners` — the account's own address book of doctors and
 *                             practices, name-ordered and searchable.
 * `POST /api/practitioners` — add one.
 *
 * No module gate: an address book is core, like the checkups page the visits
 * that reference it live on. The reasoning is written at the `Practitioner`
 * model in `prisma/schema.prisma`.
 *
 * `userId` is narrowed from auth and fed to the Prisma `where`; it is never a
 * body field. The `data` object is built field-by-field, never spread from the
 * parsed body. `note` is encrypted at rest; `name` stays plaintext so the
 * picker can search and sort it in SQL.
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
  practitionerCreateSchema,
  practitionerListQuerySchema,
} from "@/lib/validations/practitioners";
import { toPractitionerDTO } from "@/lib/practitioners/dto";

export const GET = apiHandler(async (request: NextRequest) => {
  const { user } = await requireRecordAuth("read", "profile");

  const params = new URL(request.url).searchParams;
  const parsed = practitionerListQuerySchema.safeParse({
    q: params.get("q") ?? undefined,
    limit: params.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "practitioner.invalid",
    });
  }

  const rows = await prisma.practitioner.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      // Three plaintext columns, because a person looks a practice up by
      // whichever they remember: the doctor's name on the referral, the
      // practice name on the door, or the field they need ("Zahnmedizin").
      // Searching only name + practice made the specialty attempt return
      // nothing and read as "not in the address book".
      ...(parsed.data.q
        ? {
            OR: [
              {
                name: {
                  contains: parsed.data.q,
                  mode: "insensitive" as const,
                },
              },
              {
                practice: {
                  contains: parsed.data.q,
                  mode: "insensitive" as const,
                },
              },
              {
                specialty: {
                  contains: parsed.data.q,
                  mode: "insensitive" as const,
                },
              },
            ],
          }
        : {}),
    },
    orderBy: { name: "asc" },
    take: parsed.data.limit ?? 100,
  });

  annotate({
    action: { name: "practitioner.contact.list", entity_type: "practitioner" },
    meta: { count: rows.length },
  });

  return apiSuccess(rows.map(toPractitionerDTO));
});

// A double-tap on "save" must not mint a second copy of the same practice.
export const POST = apiHandler(
  withIdempotency<[NextRequest]>(postPractitioner),
);

async function postPractitioner(request: NextRequest): Promise<Response> {
  const { user } = await requireRecordAuth("write", "profile");

  const { data: rawBody, error: jsonError } = await safeJson(request, {
    maxBytes: 16 * 1024,
  });
  if (jsonError) return jsonError;

  const parsed = practitionerCreateSchema.safeParse(rawBody);
  if (!parsed.success) {
    annotate({
      action: { name: "practitioner.contact.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "practitioner.invalid",
    });
  }

  const entry = parsed.data;

  // Field-by-field — never spread the parsed object whole.
  const created = await prisma.practitioner.create({
    data: {
      userId: user.id,
      name: entry.name,
      specialty: entry.specialty ?? null,
      practice: entry.practice ?? null,
      location: entry.location ?? null,
      phone: entry.phone ?? null,
      noteEncrypted: entry.note ? encryptToBytes(entry.note) : null,
    },
  });

  await auditLog("practitioner.contact.create", {
    userId: user.id,
    ipAddress: getClientIp(request),
    details: { practitionerId: created.id },
  });

  annotate({
    action: {
      name: "practitioner.contact.create",
      entity_type: "practitioner",
      entity_id: created.id,
    },
  });

  return apiSuccess(toPractitionerDTO(created), 201);
}
