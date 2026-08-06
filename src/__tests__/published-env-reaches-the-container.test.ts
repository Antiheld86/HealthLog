import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * An environment variable the product SHOWS a user has to reach the container.
 *
 * ## The failure this exists for
 *
 * `docker-compose.yml`'s `environment:` block is a whitelist. Docker Compose
 * reads `.env` for `${VAR}` substitution, so a value an operator sets there
 * appears to be configured, and a variable not named in the block never
 * arrives in the process. v1.5.2 shipped that exact defect for
 * `SESSION_COOKIE_SECURE`: documented, settable, and silently absent, which on
 * a plain-HTTP self-host reads as "login is broken".
 *
 * `AUDIT_LOG_RETENTION_DAYS` is a sharper version of the same class, because
 * the number is not merely enforced — it is PUBLISHED. `GET
 * /api/account/grants` and `GET /api/account/activity` both send it, the
 * activity list prints it, and the dialog that ends somebody's access states
 * how long "who entered what" stays answerable. An operator who sets 90 and
 * does not get it told every user 365, in a sentence about their own data.
 *
 * ## What this checks, and what it cannot
 *
 * The three places an operator meets a variable: the compose whitelist, the
 * self-host example, and the production example. It cannot check that the
 * value is honoured — `getAuditLogRetentionDays()` has its own tests — only
 * that a value set the documented way is not dropped on the floor between
 * `.env` and the process.
 *
 * The list is deliberately short. It is not every variable in the manifest:
 * `scripts/check-env.ts` owns that question and CI runs it against
 * `.env.production.example`. This is the narrower one that check-env cannot
 * answer, because it reads a file rather than the compose whitelist.
 */
const ROOT = process.cwd();
const COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const ENV_EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf8");
const PROD_EXAMPLE = readFileSync(
  join(ROOT, ".env.production.example"),
  "utf8",
);

/**
 * Variables whose value the product states back to a user.
 *
 * A variable earns a place here by being readable somewhere in the interface,
 * not by being important. That is the property that makes a missing whitelist
 * entry a lie rather than an inconvenience.
 */
const PUBLISHED_TO_USERS = [
  {
    name: "AUDIT_LOG_RETENTION_DAYS",
    shownBy: "the shared-access activity window and the revoke dialog",
  },
  {
    name: "SESSION_COOKIE_SECURE",
    shownBy:
      "nothing directly — the original of this defect class, kept as a control",
  },
] as const;

describe("a variable the product publishes reaches the container", () => {
  it("has a matcher that can fail", () => {
    // The pins. Every leg below asserts a substring is PRESENT, and a file
    // that failed to load would be an empty string in which nothing is
    // present — so the failure would be loud rather than silent. These make
    // the fixtures' own size the evidence.
    expect(PUBLISHED_TO_USERS.length).toBeGreaterThan(1);
    expect(COMPOSE).toContain("environment:");
    expect(ENV_EXAMPLE.length).toBeGreaterThan(1000);
    expect(PROD_EXAMPLE.length).toBeGreaterThan(1000);
    // And a name nothing declares is genuinely absent from all three, so the
    // matchers below are not passing on a substring that is everywhere.
    for (const file of [COMPOSE, ENV_EXAMPLE, PROD_EXAMPLE]) {
      expect(file).not.toContain("HEALTHLOG_NOT_A_REAL_VARIABLE");
    }
  });

  for (const { name, shownBy } of PUBLISHED_TO_USERS) {
    describe(name, () => {
      it(`is on the compose whitelist, so a value in .env arrives (${shownBy})`, () => {
        // The substitution form, not merely the name: a bare mention in a
        // comment is how this class of defect hides.
        expect(COMPOSE).toMatch(
          new RegExp(`^\\s*${name}:\\s*"\\$\\{${name}`, "m"),
        );
      });

      it("is documented in the self-host example", () => {
        expect(ENV_EXAMPLE).toContain(name);
      });

      it("is documented in the production example", () => {
        expect(PROD_EXAMPLE).toContain(name);
      });
    });
  }
});
