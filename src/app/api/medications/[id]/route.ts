import { prisma } from "@/lib/db";
import { apiHandler, requireAuth, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import {
  apiSuccess,
  apiError,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { updateMedicationSchema } from "@/lib/validations/medication";
import { invalidateUserMedications } from "@/lib/cache/invalidate";
import {
  deleteMedicationCategory,
  getMedicationCategories,
  setMedicationCategory,
} from "@/lib/medication-category";
import { serializeScheduleRecurrence } from "@/lib/medication-schedule";
import {
  schedulesMateriallyDiffer,
  toRevisionPayloadEntry,
} from "@/lib/medications/scheduling/schedule-eras";
import type { Prisma } from "@/generated/prisma/client";
import {
  computeDisplayDue,
  OVERDUE_LOOKBACK_MS,
  toResolvedSlotMark,
} from "@/lib/medications/scheduling/next-due";
import {
  dayKeyForScheduledFor,
  recomputeMedicationComplianceForDay,
} from "@/lib/rollups/medication-compliance-rollups";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { hhmmToMinutesOrNull } from "@/lib/medications/scheduling/hhmm";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { NextRequest } from "next/server";

type RouteParams = { params: Promise<{ id: string }> };

/** Parse "HH:mm" into minutes-of-day; NaN-safe (malformed → 0). */
function hhmmToMinutes(value: string): number {
  return hhmmToMinutesOrNull(value) ?? 0;
}

/**
 * Reconcile a schedule's `windowStart` / `windowEnd` with its effective
 * `timesOfDay`. The schedule editor can change only the dose times while the
 * client echoes the previous window back; a time outside the window then
 * breaks every consumer that assumes `timesOfDay ⊆ [windowStart, windowEnd]`
 * (the window-status pill, the reminder phases, the legacy compliance
 * walker). When ANY time falls outside the window — including the overnight
 * `windowEnd < windowStart` shape, checked with wrap-around membership —
 * the window is pulled to the min/max of the times so the persisted row is
 * self-consistent. A window that already covers every time is left
 * byte-identical (explicitly wider windows are a feature).
 */
function reconcileScheduleWindow(
  windowStart: string,
  windowEnd: string,
  timesOfDay: string[],
): { windowStart: string; windowEnd: string } {
  if (timesOfDay.length === 0) return { windowStart, windowEnd };
  const startMins = hhmmToMinutes(windowStart);
  const endMins = hhmmToMinutes(windowEnd);
  const overnight = endMins < startMins;
  const inWindow = (t: number): boolean =>
    overnight ? t >= startMins || t <= endMins : t >= startMins && t <= endMins;
  const sorted = [...timesOfDay].sort(
    (a, b) => hhmmToMinutes(a) - hhmmToMinutes(b),
  );
  const allInside = sorted.every((t) => inWindow(hhmmToMinutes(t)));
  if (allInside) return { windowStart, windowEnd };
  return { windowStart: sorted[0], windowEnd: sorted[sorted.length - 1] };
}

export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "medications");

    const { id } = await params;
    const medication = await prisma.medication.findUnique({
      where: { id },
      include: { schedules: true },
    });

    if (!medication || medication.userId !== user.id) {
      return apiError("Medication not found", 404);
    }

    let category = "OTHER";
    try {
      const categories = await getMedicationCategories([id]);
      category = categories[id] ?? "OTHER";
    } catch {
      // Category enrichment is optional
    }

    // v1.7.0 SB-SCHED-3 — server-computed next due instant. Rolling
    // cadences re-anchor on the latest non-skipped intake, so fetch it
    // once (no-op for calendar cadences but cheap + keeps the value
    // correct for rolling injections).
    const lastIntake = medication.schedules.some(
      (s) => s.rollingIntervalDays !== null,
    )
      ? await prisma.medicationIntakeEvent.findFirst({
          // v1.7.0 sync — a tombstoned intake no longer anchors the
          // rolling-interval next-due computation.
          where: {
            userId: user.id,
            medicationId: id,
            deletedAt: null,
            takenAt: { not: null },
          },
          orderBy: { takenAt: "desc" },
          select: { takenAt: true },
        })
      : null;
    // v1.15.10 — slots the user has already acted on near now, so the
    // next-due search skips them and advances to the next genuinely-open
    // slot. Bound the read to [now-1d, now+2d] — the lookahead only needs the
    // slots adjacent to now.
    const now = new Date();
    // v1.16.4 — reach back as far as the widest band tail so a
    // long-resolved past slot can never resurface as "overdue".
    const resolvedFrom = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);
    const resolvedTo = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const resolvedRows = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId: user.id,
        medicationId: id,
        deletedAt: null,
        scheduledFor: { gte: resolvedFrom, lte: resolvedTo },
        OR: [
          { takenAt: { not: null } },
          { skipped: true },
          { autoMissed: true },
        ],
      },
      // v1.16.9 — `takenAt` rides along so an ad-hoc row (`scheduledFor
      // === takenAt`) cannot ±6h-resolve a different slot.
      select: { scheduledFor: true, takenAt: true },
    });
    // v1.16.4 — current-era floor: the open-overdue search mints from
    // the LIVE schedule rows, so it must not reach past the newest
    // revision boundary into a previous era's cadence.
    const latestRevision = await prisma.medicationScheduleRevision.findFirst({
      // Superseded rows are audit records — a correction may have
      // shortened the era, so the boundary reads only active rows.
      where: { medicationId: id, supersededByRevisionId: null },
      orderBy: { validUntil: "desc" },
      select: { validUntil: true },
    });
    const display = computeDisplayDue({
      medication: {
        id: medication.id,
        startsOn: medication.startsOn,
        endsOn: medication.endsOn,
        oneShot: medication.oneShot,
        createdAt: medication.createdAt,
      },
      schedules: medication.schedules,
      now,
      userTz: user.timezone || "Europe/Berlin",
      lastIntakeAt: lastIntake?.takenAt ?? null,
      resolvedSlots: resolvedRows.map(toResolvedSlotMark),
      eraStart: latestRevision?.validUntil ?? null,
    });

    annotate({
      action: {
        name: "medication.get",
        entity_type: "medication",
        entity_id: id,
      },
    });

    return apiSuccess({
      ...medication,
      unitsPerDose: Number(medication.unitsPerDose),
      category,
      nextDueAt: display ? display.at.toISOString() : null,
      nextDueOverdue: display?.overdue ?? false,
    });
  },
);

export const PUT = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.5.5 C-E3-3 — route ownership check through the shared helper
    // so the 404 leak shape stays identical across every
    // `[id]/**` handler. The PUT branch still needs `existing.active`
    // for the pausedAt-derivation step below, so re-read the narrow
    // field after the guard passes.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;
    const existing = await prisma.medication.findUnique({
      where: { id },
      // v1.16.11 — `asNeeded` + the schedule count feed the as-needed
      // invariants below: a flip to as-needed must end schedule-less,
      // a flip back to scheduled must end with at least one schedule.
      select: {
        active: true,
        createdAt: true,
        asNeeded: true,
        _count: { select: { schedules: true } },
      },
    });
    if (!existing) {
      return apiError("Medication not found", 404);
    }

    const { data: body, error: jsonError } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });

    if (jsonError) return jsonError;
    const parsed = updateMedicationSchema.safeParse(body);
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
    }

    const {
      name,
      dose,
      category,
      treatmentClass,
      dosesPerUnit,
      unitsPerDose,
      reorderLeadDays,
      deliveryForm,
      trackInjectionSites,
      allowedInjectionSites,
      active,
      notificationsEnabled,
      liveActivityEnabled,
      criticalAlarmEnabled,
      atcCode,
      rxNormCode,
      schedules,
      startsOn,
      endsOn,
      oneShot,
      asNeeded,
      reminderGraceMinutes: topLevelGraceMinutes,
    } = parsed.data;

    // ── v1.16.11 (#316) — as-needed invariants ──────────────────────
    //
    // An as-needed medication ends schedule-less, always. The Zod layer
    // already rejects a populated `schedules` array alongside
    // `asNeeded: true`; the route covers the cross-row cases the schema
    // cannot see:
    //   - flipping an existing scheduled medication to as-needed
    //     requires `schedules: []` in the same request (keeping the old
    //     rows alongside the flag is a 422, per the feature contract);
    //   - flipping as-needed OFF requires the medication to end with at
    //     least one schedule (the wizard always sends the full array).
    const effectiveAsNeeded = asNeeded ?? existing.asNeeded;
    if (effectiveAsNeeded) {
      const endsScheduleless = schedules
        ? schedules.length === 0
        : existing._count.schedules === 0;
      if (!endsScheduleless) {
        return apiError(
          "An as-needed medication cannot carry schedules (send schedules: [] to clear them)",
          422,
        );
      }
    } else if (
      asNeeded === false &&
      existing.asNeeded &&
      (!schedules || schedules.length === 0)
    ) {
      return apiError(
        "A scheduled medication requires at least one schedule",
        422,
      );
    }

    // ── v1.5.5 — primary-schedule grace bridge ──────────────────────
    //
    // The detail-page settings section saves the reminder-window in
    // one PUT carrying only `{ reminderGraceMinutes }` at the top
    // level (no full `schedules` array). Map it onto the medication's
    // primary schedule before the Prisma update so the persisted
    // shape stays per-schedule and the engine reads it from the same
    // column as the wizard write-path. A full `schedules` array on
    // the same request takes precedence — the wizard already declares
    // the grace per row and we never want to overwrite that intent.
    let primaryScheduleGracePatch: {
      scheduleId: string;
      reminderGraceMinutes: number | null;
    } | null = null;
    if (topLevelGraceMinutes !== undefined && !schedules) {
      const primary = await prisma.medicationSchedule.findFirst({
        where: { medicationId: id },
        orderBy: { windowStart: "asc" },
        select: { id: true },
      });
      if (primary) {
        primaryScheduleGracePatch = {
          scheduleId: primary.id,
          reminderGraceMinutes: topLevelGraceMinutes,
        };
      }
    }

    // ── v1.5 route invariants for the new scheduling primitives ─────
    //
    // Mirrors the POST route: oneShot ⇒ at-most-one schedule + no
    // recurrence on it; endsOn normalised to startsOn for one-shot;
    // recurring default = FREQ=DAILY when nothing else is set;
    // timesOfDay dual-write from windowStart when absent.
    //
    // The PUT replaces all schedules wholesale, so the invariants run
    // against the incoming `schedules` array (if provided) the same
    // way they do on create.
    if (oneShot === true && schedules) {
      if (schedules.length > 1) {
        return apiError(
          "A one-shot medication can have at most one schedule",
          422,
        );
      }
      const s = schedules[0];
      if (s && (s.rrule !== undefined || s.rollingIntervalDays !== undefined)) {
        return apiError(
          "A one-shot medication cannot have a recurrence (rrule or rollingIntervalDays)",
          422,
        );
      }
    }

    // Normalise endsOn for one-shot. `oneShot === true` + `startsOn`
    // means the dose is the start date; endsOn auto-matches.
    const normalisedEndsOn = oneShot === true && startsOn ? startsOn : endsOn;

    const pausedAtPatch =
      active === undefined
        ? {}
        : active
          ? { pausedAt: null as Date | null }
          : existing.active
            ? { pausedAt: new Date() }
            : {};

    // v1.16.3 — normalise the incoming schedules ONCE: the same values feed
    // the create payload below AND the revision compare/snapshot (so the
    // material-change gate sees exactly what will be persisted).
    const normalisedSchedules = schedules?.map((s) => {
      // Invariant 2 — default to FREQ=DAILY when nothing else is set.
      // v1.7.0 — PRN carries no cadence, so never default it.
      const hasLegacyDays = (s.daysOfWeek?.length ?? 0) > 0;
      const isPrn = s.scheduleType === "PRN";
      const defaultedRrule =
        oneShot !== true &&
        !isPrn &&
        s.rrule === undefined &&
        s.rollingIntervalDays === undefined &&
        !hasLegacyDays
          ? "FREQ=DAILY"
          : s.rrule;

      // Invariant 3 — dual-write timesOfDay from windowStart.
      const effectiveTimesOfDay =
        s.timesOfDay && s.timesOfDay.length > 0
          ? s.timesOfDay
          : [s.windowStart];

      // Invariant 4 — window / times consistency. See
      // `reconcileScheduleWindow`: a times-only edit that echoes the
      // stale window back gets the window pulled to the min/max of
      // the new times.
      const window = reconcileScheduleWindow(
        s.windowStart,
        s.windowEnd,
        effectiveTimesOfDay,
      );

      const serializedDaysOfWeek = serializeScheduleRecurrence({
        daysOfWeek: s.daysOfWeek ?? [],
        intervalWeeks: s.intervalWeeks ?? 1,
      });

      return {
        createData: {
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
          label: s.label ?? null,
          dose: s.dose ?? null,
          daysOfWeek: serializedDaysOfWeek,
          // v1.5 first-class times-of-day.
          timesOfDay: effectiveTimesOfDay,
          ...(s.reminderGraceMinutes !== undefined && {
            reminderGraceMinutes: s.reminderGraceMinutes,
          }),
          ...(defaultedRrule !== undefined && { rrule: defaultedRrule }),
          ...(s.rollingIntervalDays !== undefined && {
            rollingIntervalDays: s.rollingIntervalDays,
          }),
          // v1.7.0 — schedule type + cyclic weeks, field-by-field.
          ...(s.scheduleType !== undefined && {
            scheduleType: s.scheduleType,
          }),
          ...(s.cyclicOnWeeks !== undefined && {
            cyclicOnWeeks: s.cyclicOnWeeks,
          }),
          ...(s.cyclicOffWeeks !== undefined && {
            cyclicOffWeeks: s.cyclicOffWeeks,
          }),
          // v1.15.18 — per-dose configurable on-time windows. A `schedules`
          // replace re-creates the rows, so the column is re-written each
          // time; absent leaves it NULL (default ±1h derivation).
          ...(s.doseWindows !== undefined && {
            doseWindows: s.doseWindows,
          }),
        },
        // Mirror of the row the create above will persist (defaults applied),
        // shaped for the cadence compare.
        snapshot: toRevisionPayloadEntry({
          timesOfDay: effectiveTimesOfDay,
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
          daysOfWeek: serializedDaysOfWeek,
          rrule: defaultedRrule ?? null,
          rollingIntervalDays: s.rollingIntervalDays ?? null,
          scheduleType: s.scheduleType ?? "SCHEDULED",
          cyclicOnWeeks: s.cyclicOnWeeks ?? null,
          cyclicOffWeeks: s.cyclicOffWeeks ?? null,
          doseWindows: s.doseWindows ?? null,
          label: s.label ?? null,
          dose: s.dose ?? null,
          reminderGraceMinutes: s.reminderGraceMinutes ?? null,
        }),
      };
    });

    // If schedules provided, replace all
    if (schedules && normalisedSchedules) {
      // v1.16.3 — effective dating. Before the wholesale replace below wipes
      // the old rows, archive them as ONE revision covering
      // `[previous validUntil | medication.createdAt, now)` — but only when a
      // cadence-relevant field actually changes. A no-op edit (the Zeitplan
      // tab echoing the same rows back) must not mint a phantom era.
      const previousRows = await prisma.medicationSchedule.findMany({
        where: { medicationId: id },
      });
      const previousEntries = previousRows.map((row) =>
        toRevisionPayloadEntry({
          timesOfDay: row.timesOfDay,
          windowStart: row.windowStart,
          windowEnd: row.windowEnd,
          daysOfWeek: row.daysOfWeek,
          rrule: row.rrule,
          rollingIntervalDays: row.rollingIntervalDays,
          scheduleType: row.scheduleType,
          cyclicOnWeeks: row.cyclicOnWeeks,
          cyclicOffWeeks: row.cyclicOffWeeks,
          doseWindows: row.doseWindows,
          label: row.label,
          dose: row.dose,
          reminderGraceMinutes: row.reminderGraceMinutes,
        }),
      );
      if (
        previousRows.length > 0 &&
        schedulesMateriallyDiffer(
          previousEntries,
          normalisedSchedules.map((n) => n.snapshot),
        )
      ) {
        const lastRevision = await prisma.medicationScheduleRevision.findFirst({
          // Chain from the ACTIVE boundary: a superseded row is an
          // audit record whose `validUntil` may sit past its correction.
          where: { medicationId: id, supersededByRevisionId: null },
          orderBy: { validUntil: "desc" },
          select: { validUntil: true },
        });
        await prisma.medicationScheduleRevision.create({
          data: {
            medicationId: id,
            validFrom: lastRevision?.validUntil ?? existing.createdAt,
            validUntil: new Date(),
            payload: previousEntries as unknown as Prisma.InputJsonValue,
          },
        });
        annotate({
          action: {
            name: "medication.schedule.revision_archived",
            entity_type: "medication",
            entity_id: id,
          },
          meta: { schedule_revision_rows: previousEntries.length },
        });
      } else if (
        previousRows.length === 0 &&
        existing.asNeeded &&
        asNeeded === false &&
        normalisedSchedules.length > 0
      ) {
        // v1.16.11 — flipping as-needed OFF. The medication carried ZERO
        // schedule rows while as-needed, so the wholesale-replace archive
        // above never fires — and without a revision the live era would
        // start at the PREVIOUS revision's `validUntil` (or `createdAt`),
        // retro-painting the schedule-less as-needed stretch with the NEW
        // schedule's expected slots: every PRN day would read as missed.
        // Archive an EMPTY era covering the as-needed stretch instead; an
        // empty payload expands to zero schedules, so era-aware compliance
        // expects nothing there — exactly the as-needed contract.
        const lastRevision = await prisma.medicationScheduleRevision.findFirst({
          where: { medicationId: id, supersededByRevisionId: null },
          orderBy: { validUntil: "desc" },
          select: { validUntil: true },
        });
        await prisma.medicationScheduleRevision.create({
          data: {
            medicationId: id,
            validFrom: lastRevision?.validUntil ?? existing.createdAt,
            validUntil: new Date(),
            payload: [] as unknown as Prisma.InputJsonValue,
          },
        });
        annotate({
          action: {
            name: "medication.schedule.revision_archived",
            entity_type: "medication",
            entity_id: id,
          },
          meta: { schedule_revision_rows: 0 },
        });
      }
      // A schedule replace invalidates the open slot anchors the projector /
      // reminder worker minted for the OLD times: a pending 08:00 row for a
      // medication that now doses at 20:00 would linger as a phantom slot,
      // auto-miss later, and depress compliance. Tombstone today's and
      // future open pending rows (never an actioned row — `takenAt`,
      // `skipped`, and `autoMissed` are user-visible history) and bump
      // `syncVersion` so delta-sync clients drop them. The projector and
      // the reminder worker re-mint the anchors for the new times on their
      // next pass — the route does not pre-create them.
      const userTz = user.timezone || "Europe/Berlin";
      const { start: todayStart } = getUserTodayBounds(new Date(), userTz);
      const tombstoneWhere = {
        userId: user.id,
        medicationId: id,
        deletedAt: null,
        takenAt: null,
        skipped: false,
        autoMissed: false,
        scheduledFor: { gte: todayStart },
      } as const;
      // Capture the affected slots BEFORE the tombstone so the compliance
      // rollups for those days can be recomputed immediately below —
      // `updateMany` does not return the touched rows. Without the
      // recompute a tombstoned pending kept counting as `scheduled` in
      // the rollup row until the next event-driven write for that day,
      // depressing the rate the cards read in the meantime.
      const tombstoned = await prisma.medicationIntakeEvent.findMany({
        where: tombstoneWhere,
        select: { scheduledFor: true },
      });
      await prisma.medicationIntakeEvent.updateMany({
        where: tombstoneWhere,
        data: { deletedAt: new Date(), syncVersion: { increment: 1 } },
      });
      // Recompute each affected rollup day (deduped via the user-tz day
      // key). Best-effort like every other rollup write-hook: a failure
      // is annotated, never blocks the schedule replace.
      const staleDayKeys = new Set(
        tombstoned.map((row) =>
          dayKeyForScheduledFor(row.scheduledFor, userTz),
        ),
      );
      for (const dayKey of staleDayKeys) {
        try {
          await recomputeMedicationComplianceForDay(
            user.id,
            id,
            dayKey,
            userTz,
          );
        } catch (err) {
          annotate({
            meta: {
              medication_compliance_rollup_failed: true,
              medication_compliance_rollup_error:
                err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
      await prisma.medicationSchedule.deleteMany({
        where: { medicationId: id },
      });
    }

    const baseUpdateData = {
      ...(name !== undefined && { name }),
      ...(dose !== undefined && { dose }),
      ...(treatmentClass !== undefined && { treatmentClass }),
      ...(dosesPerUnit !== undefined && { dosesPerUnit }),
      // v1.16.10 — units consumed per dose. Field-by-field; the stamp on
      // already-taken intake events freezes their recorded consumption.
      ...(unitsPerDose !== undefined && { unitsPerDose }),
      // v1.17.0 — reorder lead override. Field-by-field; `null` is a
      // valid explicit value (clears the override → user-level default).
      ...(reorderLeadDays !== undefined && { reorderLeadDays }),
      ...(deliveryForm !== undefined && { deliveryForm }),
      // v1.8.5 — injection-site tracking opt-in + per-medication allowed
      // sites. Field-by-field; `false` / `[]` are valid explicit values
      // (deactivate tracking / clear the per-med restriction).
      ...(trackInjectionSites !== undefined && { trackInjectionSites }),
      ...(allowedInjectionSites !== undefined && { allowedInjectionSites }),
      ...(active !== undefined && { active }),
      ...(notificationsEnabled !== undefined && { notificationsEnabled }),
      // v1.7.0 — iOS reminder flags, field-by-field.
      ...(liveActivityEnabled !== undefined && { liveActivityEnabled }),
      ...(criticalAlarmEnabled !== undefined && { criticalAlarmEnabled }),
      // v1.9.0 — optional drug-classification codes (ATC / RxNorm).
      // Field-by-field; `null` is a valid explicit value (clears the code).
      ...(atcCode !== undefined && { atcCode }),
      ...(rxNormCode !== undefined && { rxNormCode }),
      // v1.5 scheduling primitives — pass-through when supplied.
      // `startsOn` / `endsOn` are `Date | null | undefined` (the
      // schema lets the user clear them explicitly with null).
      ...(startsOn !== undefined && { startsOn }),
      ...(normalisedEndsOn !== undefined && { endsOn: normalisedEndsOn }),
      ...(oneShot !== undefined && { oneShot }),
      // v1.16.11 — as-needed flag, field-by-field (the invariants above
      // already guaranteed the medication ends schedule-consistent).
      ...(asNeeded !== undefined && { asNeeded }),
      ...(normalisedSchedules && {
        schedules: {
          create: normalisedSchedules.map((n) => n.createData),
        },
      }),
    };

    const withoutNotifications = { ...baseUpdateData } as Record<
      string,
      unknown
    >;
    delete withoutNotifications.notificationsEnabled;
    const hasPausedAtPatch = Object.keys(pausedAtPatch).length > 0;
    const hasNotificationsPatch = notificationsEnabled !== undefined;

    const updateCandidates: Array<Record<string, unknown>> = [
      { ...baseUpdateData, ...pausedAtPatch },
    ];
    if (hasPausedAtPatch) {
      updateCandidates.push(baseUpdateData);
    }
    if (hasNotificationsPatch) {
      updateCandidates.push({ ...withoutNotifications, ...pausedAtPatch });
      if (hasPausedAtPatch) {
        updateCandidates.push(withoutNotifications);
      }
    }

    let medication;
    let lastUpdateErr: unknown;
    for (const candidate of updateCandidates) {
      try {
        medication = await prisma.medication.update({
          where: { id },
          data: candidate,
          include: { schedules: true },
        });
        break;
      } catch (updateErr) {
        lastUpdateErr = updateErr;
      }
    }
    if (!medication) throw lastUpdateErr;

    // v1.25 H-MED1 — durable pause intervals. The `pausedAt` column is a
    // single live marker that resume clears, so the paused window is
    // irrecoverable once resumed and every paused day's slot collapses to
    // "missed" in the compliance denominator. Mirror the live transition
    // onto an additive era record the rate paths read: a pause opens an era
    // (resumedAt null), a resume closes the latest open era. `userId` comes
    // from the authenticated session; the data object is built field-by-field.
    if (active === false && existing.active) {
      await prisma.medicationPauseEra.create({
        data: {
          medicationId: id,
          userId: user.id,
          pausedAt: new Date(),
          resumedAt: null,
        },
      });
    } else if (active === true && !existing.active) {
      await prisma.medicationPauseEra.updateMany({
        where: { medicationId: id, userId: user.id, resumedAt: null },
        data: { resumedAt: new Date() },
      });
    }

    // Apply the v1.5.5 primary-schedule grace bridge after the
    // medication update so a failure here doesn't roll the medication
    // edit back. Re-read the row so the response shape carries the
    // converged grace value.
    if (primaryScheduleGracePatch) {
      await prisma.medicationSchedule.update({
        where: { id: primaryScheduleGracePatch.scheduleId },
        data: {
          reminderGraceMinutes: primaryScheduleGracePatch.reminderGraceMinutes,
        },
      });
      const refreshed = await prisma.medication.findUnique({
        where: { id },
        include: { schedules: true },
      });
      if (refreshed) {
        medication = refreshed;
      }
    }

    const normalizedCategory =
      category !== undefined
        ? await setMedicationCategory(id, category)
        : ((await getMedicationCategories([id]))[id] ?? "OTHER");

    await auditLog("medication.update", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id },
    });

    annotate({
      action: {
        name: "medication.update",
        entity_type: "medication",
        entity_id: id,
      },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the schedule change.
    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess({
      ...medication,
      unitsPerDose: Number(medication.unitsPerDose),
      category: normalizedCategory,
    });
  },
);

export const DELETE = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.5.5 C-E3-3 — ownership via the shared helper. The DELETE
    // branch needs the medication name for the audit-row detail; pull
    // it after the guard passes.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;
    const existing = await prisma.medication.findUnique({
      where: { id },
      select: { name: true },
    });
    if (!existing) {
      return apiError("Medication not found", 404);
    }

    // Revoke API tokens scoped to this medication
    const medicationScope = `medication:${id}:ingest`;
    await prisma.apiToken.updateMany({
      where: {
        userId: user.id,
        revoked: false,
        permissions: { has: medicationScope },
      },
      data: { revoked: true },
    });

    await deleteMedicationCategory(id);
    await prisma.medication.delete({ where: { id } });

    await auditLog("medication.delete", {
      userId: user.id,
      ipAddress: getClientIp(request),
      details: { medicationId: id, name: existing.name },
    });

    annotate({
      action: {
        name: "medication.delete",
        entity_type: "medication",
        entity_id: id,
      },
    });

    // v1.4.34 IW-G — bust per-user medications + compliance + achievement
    // caches so the next read reflects the deletion.
    invalidateUserMedications(user.id, { evict: true });

    return apiSuccess({ deleted: true });
  },
);
