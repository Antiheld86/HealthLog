/**
 * Every route that checks a password or a second factor is a guessing oracle,
 * and every one must be throttled and must record a refused guess.
 *
 * The passkey-enrollment re-proof verified a password and a TOTP code with
 * neither: a stolen session could guess there as fast as it could send
 * requests, and nothing in the audit log would show it. Behavioural tests pin
 * each route that was fixed; this freezes the SET, so a new route that starts
 * verifying a credential has to be listed here, and the listing asks the two
 * questions at the moment it is added.
 *
 * Matching is on the verifier's name anywhere in the file, not on an import
 * shape, so an aliased import still counts. It remains a tripwire: it proves a
 * throttle and an audit call are present in the file, not that they sit on the
 * right branch — the per-route tests do that.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const APP = join(process.cwd(), "src", "app");

const VERIFIER =
  /\b(verifyPassword|verifyPasswordOrDummy|verifyMfaFactor|verifyTotp|verifyMfaAuthentication|verifyAuthentication|verifyExistingFactorProof|checkCookieEnrollmentProof)\b/;

const THROTTLE =
  /\b(checkRateLimit|checkAuthSurfaceRateLimit|throttleReproof|checkCookieEnrollmentProof|reserveChallengeAttempt)\s*\(/;

const AUDIT =
  /\b(auditLog|recordReproofFailure|checkCookieEnrollmentProof)\s*\(/;

/**
 * Every file under src/app that verifies a credential. Adding one means
 * answering, in its own tests, how a wrong guess is limited and recorded.
 */
const EXPECTED = [
  "api/auth/login/route.ts",
  "api/auth/me/mfa/disable/route.ts",
  "api/auth/me/mfa/totp/confirm/route.ts",
  "api/auth/me/mfa/totp/setup/route.ts",
  "api/auth/me/mfa/webauthn/register/options/route.ts",
  "api/auth/mfa/verify/route.ts",
  "api/auth/mfa/webauthn/verify/route.ts",
  "api/auth/passkey/login-verify/route.ts",
  "api/auth/passkey/register-options/route.ts",
  "api/auth/password/route.ts",
  "api/auth/reproof/route.ts",
  "api/auth/step-up/route.ts",
];

function verifyingFiles(): string[] {
  return walkSourceFiles(APP, { floor: 500 })
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !/\.test\.tsx?$/.test(p))
    .filter((p) => VERIFIER.test(readFileSync(join(APP, p), "utf8")));
}

describe("credential-verifying routes", () => {
  const found = verifyingFiles();

  it("finds the verifying routes at all", () => {
    // An empty match agrees with nothing and would pass on a tree never read.
    expect(found.length).toBeGreaterThanOrEqual(EXPECTED.length);
  });

  it("is exactly the listed set", () => {
    expect(found).toEqual(EXPECTED);
  });

  it.each(EXPECTED)("%s is throttled and audits refusals", (rel) => {
    const src = readFileSync(join(APP, rel), "utf8");
    expect(src).toMatch(THROTTLE);
    expect(src).toMatch(AUDIT);
  });
});
