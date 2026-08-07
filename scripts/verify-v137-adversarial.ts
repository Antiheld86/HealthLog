/**
 * v1.37.0 integration verifier — the inventories, and whether any of them is empty.
 *
 * ## What this is for
 *
 * The release is proved by inventories: a migration allocation, a set of
 * admitted mutating handlers, a notification delivery matrix, a set of security
 * principals, five accessibility states and eight journeys. Every one of them is
 * consumed by a test that iterates it, and every one of those tests passes
 * trivially when the list it iterates is empty. That is the failure this script
 * exists to catch, and it is not hypothetical — three separate checks in this
 * repository have been found green because their matcher matched nothing.
 *
 * So the rule here is that a count is asserted before it is used, and asserted
 * against a number written down rather than against "more than zero" alone.
 * A list that lost half its entries is not caught by a non-empty check.
 *
 * ## What this is NOT
 *
 * It does not run the suites and it cannot tell whether the tests that consume
 * these inventories assert anything worth asserting. It answers one question —
 * "is there something in each of these, and is it the amount there is supposed
 * to be" — and leaves the rest to the tests themselves.
 *
 * ## Usage
 *
 *   pnpm dlx tsx scripts/verify-v137-adversarial.ts                     # everything
 *   pnpm dlx tsx scripts/verify-v137-adversarial.ts --check-inventories # counts only
 *   pnpm dlx tsx scripts/verify-v137-adversarial.ts --check-migrations  # allocation only
 *
 * Exits non-zero on the first failing assertion, and prints every check it ran
 * so a run that checked nothing is visible as a run that printed nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACCESSIBILITY_STATES,
  SHARING_ACCESSIBILITY_STATES,
  V137_E2E_JOURNEYS,
} from "../tests/fixtures/v137/e2e-journeys";
import { NOTIFICATION_DELIVERY_MATRIX } from "../tests/fixtures/v137/notification-matrix";
import { SECURITY_PRINCIPALS } from "../tests/fixtures/v137/security-principals";
import { ADMITTED_MUTATING_HANDLERS } from "../tests/fixtures/v137/sharing-matrix";

const ROOT = process.cwd();

let failures = 0;
let checks = 0;

function check(label: string, ok: boolean, detail: string): void {
  checks += 1;
  if (ok) {
    console.log(`  ok    ${label} — ${detail}`);
    return;
  }
  console.error(`  FAIL  ${label} — ${detail}`);
  failures += 1;
}

function expectCount(label: string, actual: number, expected: number): void {
  check(label, actual === expected, `${actual} (expected ${expected})`);
}

/* -------------------------------------------------------------------------- */
/* Migration allocation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The release's allocation, corrected. The synthesis said 0296-0299 and called
 * the range frozen; the release shipped seven. The list is here so a builder
 * inventing an eighth number, or a merge quietly renumbering one of these,
 * fails rather than being noticed at the release audit or not at all.
 */
const MIGRATION_ALLOCATION = [
  "0296_account_grant_scope_and_manage",
  "0297_managed_profile",
  "0298_notification_delivery_identity",
  "0299_medication_intake_import_actor_attribution",
  "0300_notification_event_created_at_index",
  "0301_notification_egress_authorization",
  "0302_session_record_epoch",
] as const;

/**
 * Triggers this release installs. Neither is modelled in the Prisma schema, so
 * `migrate diff` has nothing to compare them against and cannot report one
 * going missing — the drift check is structurally blind here. Their presence in
 * the migration text is the cheapest honest signal; the behaviour is proved by
 * the integration suites named beside each one.
 */
const MIGRATION_TRIGGERS: ReadonlyArray<{
  trigger: string;
  migration: string;
  provenBy: string;
}> = [
  {
    trigger: "push_attempt_attribution_guard",
    migration: "0298_notification_delivery_identity",
    provenBy: "tests/integration/notification-attribution.test.ts",
  },
  {
    trigger: "sessions_record_epoch_bump",
    migration: "0302_session_record_epoch",
    provenBy: "tests/integration/record-session-epoch-trigger.test.ts",
  },
];

function checkMigrations(): void {
  console.log("migration allocation");
  const dir = join(ROOT, "prisma/migrations");
  const present = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  check(
    "the migrations directory really loaded",
    present.length > 100,
    `${present.length} migrations on disk`,
  );

  const release = present.filter((name) => /^(029[6-9]|030[0-2])_/.test(name));
  expectCount(
    "the release allocates exactly seven",
    release.length,
    MIGRATION_ALLOCATION.length,
  );

  for (const expected of MIGRATION_ALLOCATION) {
    check(
      `allocated ${expected.slice(0, 4)}`,
      present.includes(expected),
      expected,
    );
  }

  // Every number used once. A collision is the thing renumbering exists to
  // prevent, and two directories sharing a prefix apply in an order nobody
  // chose.
  const releaseNumbers = release.map((name) => name.slice(0, 4));
  const duplicated = releaseNumbers.filter(
    (n, i) => releaseNumbers.indexOf(n) !== i,
  );
  check(
    "no number is allocated twice in the release range",
    duplicated.length === 0,
    duplicated.length === 0 ? "none" : duplicated.join(", "),
  );

  for (const { trigger, migration, provenBy } of MIGRATION_TRIGGERS) {
    const sql = readFileSync(join(dir, migration, "migration.sql"), "utf8");
    check(
      `${migration} installs ${trigger}`,
      sql.includes(trigger),
      `behaviour proved by ${provenBy}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Inventories                                                                */
/* -------------------------------------------------------------------------- */

function checkInventories(): void {
  console.log("inventories");

  // Handlers. Every admitted mutation is meant to run level, owner, actor,
  // effect and encrypted-field cases; an empty list runs none of them and the
  // matrix test reports the same green either way.
  check(
    "the admitted mutating handlers are non-empty",
    ADMITTED_MUTATING_HANDLERS.length > 0,
    `${ADMITTED_MUTATING_HANDLERS.length} handlers`,
  );
  // Keyed on route AND action, because one route legitimately appears more
  // than once: an `[id]` route carries an update and a delete, and they are
  // different contracts with different admitted levels. Keying on the route
  // alone reported eleven false collisions on the first run of this script.
  const handlerKeys = new Set(
    ADMITTED_MUTATING_HANDLERS.map((h) => `${h.action} ${h.route}`),
  );
  expectCount(
    "no route and action pair is admitted twice",
    handlerKeys.size,
    ADMITTED_MUTATING_HANDLERS.length,
  );
  check(
    "every handler names a module that exists",
    ADMITTED_MUTATING_HANDLERS.every((h) => {
      try {
        return (
          readFileSync(join(ROOT, "src", h.handlerModule), "utf8").length > 0
        );
      } catch {
        return false;
      }
    }),
    "each handlerModule resolves under src/",
  );

  // The notification matrix is two records by two Guardians by four channels.
  // Written as a product, so a dropped channel shows up here as sixteen minus
  // four rather than as a suite that simply ran fewer cases.
  expectCount(
    "the notification delivery matrix is 2 records x 2 Guardians x 4 channels",
    NOTIFICATION_DELIVERY_MATRIX.length,
    16,
  );
  check(
    "no delivery in the matrix is interactive",
    NOTIFICATION_DELIVERY_MATRIX.every((row) => row.interactive === false),
    "a Guardian's notification offers no action buttons",
  );

  // Security principals. Each names an actor, a record and a recipient; a
  // principal missing one of the three would let a test assert against
  // undefined and pass.
  const principals = Object.entries(SECURITY_PRINCIPALS);
  check(
    "the security principals are non-empty",
    principals.length > 0,
    `${principals.length} principals`,
  );
  for (const [name, principal] of principals) {
    const { actorUserId, recordUserId, recipientUserId } = principal.identities;
    check(
      `${name} names all three identities`,
      Boolean(actorUserId && recordUserId && recipientUserId),
      `${actorUserId} / ${recordUserId} / ${recipientUserId}`,
    );
  }

  // Accessibility states and journeys. Both are enumerations the browser suite
  // is read back against, and both are exact rather than non-empty: a ninth
  // journey nobody counted and a fifth state quietly absorbed into a fourth are
  // the two failures the enumeration exists to make visible.
  expectCount(
    "exactly five accessibility states",
    ACCESSIBILITY_STATES.length,
    5,
  );
  expectCount(
    "every state carries a case",
    SHARING_ACCESSIBILITY_STATES.length,
    5,
  );
  expectCount("exactly eight journeys", V137_E2E_JOURNEYS.length, 8);
  expectCount(
    "every journey id is distinct",
    new Set(V137_E2E_JOURNEYS.map((j) => j.id)).size,
    8,
  );

  // Each journey id must appear in a test title somewhere under e2e/ or tests/
  // or src/__tests__/. `sharing-accessibility-states.test.tsx` pins WHICH file
  // carries each one; this leg is the cheaper cross-check that none of the
  // eight has become a claim with no test anywhere at all.
  const searched = [
    ...readdirSync(join(ROOT, "e2e")).map((f) => join("e2e", f)),
    ...readdirSync(join(ROOT, "tests/integration")).map((f) =>
      join("tests/integration", f),
    ),
    ...readdirSync(join(ROOT, "src/__tests__")).map((f) =>
      join("src/__tests__", f),
    ),
  ].filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  check(
    "the test tree really loaded",
    searched.length > 50,
    `${searched.length} files scanned`,
  );
  const corpus = searched
    .map((f) => readFileSync(join(ROOT, f), "utf8"))
    .join("\n");
  for (const journey of V137_E2E_JOURNEYS) {
    check(
      `${journey.id} is marked in a test title`,
      corpus.includes(`[${journey.id}]`),
      journey.claim.slice(0, 60) + "…",
    );
  }
}

/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const only = argv.filter((a) => a.startsWith("--"));
const runMigrations = only.length === 0 || only.includes("--check-migrations");
const runInventories =
  only.length === 0 || only.includes("--check-inventories");

if (runMigrations) checkMigrations();
if (runInventories) checkInventories();

// A run that asserted nothing is a run that proves nothing, and it would exit 0.
if (checks === 0) {
  console.error("no checks ran — refusing to report success");
  process.exit(1);
}

console.log(
  `\n${checks} check(s), ${failures} failure(s)` +
    (failures === 0 ? " — inventories are non-empty and exact" : ""),
);
process.exit(failures === 0 ? 0 : 1);
