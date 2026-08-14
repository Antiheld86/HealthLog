/**
 * Query keys — Vorsorge (measurement) reminders (v1.17.1).
 * Part of the centralized factory; aggregated in `./index.ts`.
 */
export const measurementReminderKeys = {
  /**
   * The owner's Vorsorge reminder list. A create / edit / delete / satisfy
   * mutation invalidates this root so the section + the dashboard tile
   * repaint in lockstep.
   */
  measurementReminders: () => ["measurement-reminders"] as const,
  /** Mutation keys — kept in the factory so no bare array reaches a call site. */
  measurementReminderCreate: () => ["measurement-reminders", "create"] as const,
  measurementReminderUpdate: () => ["measurement-reminders", "update"] as const,
  measurementReminderDelete: () => ["measurement-reminders", "delete"] as const,
  measurementReminderSatisfy: () =>
    ["measurement-reminders", "satisfy"] as const,
  /** v1.37.20 (#223) — honest skip + snooze mutations. */
  measurementReminderSkip: () => ["measurement-reminders", "skip"] as const,
  measurementReminderSnooze: () => ["measurement-reminders", "snooze"] as const,
};
