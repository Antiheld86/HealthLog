/**
 * `POST /api/vaccinations/{id}/booster` — mint (or re-anchor) the booster
 * reminder a logged dose suggests.
 *
 * Rung 2: the reminder only exists because the person confirmed it, prefilled
 * from the catalogue's interval and fully editable before this call. The minted
 * row is an ordinary `origin: VORSORGE` reminder that carries the dose's
 * primary antigen as a match key; it lists on `/checkups` and rings through the
 * same engine as every other checkup, with no new code.
 *
 * WRITE, classified `profile`: filing the owner's Impfpass and arming the
 * owner's booster plan are the same act, and both run on the owner's reminders
 * even when a delegate is transcribing. The antigen is read from the dose's
 * catalogue entry server-side, never from the body — a client cannot key a
 * reminder onto an antigen the dose does not contain.
 */
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { vaccinationBoosterSchema } from "@/lib/validations/vaccinations";
import { mintOrReanchorBooster } from "@/lib/vaccinations/booster-mint";
import { resolveOwnerTimezone } from "@/lib/vaccinations/service";
import { toMeasurementReminderDto } from "@/lib/measurement-reminders/dto";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("write", "profile");
    const { id } = await params;

    const { data: rawBody, error: jsonError } = await safeJson(request, {
      maxBytes: 8 * 1024,
    });
    if (jsonError) return jsonError;

    const parsed = vaccinationBoosterSchema.safeParse(rawBody);
    if (!parsed.success) {
      return returnAllZodIssues(parsed.error, 422, {
        errorCode: "vaccination.booster-invalid",
      });
    }

    const timezone = await resolveOwnerTimezone(user.id);
    const result = await prisma.$transaction((tx) =>
      mintOrReanchorBooster(
        tx,
        user.id,
        { vaccinationId: id, ...parsed.data },
        timezone,
      ),
    );

    if (result.outcome === "unknown-record") {
      return apiError("Vaccination not found", 404, {
        errorCode: "vaccination.not-found",
      });
    }
    if (result.outcome === "no-antigen") {
      // A free-text-only dose has no antigen to key a booster on. The prompt is
      // never offered for one; this is the defence if a request arrives anyway.
      return apiError("This dose has no catalogue antigen to remind on", 422, {
        errorCode: "vaccination.booster-no-antigen",
      });
    }

    const reminder = await prisma.measurementReminder.findUniqueOrThrow({
      where: { id: result.reminderId },
    });

    await auditLog("vaccination.booster.planned", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: {
        vaccinationId: id,
        reminderId: result.reminderId,
        minted: result.outcome === "minted",
      },
    });

    annotate({
      action: {
        name: "vaccination.booster.planned",
        entity_type: "measurement-reminder",
        entity_id: result.reminderId,
      },
      meta: {
        antigen_slug: result.antigen,
        minted: result.outcome === "minted",
      },
    });

    return apiSuccess(
      {
        reminder: toMeasurementReminderDto(reminder),
        minted: result.outcome === "minted",
      },
      result.outcome === "minted" ? 201 : 200,
    );
  },
);
