/**
 * The UI language and the stored language are resolved from different
 * evidence, and only one of them is ever shown to the person reading.
 *
 * `resolveServerLocale` / `resolveInitialLocale` answer a REQUEST: the
 * `healthlog-locale` cookie first, then `User.locale`, then Accept-Language.
 * Two of those three rungs are invisible to anything without a request, so
 * a browser can render the whole app in German while the column says
 * English.
 *
 * Everything written outside a request reads the column alone —
 * `resolveJobLocale` for the nightly writers, `resolveLocaleForUser` for the
 * Coach tool executor and the MCP reads. So a diverged column does not show
 * up as a wrong menu or a wrong button. It shows up as one paragraph of
 * generated prose in the wrong language, sitting in a page that is otherwise
 * correct, which is exactly how it was reported.
 *
 * These are the two ways a browser gets a language the column never hears
 * about. They are the reason `getSession` reconciles the column from the
 * cookie: the client's fire-and-forget PUT is the only thing that ever
 * closed this gap, and a request that never arrives leaves the divergence
 * standing for as long as the account exists.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCookies = vi.fn();
const mockHeaders = vi.fn();
vi.mock("next/headers", () => ({
  cookies: (...args: unknown[]) => mockCookies(...args),
  headers: (...args: unknown[]) => mockHeaders(...args),
}));

const mockGetSessionUserLocale = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getSessionUserLocale: (...args: unknown[]) =>
    mockGetSessionUserLocale(...args),
}));

vi.mock("@/lib/app-settings", () => ({
  getOperatorDefaultLocale: vi.fn(async () => null),
}));

import { resolveInitialLocale } from "@/lib/i18n/resolve-initial-locale";
import { resolveJobLocale } from "@/lib/i18n/job-locale";

function cookieStoreWith(value: string | undefined) {
  return {
    get: (name: string) =>
      name === "healthlog-locale" && value !== undefined
        ? { name, value }
        : undefined,
  };
}

function headersWith(acceptLanguage: string | null) {
  return {
    get: (name: string) =>
      name.toLowerCase() === "accept-language" ? acceptLanguage : null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCookies.mockResolvedValue(cookieStoreWith(undefined));
  mockHeaders.mockResolvedValue(headersWith(null));
  mockGetSessionUserLocale.mockResolvedValue(null);
});

describe("a browser can read German while the column says English", () => {
  it("Accept-Language alone: German UI, English background prose", async () => {
    // The account has never opened the language picker, so the column is
    // NULL, and the browser asks for German.
    mockGetSessionUserLocale.mockResolvedValue(null);
    mockHeaders.mockResolvedValue(headersWith("de-DE,de;q=0.9,en;q=0.5"));

    await expect(resolveInitialLocale()).resolves.toBe("de");
    await expect(resolveJobLocale(null)).resolves.toBe("en");
  });

  it("cookie alone: German UI, English background prose", async () => {
    // The picker was used at some point, so the cookie carries German —
    // but the column was left holding the language of the paint that
    // preceded the choice.
    mockCookies.mockResolvedValue(cookieStoreWith("de"));
    mockGetSessionUserLocale.mockResolvedValue("en");

    await expect(resolveInitialLocale()).resolves.toBe("de");
    await expect(resolveJobLocale("en")).resolves.toBe("en");
  });

  it("the cookie outranks the column on every request that has one", async () => {
    // Which is why the divergence is invisible: nothing the user looks at
    // reads the column, so a wrong column produces no wrong screen until a
    // job writes a sentence with it.
    mockCookies.mockResolvedValue(cookieStoreWith("de"));
    mockGetSessionUserLocale.mockResolvedValue("en");
    await expect(resolveInitialLocale()).resolves.toBe("de");
    expect(mockGetSessionUserLocale).not.toHaveBeenCalled();
  });
});
