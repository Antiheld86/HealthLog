/**
 * The never-nag property, proven rather than asserted in prose.
 *
 * A booked visit's reminder is a one-shot: both cadence columns are NULL, which
 * the schema documents as "anchored on `anchorDate`". The claim that follows —
 * that it can fire once and never again — is a claim about the SAME function
 * the cron calls to advance a fired reminder. If that function returned an
 * instant here, the row would re-arm every tick and nag forever about an
 * appointment that already happened, and nothing else in the system would
 * notice: the row is excluded from every list a person can see.
 *
 * The module said this test existed. It did not. That is the reason it does
 * now: a comment claiming a proof is worse than no comment, because it stops
 * the next reader looking.
 */
import { describe, expect, it } from "vitest";

import {
  appointmentNextDueAfterFiring,
  appointmentNotifyHour,
} from "@/lib/encounters/appointment-reminder";

const TZ = "Europe/Berlin";
const APPOINTMENT = new Date("2026-09-14T07:40:00.000Z");

/** The row shape a minted appointment reminder actually carries. */
const oneShot = {
  intervalDays: null,
  rrule: null,
  anchorDate: APPOINTMENT,
  notifyHour: 9,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("a fired appointment reminder can never re-arm", () => {
  it("has no next occurrence once its instant has passed", () => {
    const afterItFired = new Date("2026-09-14T08:00:00.000Z");

    expect(appointmentNextDueAfterFiring(oneShot, TZ, afterItFired)).toBeNull();
  });

  it("still has none a year later", () => {
    // The failure this rules out is a cadence quietly inferred from the anchor,
    // which would look correct on the day and nag every year after it.
    expect(
      appointmentNextDueAfterFiring(
        oneShot,
        TZ,
        new Date("2027-10-01T00:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("is not vacuous: a cadenced reminder DOES get a next occurrence", () => {
    // Without this, "returns null" would also pass for a function that returns
    // null unconditionally, which is the shape of green this repository keeps
    // being bitten by.
    const cadenced = { ...oneShot, intervalDays: 30 };

    expect(
      appointmentNextDueAfterFiring(
        cadenced,
        TZ,
        new Date("2026-09-14T08:00:00.000Z"),
      ),
    ).not.toBeNull();
  });
});

describe("the hour the nudge fires", () => {
  it("is the appointment's own local hour, not the server's", () => {
    // 07:40 UTC is 09:40 in Berlin, so the nudge belongs at 9.
    expect(appointmentNotifyHour(APPOINTMENT, TZ)).toBe(9);
  });

  it("reads midnight as hour zero rather than twenty-four", () => {
    // Some locales format midnight as "24"; the column is 0–23.
    expect(
      appointmentNotifyHour(new Date("2026-09-14T22:00:00.000Z"), TZ),
    ).toBe(0);
  });

  it("follows the record's zone, so the same instant differs by zone", () => {
    expect(appointmentNotifyHour(APPOINTMENT, "UTC")).toBe(7);
  });
});
