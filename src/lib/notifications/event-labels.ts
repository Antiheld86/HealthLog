/**
 * The i18n key an event type is rendered under.
 *
 * The /notifications matrix builds its rows from the event list the server
 * publishes, so the label for a new event type is never written at a call site
 * — it is derived here. Extracted from the page so the derivation can be
 * pinned by a test without rendering anything, and so the guard that asserts
 * every event type actually HAS its two strings (label + description, six
 * locales) computes the key exactly the way the page does rather than a way
 * that agrees with it today.
 *
 * `MEDICATION_REMINDER` → `notifications.eventMedicationReminder`; the
 * description key is that plus `Desc`.
 */
export function eventTranslationKey(eventType: string): string {
  return (
    "notifications.event" +
    eventType
      .toLowerCase()
      .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      .replace(/^./, (c) => c.toUpperCase())
  );
}

/** The description key that sits under the label in the matrix row. */
export function eventDescriptionTranslationKey(eventType: string): string {
  return `${eventTranslationKey(eventType)}Desc`;
}
