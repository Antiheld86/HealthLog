import {
  CHANNEL_TYPE_LABELS,
  type ChannelType,
} from "@/lib/notifications/types";

/** One channel's row in the admin notification test response. */
export interface ChannelTestResult {
  channel: string;
  success: boolean;
  error?: string;
  errorCode?: string;
  upstreamStatus?: number;
  smtpCode?: number;
}

/**
 * One line per failing channel for the admin test toast: the channel name,
 * the cause in the admin's language (the same `settings.testConnection.errors`
 * vocabulary the settings cards use), and the HTTP status or SMTP reply code.
 * A row without a known code falls back to the route's own sentence.
 */
export function describeChannelTestFailures(
  results: ReadonlyArray<ChannelTestResult>,
  t: (key: string) => string,
): string[] {
  return results
    .filter((r) => !r.success)
    .map((r) => {
      const label = CHANNEL_TYPE_LABELS[r.channel as ChannelType] ?? r.channel;
      const key = r.errorCode
        ? `settings.testConnection.errors.${r.errorCode}`
        : null;
      const translated = key ? t(key) : null;
      const cause =
        translated && translated !== key
          ? translated
          : (r.error ?? t("admin.notificationTestFailed"));
      const code =
        typeof r.upstreamStatus === "number"
          ? ` (HTTP ${r.upstreamStatus})`
          : typeof r.smtpCode === "number"
            ? ` (SMTP ${r.smtpCode})`
            : "";
      return `${label}: ${cause}${code}`;
    });
}
