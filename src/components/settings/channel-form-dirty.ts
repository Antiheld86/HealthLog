/**
 * Whether a notification channel card's form differs from what is saved.
 *
 * The Test button on these cards always sends through the saved channel
 * config, never the form. While the form holds an unsaved change, a test
 * would report on something other than what is on screen, and a "Saved"
 * note left over from an earlier save would say the opposite of the truth.
 * A secret field (header value, auth token, bot token) is write-only: the
 * server never returns it, so any typed value counts as a change.
 */

export function isWebhookFormDirty(
  form: {
    url: string;
    headerName: string;
    headerValue: string;
    format: "generic" | "gotify";
  },
  saved: { url: string; headerName: string; format?: string } | undefined,
): boolean {
  if (!saved) return false;
  const savedFormat = saved.format === "gotify" ? "gotify" : "generic";
  return (
    form.url !== saved.url ||
    form.headerName !== saved.headerName ||
    form.headerValue !== "" ||
    form.format !== savedFormat
  );
}

export function isNtfyFormDirty(
  form: { serverUrl: string; topic: string; authToken: string },
  saved: { serverUrl: string; topic: string } | undefined,
): boolean {
  if (!saved) return false;
  return (
    form.serverUrl !== saved.serverUrl ||
    form.topic !== saved.topic ||
    form.authToken !== ""
  );
}

export function isEmailFormDirty(
  form: { recipient: string },
  saved: { recipient: string } | undefined,
): boolean {
  if (!saved) return false;
  return form.recipient !== saved.recipient;
}

export function isTelegramFormDirty(
  form: { botToken: string; chatId: string },
  saved: { chatId?: string | null } | undefined,
): boolean {
  if (!saved) return false;
  return form.botToken.trim() !== "" || form.chatId !== (saved.chatId ?? "");
}
