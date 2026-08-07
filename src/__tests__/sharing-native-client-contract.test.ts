/**
 * v1.37.0 — what the native client may do with the third level, frozen.
 *
 * The release adds MANAGE and managed profiles, and the authority split it
 * ships with is deliberately asymmetric:
 *
 *   * a token EXERCISES a MANAGE grant exactly as a browser does, per request,
 *     through the account selector;
 *   * a token cannot MINT one, and cannot create a managed profile at all,
 *     because both acts are gated on a fresh second factor that resolves
 *     through the session cookie and has no Bearer fall-through.
 *
 * The asymmetry is a consequence of the step-up rather than a policy invented
 * for the native client, and it is the sentence Plan 16's handoff note is
 * derived from — so it is pinned here as a set rather than left implicit in
 * five files that each prove a quarter of it.
 *
 * ## Why this file is a map and not a fifth copy of the assertions
 *
 * Every claim below is proved BEHAVIOURALLY somewhere — against the real
 * resolver, or the real route, or a real Postgres. Re-asserting them here would
 * make five tests that agree with each other and drift together. What has no
 * home is the CLAIM SET: that these four facts are one contract, and that
 * removing any one of them is a change to what a native client may do. This
 * file names each claim, the file that proves it and the test title that does,
 * and fails when a title moves or a file stops carrying it.
 *
 * The pattern is the repo's own — `record-session-fence-acceptance-map.test.ts`
 * does the same for the fence's ten cases, for the same reason.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

interface NativeAuthorityClaim {
  /** What the contract promises. */
  claim: string;
  /** Where it is proved, relative to the repository root. */
  file: string;
  /** A fragment of the test title that proves it. */
  title: string;
  /** How it is proved, so a reader knows what the evidence is worth. */
  kind: "resolver unit" | "route unit" | "postgres integration";
}

const NATIVE_AUTHORITY: NativeAuthorityClaim[] = [
  {
    claim: "A token exercises a MANAGE grant on a shared record.",
    file: "src/lib/__tests__/acting-account-resolver.test.ts",
    title: "admits a MANAGE grant over the Bearer transport too",
    kind: "resolver unit",
  },
  {
    claim: "A token exercises a Guardian's authority over a managed profile.",
    file: "src/lib/__tests__/acting-account-resolver.test.ts",
    title: "admits a Guardian over the Bearer transport, per request",
    kind: "resolver unit",
  },
  {
    claim:
      "A token cannot offer MANAGE, and is told so in a code it can branch on.",
    file: "src/app/api/account/grants/__tests__/invite-scope-and-manage.test.ts",
    title: "refuses a Bearer caller with a code it can act on",
    kind: "route unit",
  },
  {
    claim:
      "The refusal lands before the invitee lookup, so it is no account oracle.",
    file: "src/app/api/account/grants/__tests__/invite-scope-and-manage.test.ts",
    title:
      "refuses the Bearer caller before it discloses whether the account exists",
    kind: "route unit",
  },
  {
    claim: "A token keeps minting the two levels it always could.",
    file: "src/app/api/account/grants/__tests__/invite-scope-and-manage.test.ts",
    title: "lets a Bearer caller keep minting the two levels it always could",
    kind: "route unit",
  },
  {
    claim: "A token cannot create a managed profile, at any permission width.",
    file: "tests/integration/managed-profile-surface.test.ts",
    title: "cannot be reached with a token, however wide its permissions",
    kind: "postgres integration",
  },
  {
    claim:
      "The positive control: a cookie session with a fresh factor creates one.",
    file: "tests/integration/managed-profile-surface.test.ts",
    title: "creates a profile from exactly the body the form composes",
    kind: "postgres integration",
  },
  {
    claim: "A token cannot read the Guardian roster either — cookie-only.",
    file: "tests/integration/managed-profile-surface.test.ts",
    title: "refuses a Bearer caller, because the family is cookie-only",
    kind: "postgres integration",
  },
];

describe("the native client's authority over the third level", () => {
  it("claims a non-empty set, over more than one kind of evidence", () => {
    // A map that named nothing would pass every assertion below it.
    expect(NATIVE_AUTHORITY.length).toBeGreaterThan(5);
    expect(new Set(NATIVE_AUTHORITY.map((entry) => entry.kind)).size).toBe(3);
    expect(new Set(NATIVE_AUTHORITY.map((entry) => entry.file)).size).toBe(3);
  });

  it.each(NATIVE_AUTHORITY)("is proved: $claim", ({ file, title }) => {
    const path = join(ROOT, file);
    expect(existsSync(path), `${file} is missing`).toBe(true);
    const source = readFileSync(path, "utf8");
    // The title as a test title, not as prose in a comment: a claim proved by
    // a docblock is the shape this repo has been burned by.
    expect(source, `${file} no longer carries "${title}"`).toContain(
      `"${title}"`,
    );
  });

  it("keeps the mint refusal and the exercise on opposite sides", () => {
    // The one-sentence version of the contract, asserted on the source of the
    // gate rather than on prose about it: the transport check is what makes
    // the invitation cookie-only, and it sits above the step-up call so that a
    // token is never handed the session gate's "not authenticated".
    const invite = readFileSync(
      join(ROOT, "src/app/api/account/grants/route.ts"),
      "utf8",
    );
    const transportCheck = invite.indexOf('auth.authMethod !== "cookie"');
    const stepUp = invite.indexOf("await requireFreshMfaIfEnrolled(");
    expect(transportCheck).toBeGreaterThan(-1);
    expect(stepUp).toBeGreaterThan(-1);
    expect(transportCheck).toBeLessThan(stepUp);

    // And the managed-profile creation does not even have the softer gate:
    // `requireFreshMfa` refuses an account with no second factor enrolled,
    // where `requireFreshMfaIfEnrolled` would wave it through.
    const create = readFileSync(
      join(ROOT, "src/app/api/managed-profiles/route.ts"),
      "utf8",
    );
    expect(create).toContain("requireFreshMfa(");
    expect(create).not.toContain("requireFreshMfaIfEnrolled");
  });
});
