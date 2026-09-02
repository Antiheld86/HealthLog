/**
 * Locale resolution for background paths.
 *
 * A job or worker has no request to read a cookie or Accept-Language from,
 * so the stored `User.locale` is the only per-user signal. When it is NULL
 * (the account never touched the language picker) the operator's configured
 * default locale is the answer, and English only when that is unset or
 * invalid as well.
 *
 * Every nightly writer that resolved a user row's locale used to land on
 * English for a NULL column, so a German-language instance warmed its
 * briefings in English while every request-driven write was German. This
 * is the one place the job-side fallback order lives; the structural guard
 * `src/__tests__/job-locale-resolution-guard.test.ts` keeps the job tree on
 * it. `normalizeLocale` / `coerceLocale` remain for validating a value that
 * is already resolved, such as a queue payload.
 */
import { getOperatorDefaultLocale } from "@/lib/app-settings";
import { defaultLocale, locales, type Locale } from "./config";

function isShippedLocale(value: string | null | undefined): value is Locale {
  return (
    typeof value === "string" && (locales as readonly string[]).includes(value)
  );
}

export async function resolveJobLocale(
  userLocale: string | null | undefined,
): Promise<Locale> {
  if (isShippedLocale(userLocale)) return userLocale;
  const operatorDefault = await getOperatorDefaultLocale();
  if (isShippedLocale(operatorDefault)) return operatorDefault;
  return defaultLocale;
}
