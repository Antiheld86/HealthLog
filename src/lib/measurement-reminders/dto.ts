/**
 * v1.17.1 — DTO serializer for Vorsorge (measurement) reminders.
 *
 * Maps the Prisma `MeasurementReminder` row onto the canonical
 * `MeasurementReminderDTO` the web list, dashboard tile, and iOS client
 * all mirror. Dates serialise to ISO-8601 with offset.
 */
import type { MeasurementReminder } from "@/generated/prisma/client";
import type { MeasurementReminderType } from "@/lib/validations/measurement-reminders";

export interface MeasurementReminderDtoShape {
  id: string;
  label: string;
  measurementType: MeasurementReminderType | null;
  intervalDays: number | null;
  rrule: string | null;
  anchorDate: string | null;
  /**
   * v1.18.1 — optional course-window end (ISO-8601). NULL ⇒ open-ended.
   * A Coach-suggested time-boxed protocol carries a non-NULL value and
   * self-expires.
   */
  endsOn: string | null;
  /**
   * v1.18.1 — provenance: `VORSORGE` (user-created) or `COACH` (minted from
   * a Coach cadence suggestion). The UI labels the source.
   *
   * Deliberately two members, while `ReminderOrigin` in the schema has three.
   * The third, `ENCOUNTER`, belongs to a booked visit and does not appear on
   * this surface: every lookup that feeds this mapper excludes it, and the
   * published enum stays closed at these two so the reminder contract does not
   * move. Widening this union is the wrong repair for a type error here — the
   * right one is finding the lookup that lost its exclusion.
   */
  origin: "VORSORGE" | "COACH";
  notifyHour: number;
  location: string | null;
  nextDueAt: string | null;
  lastSatisfiedAt: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * The invariant this mapper enforces: an `ENCOUNTER`-origin row is a booked
 * visit's one-shot reminder and is not part of the measurement-reminder
 * surface at all. Nine lookups keep it out — four list reads (the reminder
 * list route, the daily digest, the insights preventive-care block and the MCP
 * preventive-care tool) and five by-id lookups (read, edit, delete, complete
 * and satisfy), which answer 404 rather than filtering, because an appointment
 * is not addressable by that family.
 *
 * Reaching here means one of the nine lost its filter. The failure is loud on
 * purpose, but note what it cannot undo: on `complete` and `satisfy` the throw
 * used to land AFTER the write, so the caller got a 500 for a mutation that
 * had already happened. Those two now refuse in the lookup, which is why the
 * exclusion belongs in the query and not in a check after it.
 *
 * Proven by `src/__tests__/encounter-reminder-exclusion.test.ts`.
 */
export function toMeasurementReminderDto(
  row: MeasurementReminder,
): MeasurementReminderDtoShape {
  if (row.origin === "ENCOUNTER") {
    throw new Error(
      `toMeasurementReminderDto received an ENCOUNTER-origin reminder (${row.id}). ` +
        "Appointment reminders are excluded from every Vorsorge read surface; " +
        "a read site has lost its origin filter. See " +
        "src/__tests__/encounter-reminder-exclusion.test.ts.",
    );
  }
  return {
    id: row.id,
    label: row.label,
    measurementType: row.measurementType as MeasurementReminderType | null,
    intervalDays: row.intervalDays,
    rrule: row.rrule,
    anchorDate: row.anchorDate ? row.anchorDate.toISOString() : null,
    endsOn: row.endsOn ? row.endsOn.toISOString() : null,
    origin: row.origin,
    notifyHour: row.notifyHour,
    location: row.location,
    nextDueAt: row.nextDueAt ? row.nextDueAt.toISOString() : null,
    lastSatisfiedAt: row.lastSatisfiedAt
      ? row.lastSatisfiedAt.toISOString()
      : null,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
