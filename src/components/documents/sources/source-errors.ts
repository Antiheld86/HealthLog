/**
 * The document picker's error codes (#1038), as sentences. One place for the
 * sheet and the settings card, so the same refusal reads the same on both.
 * Every branch names its key literally so the i18n coverage guard can see it.
 */
import { ApiError } from "@/lib/api/api-fetch";

type T = (key: string, params?: Record<string, string | number>) => string;

/** The `meta.errorCode` a failed request carried, if any. */
export function errorCodeOf(err: unknown): string | undefined {
  if (err instanceof ApiError) {
    const code = err.meta?.errorCode;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/** Is this a refusal that will not change on the next document? */
export function isStoppingError(code: string | undefined): boolean {
  return (
    code === "documents.inbound.rateLimited" ||
    code === "documents.inbound.quotaExceeded" ||
    code === "documents.sources.authRefused" ||
    code === "documents.sources.permissionMissing" ||
    code === "documents.sources.unreachable" ||
    code === "documents.sources.originNotAllowed" ||
    code === "documents.sources.notConnected" ||
    code === "documents.sources.unavailable" ||
    code === "documents.sources.browserOnly" ||
    code === "documents.sources.linkTargetNotFound"
  );
}

export function sourceErrorMessage(t: T, code: string | undefined): string {
  switch (code) {
    case "documents.sources.unavailable":
      return t("documents.sourcePicker.errors.unavailable");
    case "documents.sources.notConnected":
      return t("documents.sourcePicker.errors.notConnected");
    case "documents.sources.originNotAllowed":
      return t("documents.sourcePicker.errors.originNotAllowed");
    case "documents.sources.unreachable":
      return t("documents.sourcePicker.errors.unreachable");
    case "documents.sources.redirected":
      return t("documents.sourcePicker.errors.redirected");
    case "documents.sources.authRefused":
      return t("documents.sourcePicker.errors.authRefused");
    case "documents.sources.permissionMissing":
      return t("documents.sourcePicker.errors.permissionMissing");
    case "documents.sources.versionTooOld":
      return t("documents.sourcePicker.errors.versionTooOld");
    case "documents.sources.badResponse":
      return t("documents.sourcePicker.errors.badResponse");
    case "documents.sources.notFound":
      return t("documents.sourcePicker.errors.notFound");
    case "documents.sources.linkTargetNotFound":
      return t("documents.sourcePicker.errors.linkTargetNotFound");
    case "documents.sources.rateLimited":
      return t("documents.sourcePicker.errors.rateLimited");
    case "documents.sources.browserOnly":
      return t("documents.sourcePicker.errors.browserOnly");
    case "documents.sources.invalidAddress":
      return t("documents.sourcePicker.errors.invalidAddress");
    case "documents.sources.organizationRequired":
      return t("documents.sourcePicker.errors.organizationRequired");
    case "documents.sources.tokenRequired":
      return t("documents.sourcePicker.errors.tokenRequired");
    case "documents.inbound.fileTooLarge":
      return t("documents.sourcePicker.errors.fileTooLarge");
    case "documents.inbound.quotaExceeded":
      return t("documents.sourcePicker.errors.quotaExceeded");
    case "documents.inbound.fileType":
      return t("documents.sourcePicker.errors.fileType");
    case "documents.inbound.rateLimited":
      return t("documents.sourcePicker.errors.uploadLimit");
    case "documents.inbound.uploadBusy":
      return t("documents.sourcePicker.errors.uploadBusy");
    case "module.disabled":
      return t("documents.sourcePicker.errors.moduleDisabled");
    default:
      return t("documents.sourcePicker.errors.generic");
  }
}
