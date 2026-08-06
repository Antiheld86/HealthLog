import {
  apiHandler,
  requireGuardianAuth,
  SharingAccessDeniedError,
} from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import {
  resolveGuardianRecordSettingsAccess,
  toRecordSettingsDto,
} from "@/lib/record-settings";

export const dynamic = "force-dynamic";

/**
 * The active managed record's configuration identity. This is intentionally a
 * distinct record DTO rather than another actor field on `/api/auth/me`.
 */
export const GET = apiHandler(async () => {
  const context = await requireGuardianAuth();
  const access = resolveGuardianRecordSettingsAccess(context);
  if (!access) throw new SharingAccessDeniedError();

  annotate({ action: { name: "record-settings.get" } });

  return apiSuccess(
    toRecordSettingsDto({
      id: access.recordId,
      name: context.user.displayName ?? context.user.username,
      locale: context.user.locale,
      timezone: context.user.timezone,
      recordKind: "managed",
    }),
  );
});
