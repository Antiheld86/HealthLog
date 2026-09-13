import { prisma } from "@/lib/db";
import { apiSuccess, apiError } from "@/lib/api-response";
import { decrypt } from "@/lib/crypto";
import { sendViaEmail } from "@/lib/notifications/senders/email";
import type { EmailChannelConfig } from "@/lib/notifications/types";
import { checkRateLimit } from "@/lib/rate-limit";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { isEmailConfigured } from "@/lib/notifications/senders/email-config";
import { answerTestDeliveryFailure } from "@/lib/notifications/test-delivery-failure";

/**
 * POST: send a test email to the configured recipient.
 */
export const POST = apiHandler(async () => {
  const { user } = await requireAuth();

  if (!isEmailConfigured()) {
    return apiError("Email is not configured on this instance", 400);
  }

  const rl = await checkRateLimit(`email-test:${user.id}`, 5, 5 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 5 tests in 5 minutes", 429);
  }

  const channel = await prisma.notificationChannel.findUnique({
    where: { userId_type: { userId: user.id, type: "EMAIL" } },
  });

  if (!channel) {
    return apiError("Email is not configured", 400);
  }

  const config = JSON.parse(decrypt(channel.config)) as EmailChannelConfig;

  if (!config.recipient) {
    return apiError("A recipient address is required", 400);
  }

  const result = await sendViaEmail(config, {
    eventType: "SYSTEM_ALERT",
    userId: user.id,
    title: "HealthLog Test",
    message:
      "HealthLog: Connection successful! Email notifications are active.",
  });

  if (!result.ok) {
    // The mail server, or the way to it, failed: 502 with the code and the
    // SMTP reply code. Only an unnamed internal fault is a 500.
    return answerTestDeliveryFailure(result, {
      channel: "email",
      label: "The mail server",
      fallbackMessage: "Failed to send test email",
    });
  }

  annotate({
    action: { name: "settings.email.test" },
    meta: { success: true },
  });

  return apiSuccess({ sent: true });
});
