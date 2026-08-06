import type { NextRequest } from "next/server";

import {
  apiHandler,
  requireGuardianAuth,
  SharingAccessDeniedError,
} from "@/lib/api-handler";
import {
  apiError,
  apiSuccess,
  getClientIp,
  returnAllZodIssues,
  safeJson,
} from "@/lib/api-response";
import { auditLog } from "@/lib/auth/audit";
import {
  invalidateUserInsightsLayout,
  invalidateUserProfile,
} from "@/lib/cache/invalidate";
import { prisma, toJson } from "@/lib/db";
import { type ThresholdOverridesJson } from "@/lib/analytics/effective-range";
import {
  isManagedRecordSettingsFamily,
  managedModulePreferencesFrom,
  parseManagedRecordSettingsPatch,
  resolveGuardianRecordSettingsAccess,
} from "@/lib/record-settings";
import {
  resolveInsightsLayout,
  serializeInsightsLayout,
} from "@/lib/insights-layout";
import { annotate } from "@/lib/logging/context";
import { parseCoachPrefs } from "@/lib/validations/coach-prefs";
import {
  parseNotificationPrefs,
  resolveNotificationPrefs,
} from "@/lib/validations/notification-prefs";

export const dynamic = "force-dynamic";

type RouteParams = { params: Promise<{ family: string }> };

async function resolveManagedRecordSettings(params: RouteParams["params"]) {
  const { family: rawFamily } = await params;
  if (!isManagedRecordSettingsFamily(rawFamily)) return null;

  const context = await requireGuardianAuth();
  const access = resolveGuardianRecordSettingsAccess(context);
  if (!access) throw new SharingAccessDeniedError();

  return { access, family: rawFamily };
}

/** Each response names the target record and only one field-specific DTO. */
export const GET = apiHandler(
  async (_request: NextRequest, { params }: RouteParams) => {
    const resolved = await resolveManagedRecordSettings(params);
    if (!resolved) return apiError("Settings family not found", 404);
    const { access, family } = resolved;

    const record = await prisma.user.findUnique({
      where: { id: access.recordId },
      select: {
        displayName: true,
        heightCm: true,
        dateOfBirth: true,
        gender: true,
        locale: true,
        timezone: true,
        unitPreference: true,
        timeFormat: true,
        dateFormat: true,
        modulePreferencesJson: true,
        moodReminderEnabled: true,
        notificationPrefs: true,
        thresholdsJson: true,
        disableCoach: true,
        coachPrefsJson: true,
        insightsLayoutJson: true,
      },
    });
    if (!record) return apiError("Record not found", 404);

    let settings: unknown;
    switch (family) {
      case "profile":
        settings = {
          displayName: record.displayName,
          heightCm: record.heightCm,
          dateOfBirth: record.dateOfBirth?.toISOString().slice(0, 10) ?? null,
          gender: record.gender,
          locale: record.locale,
          timezone: record.timezone,
          unitPreference: record.unitPreference,
          timeFormat: record.timeFormat,
          dateFormat: record.dateFormat,
        };
        break;
      case "modules":
        settings = {
          modulePreferences: managedModulePreferencesFrom(
            record.modulePreferencesJson,
          ),
        };
        break;
      case "notifications": {
        const preferences = parseNotificationPrefs(record.notificationPrefs);
        settings = {
          moodReminderEnabled: record.moodReminderEnabled,
          notificationPreferences: {
            medication: {
              lowStockRunwayDays: preferences.medication.lowStockRunwayDays,
              reorderLeadDays: preferences.medication.reorderLeadDays,
            },
            mood: { reminderHour: preferences.mood.reminderHour },
          },
        };
        break;
      }
      case "thresholds":
        settings = {
          overrides: (record.thresholdsJson ?? {}) as ThresholdOverridesJson,
        };
        break;
      case "coach": {
        const preferences = parseCoachPrefs(record.coachPrefsJson);
        settings = {
          disableCoach: record.disableCoach,
          preferences: {
            tone: preferences.tone,
            verbosity: preferences.verbosity,
            excludeMetrics: preferences.excludeMetrics,
            showEvidenceByDefault: preferences.showEvidenceByDefault,
            defaultWindow: preferences.defaultWindow,
            ...(preferences.dataClusters !== undefined
              ? { dataClusters: preferences.dataClusters }
              : {}),
          },
        };
        break;
      }
      case "insights":
        settings = { layout: resolveInsightsLayout(record.insightsLayoutJson) };
        break;
    }

    annotate({ action: { name: `record-settings.${family}.get` } });
    return apiSuccess({ recordId: access.recordId, family, settings });
  },
);

export const PATCH = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const resolved = await resolveManagedRecordSettings(params);
    if (!resolved) return apiError("Settings family not found", 404);
    const { access, family } = resolved;
    const { data: body, error } = await safeJson(request, {
      maxBytes: 64 * 1024,
    });
    if (error) return error;

    try {
      let settings: unknown;
      let changed: readonly string[];

      switch (family) {
        case "profile": {
          const patch = parseManagedRecordSettingsPatch("profile", body);
          const data = {
            ...(patch.displayName !== undefined
              ? { displayName: patch.displayName }
              : {}),
            ...(patch.heightCm !== undefined
              ? { heightCm: patch.heightCm }
              : {}),
            ...(patch.dateOfBirth !== undefined
              ? {
                  dateOfBirth: patch.dateOfBirth
                    ? new Date(`${patch.dateOfBirth}T00:00:00.000Z`)
                    : null,
                }
              : {}),
            ...(patch.gender !== undefined ? { gender: patch.gender } : {}),
            ...(patch.locale !== undefined ? { locale: patch.locale } : {}),
            ...(patch.timezone !== undefined
              ? { timezone: patch.timezone }
              : {}),
            ...(patch.unitPreference !== undefined
              ? { unitPreference: patch.unitPreference }
              : {}),
            ...(patch.timeFormat !== undefined
              ? { timeFormat: patch.timeFormat }
              : {}),
            ...(patch.dateFormat !== undefined
              ? { dateFormat: patch.dateFormat }
              : {}),
          };
          const record = await prisma.user.update({
            where: { id: access.recordId },
            data,
            select: {
              displayName: true,
              heightCm: true,
              dateOfBirth: true,
              gender: true,
              locale: true,
              timezone: true,
              unitPreference: true,
              timeFormat: true,
              dateFormat: true,
            },
          });
          invalidateUserProfile(access.recordId);
          settings = {
            ...record,
            dateOfBirth: record.dateOfBirth?.toISOString().slice(0, 10) ?? null,
          };
          changed = Object.keys(patch);
          break;
        }
        case "modules": {
          const patch = parseManagedRecordSettingsPatch("modules", body);
          const current = await prisma.user.findUnique({
            where: { id: access.recordId },
            select: { modulePreferencesJson: true },
          });
          const modulePreferences = {
            ...managedModulePreferencesFrom(current?.modulePreferencesJson),
            ...patch.modulePreferences,
          };
          await prisma.user.update({
            where: { id: access.recordId },
            data: { modulePreferencesJson: toJson(modulePreferences) },
          });
          settings = { modulePreferences };
          changed = Object.keys(patch.modulePreferences);
          break;
        }
        case "notifications": {
          const patch = parseManagedRecordSettingsPatch("notifications", body);
          const current = await prisma.user.findUnique({
            where: { id: access.recordId },
            select: { notificationPrefs: true },
          });
          const notificationPreferences = patch.notificationPreferences
            ? resolveNotificationPrefs(
                current?.notificationPrefs,
                patch.notificationPreferences,
              )
            : undefined;
          const record = await prisma.user.update({
            where: { id: access.recordId },
            data: {
              ...(patch.moodReminderEnabled !== undefined
                ? { moodReminderEnabled: patch.moodReminderEnabled }
                : {}),
              ...(notificationPreferences !== undefined
                ? { notificationPrefs: toJson(notificationPreferences) }
                : {}),
            },
            select: { moodReminderEnabled: true, notificationPrefs: true },
          });
          const preferences = parseNotificationPrefs(record.notificationPrefs);
          settings = {
            moodReminderEnabled: record.moodReminderEnabled,
            notificationPreferences: {
              medication: {
                lowStockRunwayDays: preferences.medication.lowStockRunwayDays,
                reorderLeadDays: preferences.medication.reorderLeadDays,
              },
              mood: { reminderHour: preferences.mood.reminderHour },
            },
          };
          changed = Object.keys(patch);
          break;
        }
        case "thresholds": {
          const patch = parseManagedRecordSettingsPatch("thresholds", body);
          const current = await prisma.user.findUnique({
            where: { id: access.recordId },
            select: { thresholdsJson: true },
          });
          const overrides = {
            ...((current?.thresholdsJson ?? {}) as ThresholdOverridesJson),
            ...patch.overrides,
          };
          await prisma.user.update({
            where: { id: access.recordId },
            data: { thresholdsJson: toJson(overrides) },
          });
          settings = { overrides };
          changed = Object.keys(patch.overrides);
          break;
        }
        case "coach": {
          const patch = parseManagedRecordSettingsPatch("coach", body);
          const current = await prisma.user.findUnique({
            where: { id: access.recordId },
            select: { coachPrefsJson: true },
          });
          const nextPreferences = patch.preferences
            ? {
                ...parseCoachPrefs(current?.coachPrefsJson),
                ...patch.preferences,
              }
            : undefined;
          const record = await prisma.user.update({
            where: { id: access.recordId },
            data: {
              ...(patch.disableCoach !== undefined
                ? { disableCoach: patch.disableCoach }
                : {}),
              ...(nextPreferences !== undefined
                ? {
                    coachPrefsJson: toJson(nextPreferences),
                    insightsExcludeMetrics: nextPreferences.excludeMetrics,
                  }
                : {}),
            },
            select: { disableCoach: true, coachPrefsJson: true },
          });
          const preferences = parseCoachPrefs(record.coachPrefsJson);
          settings = {
            disableCoach: record.disableCoach,
            preferences: {
              tone: preferences.tone,
              verbosity: preferences.verbosity,
              excludeMetrics: preferences.excludeMetrics,
              showEvidenceByDefault: preferences.showEvidenceByDefault,
              defaultWindow: preferences.defaultWindow,
              ...(preferences.dataClusters !== undefined
                ? { dataClusters: preferences.dataClusters }
                : {}),
            },
          };
          changed = Object.keys(patch);
          break;
        }
        case "insights": {
          const patch = parseManagedRecordSettingsPatch("insights", body);
          const current = await prisma.user.findUnique({
            where: { id: access.recordId },
            select: { insightsLayoutJson: true },
          });
          const layout = serializeInsightsLayout(
            patch.layout,
            resolveInsightsLayout(current?.insightsLayoutJson),
          );
          await prisma.user.update({
            where: { id: access.recordId },
            data: { insightsLayoutJson: toJson(layout) },
          });
          invalidateUserInsightsLayout(access.recordId);
          settings = { layout };
          changed = ["layout"];
          break;
        }
      }

      await auditLog(`record-settings.${family}.update`, {
        userId: access.recordId,
        actorUserId: access.actorId,
        ipAddress: getClientIp(request),
        details: { changed },
      });
      annotate({
        action: { name: `record-settings.${family}.update` },
        meta: { recordId: access.recordId, changed },
      });
      return apiSuccess({ recordId: access.recordId, family, settings });
    } catch (error) {
      if (error instanceof Error && "issues" in error) {
        return returnAllZodIssues(error as never, 422);
      }
      throw error;
    }
  },
);
