/**
 * The human name of a visit kind, in the record owner's language.
 *
 * Spelled out with literal `t()` calls rather than an interpolated key, for the
 * same reason the restore-skip catalogue labels are: an interpolated key is
 * invisible to `i18n-call-site-coverage`, so a renamed or missing kind would
 * ship as raw dot notation instead of failing CI.
 *
 * This is not decoration. The value becomes a `MeasurementReminder.label`, and
 * that label IS the push body — so the fallback for a visit with no practice
 * attached is read off a lock screen. A raw enum constant there is the schema
 * leaking into the product.
 */
import type { EncounterKind } from "@/generated/prisma/client";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";

function resolveLocale(locale: string | null | undefined): Locale {
  return locales.includes(locale as Locale)
    ? (locale as Locale)
    : defaultLocale;
}

export function encounterKindLabel(
  kind: EncounterKind,
  locale: string | null | undefined,
): string {
  const { t } = getServerTranslator(resolveLocale(locale));
  switch (kind) {
    case "ROUTINE":
      return t("encounters.kind.routine");
    case "ACUTE":
      return t("encounters.kind.acute");
    case "SPECIALIST":
      return t("encounters.kind.specialist");
    case "PREVENTIVE":
      return t("encounters.kind.preventive");
    case "EMERGENCY":
      return t("encounters.kind.emergency");
    case "HOSPITAL":
      return t("encounters.kind.hospital");
    case "THERAPY":
      return t("encounters.kind.therapy");
    default:
      return t("encounters.kind.other");
  }
}
