import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";

export interface GlobalServiceAvailability {
  telegramGlobal: boolean;
  ntfyGlobal: boolean;
  webPushGlobal: boolean;
  apiGlobal: boolean;
}

export async function getGlobalServiceAvailability(): Promise<GlobalServiceAvailability> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        telegramGlobal: true,
        ntfyGlobal: true,
        webPushGlobal: true,
        apiGlobal: true,
      },
    });

    return {
      telegramGlobal: settings?.telegramGlobal ?? true,
      ntfyGlobal: settings?.ntfyGlobal ?? true,
      webPushGlobal: settings?.webPushGlobal ?? true,
      apiGlobal: settings?.apiGlobal ?? true,
    };
  } catch {
    getEvent()?.addWarning("Failed to load app settings, using defaults");
    return {
      telegramGlobal: true,
      ntfyGlobal: true,
      webPushGlobal: true,
      apiGlobal: true,
    };
  }
}

export async function isApiGloballyEnabled(): Promise<boolean> {
  const settings = await getGlobalServiceAvailability();
  return settings.apiGlobal;
}

export interface ReminderThresholds {
  lateMinutes: number;
  missedMinutes: number;
}

export async function getReminderThresholds(): Promise<ReminderThresholds> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: {
        reminderLateMinutes: true,
        reminderMissedMinutes: true,
      },
    });

    return {
      lateMinutes: settings?.reminderLateMinutes ?? 120,
      missedMinutes: settings?.reminderMissedMinutes ?? 240,
    };
  } catch {
    getEvent()?.addWarning(
      "Failed to load reminder thresholds, using defaults",
    );
    return { lateMinutes: 120, missedMinutes: 240 };
  }
}

/**
 * The operator's configured default locale (`AppSettings.defaultLocale`), or
 * `null` when the settings row is absent or unreadable. Validation against
 * the shipped locale list is the caller's job (`resolveJobLocale`); this only
 * reads the column.
 */
export async function getOperatorDefaultLocale(): Promise<string | null> {
  try {
    const settings = await prisma.appSettings.findUnique({
      where: { id: "singleton" },
      select: { defaultLocale: true },
    });
    return settings?.defaultLocale ?? null;
  } catch {
    getEvent()?.addWarning("Failed to load the operator default locale");
    return null;
  }
}
