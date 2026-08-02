/**
 * Structural guards on the acting-account boundary.
 *
 * The behavioural tests in `src/lib/__tests__/acting-account-resolver.test.ts`
 * prove what today's code does. These prove what tomorrow's may not do, and
 * they exist because the boundary has one shape that keeps it safe: the acting
 * account is a value ONE function is allowed to act on, and the helpers that
 * decide role and step-up never see it.
 *
 * Tripwires, not proofs. They cannot show the resolver is correct — only that
 * the boundary has not moved without somebody editing this file. Every leg
 * below asserts a non-zero match count first, because a guard whose matcher
 * finds nothing reports success, and this repository has shipped several of
 * those.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join, sep } from "node:path";

const SRC = join(process.cwd(), "src");

function sourceFiles(): string[] {
  return globSync("**/*.{ts,tsx}", { cwd: SRC })
    .filter(
      (p) => !p.startsWith(`generated${sep}`) && !p.startsWith("generated/"),
    )
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .map((p) => p.split(sep).join("/"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

function filesMatching(re: RegExp): string[] {
  return sourceFiles().filter((rel) => re.test(read(rel)));
}

/** The source text of a top-level exported function, braces included. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start === -1) return "";
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return "";
}

describe("the acting-account carrier is read in one place", () => {
  /**
   * Files allowed to touch `Session.actingAsUserId`.
   *
   * The column is a selector — it names an account, it does not authorise one.
   * Anything that reads it and acts on the value without going through the
   * resolver has invented a second answer to "whose record is this", and the
   * copy that drifts is always the one nobody reads.
   *
   * Later items in this feature will extend this list, and that is the point:
   * the switch endpoint (which writes it) and revocation cleanup (which clears
   * it) arrive as a visible diff here rather than as a quiet new reader.
   *
   * The matcher reads source text and does not exempt comments, so a file that
   * merely NAMES the column in prose trips it. Left that way deliberately: a
   * guard over an authorization carrier that shouts at a mention is the right
   * direction to be wrong in.
   */
  const CARRIER_ALLOWLIST = [
    // Projects it off the session row it already loaded.
    "lib/auth/session.ts",
    // The resolver. The only thing that acts on the value.
    "lib/api-handler.ts",
  ].sort();

  it("no other file reads or writes the carrier column", () => {
    const readers = filesMatching(/actingAsUserId|acting_as_user_id/);
    // Non-zero proof: an emptied allowlist must fail rather than agree with an
    // emptied match set.
    expect(readers.length).toBeGreaterThan(0);
    expect(readers).toEqual(CARRIER_ALLOWLIST);
  });

  it("the selector header is named in one place", () => {
    // A route that read the header itself would be deciding an authorisation
    // question the resolver exists to answer once.
    const namers = filesMatching(/x-healthlog-account/i);
    expect(namers.length).toBeGreaterThan(0);
    expect(namers).toEqual(["lib/api-handler.ts"]);
  });
});

describe("the cookie-only helpers cannot see the acting account", () => {
  /**
   * `requireAdmin`, `requireCookieAuth` and `requireFreshMfa` are safe under a
   * switch for one reason: they resolve through `getSession()`, which answers
   * who is CALLING, and they never consult the carrier. That is the property
   * that keeps role checks and step-up gates structurally out of a delegate's
   * reach, and it is one careless line away from being untrue.
   */
  const COOKIE_ONLY = ["requireAdmin", "requireCookieAuth", "requireFreshMfa"];

  it.each(COOKIE_ONLY)("%s resolves the actor and nothing else", (name) => {
    const body = functionBody(read("lib/api-handler.ts"), name);

    // Non-zero proof, twice over: the slice found a function, and the slice is
    // the function it claims to be. A renamed helper must fail here rather
    // than silently assert against an empty string.
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("getSession()");

    expect(body).not.toContain("actingAsUserId");
    expect(body).not.toContain("requireRecordAuth");
    expect(body).not.toContain("readActingCarrier");
  });

  it("substitutes a data-scope user in exactly one function", () => {
    const src = read("lib/api-handler.ts");
    const record = functionBody(src, "requireRecordAuth");
    expect(record).toContain("readActingCarrier");

    // `readActingCarrier` is what turns a request into "acting as somebody
    // else". Two callers: the bare path, which refuses on it, and the record
    // path, which acts on it. A third would be a mode nobody declared.
    const callers = (src.match(/await readActingCarrier\(/g) ?? []).length;
    expect(callers).toBe(2);
  });
});
