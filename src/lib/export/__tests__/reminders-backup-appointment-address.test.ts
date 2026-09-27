/**
 * An appointment reminder carries no readable copy of the practice address:
 * the address lives encrypted on the practitioner and is resolved when the
 * reminder fires. A file written before that (or before the backfill cleared
 * the copy) must not plant the copy back on restore, and a checkup's own
 * free-text location still round-trips.
 */
import { describe, expect, it, vi } from "vitest";

import { restoreRemindersData } from "@/lib/export/reminders-backup";

function fakeTx() {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    measurementReminderEvent: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    measurementReminder: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      createMany: vi.fn(async (args: { data: Record<string, unknown>[] }) => {
        created.push(...args.data);
        return { count: args.data.length };
      }),
    },
  };
  return { tx, created };
}

const BASE = {
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-01T08:00:00.000Z",
};

describe("restoreRemindersData", () => {
  it("drops the address copy on an appointment reminder and keeps a checkup's location", async () => {
    const { tx, created } = fakeTx();
    await restoreRemindersData(
      tx as never,
      "owner",
      {
        measurementReminders: [
          {
            ...BASE,
            id: "appt",
            label: "Praxis Nord",
            origin: "ENCOUNTER",
            location: "Hauptstr. 1, Berlin",
          },
          {
            ...BASE,
            id: "checkup",
            label: "Blood panel",
            origin: "VORSORGE",
            location: "Labor Mitte",
          },
        ],
        measurementReminderEvents: [],
      },
      [],
    );
    expect(created.map((row) => [row.id, row.location])).toEqual([
      ["appt", null],
      ["checkup", "Labor Mitte"],
    ]);
  });
});
