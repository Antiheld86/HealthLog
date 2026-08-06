/**
 * The ten acceptance cases of the record-session fence, mapped to the files
 * that prove them — as a runnable artifact rather than a table in a document.
 *
 * A dropped case is the failure this exists to catch. A test deleted during a
 * refactor takes its coverage with it silently; a document claiming ten cases
 * keeps claiming ten. So every case carries a stable id, the id appears in the
 * TITLE of at least one `it(` / `test(` in the file named below, and this file
 * asserts the mapping.
 *
 * ## What this guard cannot do, said plainly
 *
 * It proves an id appears in a test title. It does NOT prove that test asserts
 * anything worth asserting — that is what the named instruments are for, and
 * each case below records which instrument carries its weight. A guard that
 * only counted titles would be satisfiable by ten empty tests, so the
 * per-case `instrument` field is a review anchor, not a claim this file
 * verifies.
 *
 * ## Executed here versus deferred
 *
 * Five cases are proved by Vitest files that run in the ordinary gate. Five
 * ride `e2e/v137-record-session-fence.spec.ts` and therefore run only in the
 * Playwright acceptance stage. That split is recorded in `runner` below and
 * asserted, so nobody can read a green run of THIS file as "all ten proved" —
 * it means "all ten are claimed, and here is which ones have actually
 * executed".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

interface AcceptanceCase {
  id: string;
  /** What the handoff asked for. */
  case: string;
  /** Where it lives, relative to the repository root. */
  home: string;
  /** Vitest runs in the ordinary gate; Playwright runs in the acceptance stage. */
  runner: "vitest" | "playwright";
  /** The thing that makes the assertion falsifiable. A review anchor. */
  instrument: string;
}

const CASES: AcceptanceCase[] = [
  {
    id: "FENCE-AC-01",
    case: "Switch in and out; peers reconcile to the exact new epoch and scope",
    home: "e2e/v137-record-session-fence.spec.ts",
    runner: "playwright",
    instrument:
      "Every record read the peer issues afterwards is inspected for the asserted epoch and scope; the epoch must have moved and the scope must name the record, not merely differ. Paired with a shell-ready assertion so a wedged page cannot pass.",
  },
  {
    id: "FENCE-AC-02",
    case: "Server switch driven externally, initiator response aborted",
    home: "e2e/v137-record-session-fence.spec.ts",
    runner: "playwright",
    instrument:
      "Peers never assert a guessed owner scope under the bootstrap sentinel, AND do reach ready on the target scope once /me resolves. The second half is mandatory: an absence-only assertion passes on a permanently wedged page.",
  },
  {
    id: "FENCE-AC-03",
    case: "Initiator closed after the server commit, before any commit broadcast",
    home: "e2e/v137-record-session-fence.spec.ts",
    runner: "playwright",
    instrument:
      "The surviving tab reaches ready rather than sitting behind a permanent hydration gate — /me is the bootstrap and answers regardless of who began the transition.",
  },
  {
    id: "FENCE-AC-04",
    case: "Raw or external switch; a stale peer read and mutation refused before handler or database work",
    home: "tests/integration/record-session-fence.test.ts",
    runner: "vitest",
    instrument:
      "AccountGrant.lastUsedAt unchanged and no audit_logs row with action = 'sharing.record.accessed' for the pair — both are written only past admission, so their absence is the no-database-work proof. Asserted BEFORE the status code so a removed fence fails on the instrument rather than being masked. Paired with a positive control that moves both. Also the findFirst zero-call spy in src/lib/__tests__/acting-account-resolver.test.ts, plus an e2e leg driving the switch from a request context that runs no client journal.",
  },
  {
    id: "FENCE-AC-05",
    case: "Owner idempotent mutation and replay, switch before handler authorization",
    home: "tests/integration/record-session-fence-idempotency.test.ts",
    runner: "vitest",
    instrument:
      "The seeded owner cell is byte-unchanged — same id, responseStatus, responseBody, expiresAt, createdAt. expiresAt carries the weight: completion rewrites it to now+24h and a fresh claim to now+2min, so any wrapper that reached the cache moves it. The 'no row exists' assertion was rejected as unfalsifiable, because releaseClaim deletes the pending row whenever the handler throws.",
  },
  {
    id: "FENCE-AC-06",
    case: "Record response delayed across the switch; the client discards and holds",
    home: "src/lib/api/__tests__/record-fence-client.test.ts",
    runner: "vitest",
    instrument:
      "A response whose echoed epoch is one behind the adopted one makes the caller throw and fires the hold exactly once, while a response carrying NO echo is returned untouched and fires nothing. The second half is the version-poller case and is what stops the rule from being discard-on-absence. An e2e leg holds a real record read open across a real switch.",
  },
  {
    id: "FENCE-AC-07",
    case: "IndexedDB and CacheStorage seeded with an owner snapshot, switch in, go offline",
    home: "e2e/v137-record-session-fence.spec.ts",
    runner: "playwright",
    instrument:
      "Positive control first — the owner snapshot really was in CacheStorage before the switch, asserted by a non-zero entry count. Then the eviction claim of the cache-version policy, then a zero entry count after the switch, then offline with the target's own data reachable.",
  },
  {
    id: "FENCE-AC-08",
    case: "Concurrent switchers; monotonic compare-and-set ordering, a stale switch cannot override",
    home: "tests/integration/record-session-fence.test.ts",
    runner: "vitest",
    instrument:
      "Two same-epoch switches to genuinely distinct targets resolve to exactly one 'applied' and one 'stale', and the epoch handed back to the winner equals the row's committed value. A separate leg pins the no-op case, where the trigger declines to move and 'applied' is the honest answer.",
  },
  {
    id: "FENCE-AC-09",
    case: "Revoke, account deletion, managed-profile lifecycle, FK-driven clearing",
    home: "tests/integration/record-session-epoch-trigger.test.ts",
    runner: "vitest",
    instrument:
      "The ON DELETE SET NULL referential action and a raw SQL clear both bump the epoch with no application code running, while the per-request last_active_at and expires_at writes do not. A lifecycle leg in tests/integration/record-session-fence.test.ts then asserts the fence refuses the pre-transition context after a revoke and after an owner deletion.",
  },
  {
    id: "FENCE-AC-10",
    case: "Pre-fence cookie callers fail closed into their reload; token and native keep the frozen contract",
    home: "src/__tests__/record-session-fence-compat.test.ts",
    runner: "vitest",
    instrument:
      "Every link in the pre-fence tab's only recovery chain is frozen, and the 409 is asserted ABSENT from the grant-loss predicate. The fence's own positive controls live in tests/integration/record-session-fence.test.ts: a Bearer request with no fence header is served, and an epoch-zero cookie request with no fence header is served. Without those two a fence that refused everything would pass every negative test in this plan.",
  },
];

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Every `it(` / `test(` title in a file. */
function testTitles(source: string): string[] {
  const titles: string[] = [];
  for (const m of source.matchAll(
    /\b(?:it|test)(?:\.\w+)*\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g,
  )) {
    titles.push(m[2]);
  }
  return titles;
}

describe("the ten acceptance cases are all claimed by a runnable test", () => {
  it("declares exactly ten distinct ids", () => {
    expect(CASES).toHaveLength(10);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(10);
    for (const c of CASES) {
      expect(c.id).toMatch(/^FENCE-AC-\d{2}$/);
      // A review anchor with nothing in it is not one.
      expect(c.instrument.length).toBeGreaterThan(80);
      expect(c.case.length).toBeGreaterThan(20);
    }
  });

  it.each(CASES)("$id appears in a test title in $home", (c) => {
    const titles = testTitles(read(c.home));
    // Non-zero proof: a matcher that found no titles at all would make the
    // membership check below vacuous.
    expect(titles.length).toBeGreaterThan(0);
    const carrying = titles.filter((t) => t.includes(c.id));
    expect(carrying.length).toBeGreaterThan(0);
  });

  it("records which cases have actually executed in this gate", () => {
    // Five cases ride Playwright and therefore prove nothing until the
    // acceptance stage runs. Stating the split here is what stops a green run
    // of this file from being read as "all ten proved".
    const vitest = CASES.filter((c) => c.runner === "vitest").map((c) => c.id);
    const playwright = CASES.filter((c) => c.runner === "playwright").map(
      (c) => c.id,
    );

    expect(vitest).toEqual([
      "FENCE-AC-04",
      "FENCE-AC-05",
      "FENCE-AC-06",
      "FENCE-AC-08",
      "FENCE-AC-09",
      "FENCE-AC-10",
    ]);
    expect(playwright).toEqual([
      "FENCE-AC-01",
      "FENCE-AC-02",
      "FENCE-AC-03",
      "FENCE-AC-07",
    ]);
    expect(vitest.length + playwright.length).toBe(10);
  });

  it("names only files that exist and carry real tests", () => {
    for (const home of new Set(CASES.map((c) => c.home))) {
      const source = read(home);
      expect(source.length).toBeGreaterThan(500);
      expect(testTitles(source).length).toBeGreaterThan(0);
    }
  });
});
