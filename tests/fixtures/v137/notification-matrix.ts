export const NOTIFICATION_CHANNELS = [
  "apns",
  "web-push",
  "telegram",
  "ntfy",
] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

const GUARDIAN_RECIPIENTS = [
  { id: "guardian-alpha", locale: "en" },
  { id: "guardian-beta", locale: "de" },
] as const;

const MANAGED_RECORDS = [
  "managed-profile-alpha",
  "managed-profile-beta",
] as const;

export interface NotificationDeliveryFixture {
  readonly recordUserId: (typeof MANAGED_RECORDS)[number];
  readonly recipientUserId: (typeof GUARDIAN_RECIPIENTS)[number]["id"];
  readonly recipientLocale: (typeof GUARDIAN_RECIPIENTS)[number]["locale"];
  readonly channel: NotificationChannel;
  readonly interactive: false;
}

export const NOTIFICATION_DELIVERY_MATRIX = MANAGED_RECORDS.flatMap(
  (recordUserId) =>
    GUARDIAN_RECIPIENTS.flatMap(({ id: recipientUserId, locale }) =>
      NOTIFICATION_CHANNELS.map((channel) => ({
        recordUserId,
        recipientUserId,
        recipientLocale: locale,
        channel,
        interactive: false,
      })),
    ),
) as readonly NotificationDeliveryFixture[];
