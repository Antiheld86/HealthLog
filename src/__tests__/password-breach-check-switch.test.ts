/**
 * The HaveIBeenPwned check sits behind one operator switch, and nothing
 * reaches it except through that switch.
 *
 * `PASSWORD_BREACH_CHECK_DISABLED` is how an operator stops the one request
 * a password change makes to a third party. A route that imported the raw
 * check from `@/lib/auth/hibp` would keep sending it with the switch on, so
 * the import itself is frozen: only `src/lib/password-breach-check.ts` (and
 * tests) may name that module.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const checkPasswordBreach = vi.fn();
vi.mock("@/lib/auth/hibp", () => ({
  checkPasswordBreach: (password: string) => checkPasswordBreach(password),
}));

const SRC = join(process.cwd(), "src");
const RAW_IMPORT = /from\s+["']@\/lib\/auth\/hibp["']|["']\.\/hibp["']/;

afterEach(() => {
  vi.unstubAllEnvs();
  checkPasswordBreach.mockReset();
});

describe("password breach check switch", () => {
  it("calls the range API when the switch is unset or empty", async () => {
    checkPasswordBreach.mockResolvedValue({ breached: true, count: 3 });
    const { checkPasswordBreachIfEnabled } =
      await import("@/lib/password-breach-check");
    vi.stubEnv("PASSWORD_BREACH_CHECK_DISABLED", "");
    await expect(
      checkPasswordBreachIfEnabled("correct horse battery"),
    ).resolves.toEqual({ breached: true, count: 3 });
    expect(checkPasswordBreach).toHaveBeenCalledTimes(1);
  });

  it.each(["1", "true", "yes"])(
    "makes no request when PASSWORD_BREACH_CHECK_DISABLED=%s",
    async (value) => {
      vi.stubEnv("PASSWORD_BREACH_CHECK_DISABLED", value);
      const { checkPasswordBreachIfEnabled } =
        await import("@/lib/password-breach-check");
      await expect(
        checkPasswordBreachIfEnabled("correct horse battery"),
      ).resolves.toBeNull();
      expect(checkPasswordBreach).not.toHaveBeenCalled();
    },
  );

  it("is the only non-test importer of the raw check", () => {
    const importers = walkSourceFiles(SRC, { floor: 3000 })
      .filter((rel) => !rel.startsWith("generated/"))
      .filter((rel) => !rel.includes("__tests__"))
      .filter((rel) => !rel.endsWith(".test.ts"))
      .filter((rel) => rel !== "lib/auth/hibp.ts")
      .filter((rel) => RAW_IMPORT.test(readFileSync(join(SRC, rel), "utf8")));
    // Non-empty by construction: the wrapper itself must match, or the
    // matcher went stale and this assertion would pass on nothing.
    expect(importers).toEqual(["lib/password-breach-check.ts"]);
  });
});
