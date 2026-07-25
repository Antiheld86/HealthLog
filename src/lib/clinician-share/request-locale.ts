/**
 * The viewer's locale on a share surface.
 *
 * A share link has no session, so the locale comes from the in-app cookie the
 * recipient's own browser may carry, then from Accept-Language, then from the
 * default. Extracted from the share page so the PDF download beside it renders
 * in the same language as the page it was downloaded from.
 */
import { cookies, headers } from "next/headers";

import { parseLocaleFromAcceptLanguage } from "@/lib/format-locale";
import { defaultLocale, locales, type Locale } from "@/lib/i18n/config";

export async function resolveShareViewLocale(): Promise<Locale> {
  try {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get("healthlog-locale")?.value;
    if (cookieLocale && (locales as readonly string[]).includes(cookieLocale)) {
      return cookieLocale as Locale;
    }
    const headerList = await headers();
    return parseLocaleFromAcceptLanguage(headerList.get("accept-language"));
  } catch {
    return defaultLocale;
  }
}
