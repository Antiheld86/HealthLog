/**
 * Structural guards on the delegable and actor-surface allowlists.
 *
 * `requireRecordAuth` is a declaration: this route may act on somebody else's
 * health record. `requireActorAuth` is the opposite declaration: this route
 * serves the caller's own account and keeps working while the caller is acting
 * as someone else. Which routes may say either thing is the single most
 * security-sensitive list in the product, and it is a judgement — argued in
 * `.planning/2026-08-01-delegable-classification.md`, not derived from anything
 * a machine can check.
 *
 * That record is an argument on paper. This file is what makes it hold: the set
 * of route modules that actually reach each resolver has to equal a literal
 * written here, so every admission arrives as a diff a human reviewed rather
 * than as an import somebody added on a Friday.
 *
 * These are tripwires, not proofs. They cannot show a list is correct — only
 * that it has not changed without someone editing this file. A reviewer who
 * waves through a bad addition defeats every leg below, and no test substitutes
 * for that review.
 *
 * Two properties this file is built around, both learned the hard way:
 *
 *   1. **Every leg asserts its own matcher found something.** A matcher that
 *      matches nothing reports success, and this repository has shipped several
 *      of those — a resolver hidden behind a newline, a regex a variable slipped
 *      past, an absence asserted in a fixture that never held the thing. Legs
 *      (c) and (d) still expect an EMPTY offender set, so for them "found
 *      nothing" and "the list is correct" look identical from the outside.
 *      Each leg therefore pins a separate, non-empty count: the number of
 *      route modules SCANNED, or the number of files naming a symbol the leg
 *      depends on. Those counts are the evidence; the empty result is only the
 *      verdict. The delegable list itself was empty when this file was written
 *      and is not any more, which removes the trap from legs (a) and (b) but
 *      not from the two below them.
 *
 *   2. **AST decides, text only skips.** Membership is decided by parsing the
 *      module and reading its identifiers, so a comment explaining why a route
 *      is NOT delegable cannot enrol it, and an aliased import cannot hide one.
 *      A raw-substring test runs first, but only to skip files that cannot
 *      possibly match — the source text is a strict superset of the identifier
 *      set. `describe("the matchers see what they look for")` proves both
 *      halves of that sentence against synthetic modules, so the day a matcher
 *      stops matching is the day this file goes red rather than quiet.
 *
 * `acting-account-boundary-guard.test.ts` is the other half of this boundary
 * and stays as it is. It freezes who may touch the CARRIER — the session column
 * and the selector header — with a text matcher that deliberately does not
 * exempt comments, so a file merely naming the column in prose trips it. That
 * is argued at its own call site and it is the right direction to be wrong in
 * for an authorisation carrier. This file asks a different question of a
 * different set of symbols and answers it from the AST, because a route
 * explaining in a comment why it is NOT delegable is a thing worth writing.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** The delegable declaration. Frozen by `DELEGABLE_ROUTES`. */
const RECORD_RESOLVER = "requireRecordAuth";
/** The actor-surface declaration. Frozen by `ACTOR_ROUTES`. */
const ACTOR_RESOLVER = "requireActorAuth";

/**
 * The helpers that answer a question a delegate must never be able to reach:
 * "is this caller an admin", "has this caller just re-proven a second factor",
 * "is this caller here over a cookie". All three resolve through `getSession()`
 * and see the actor, never the owner — that is what
 * `acting-account-boundary-guard.test.ts` pins inside `api-handler.ts`.
 *
 * This file pins the other end. A handler that resolves a RECORD and then runs
 * one of these has put a role check and a substituted data scope in the same
 * module, and the next person to edit it has no way to tell which `user` they
 * are holding. `requireFreshMfaIfEnrolled` and `requireMfaManagementAuth` are
 * not listed separately: both are thin wrappers that call `requireFreshMfa` or
 * `requireCookieAuth`, so a module using either names one of these three too.
 */
const COOKIE_ONLY_HELPERS = [
  "requireAdmin",
  "requireFreshMfa",
  "requireCookieAuth",
] as const;

/**
 * Floors, not counts. The tree today holds 447 route modules (440 of them under
 * `app/api/`) and 2,338 source files, of which 346 route modules resolve auth
 * the ordinary way. These numbers exist so that a scan which collapses to a
 * handful of files — a changed enumeration, a moved `src`, a `cwd` that is not
 * the repo root — fails instead of agreeing with an empty allowlist. They sit
 * far below today's figures so ordinary churn never touches them.
 */
const ROUTE_MODULE_FLOOR = 300;
const SOURCE_FILE_FLOOR = 1500;
const BARE_REQUIRE_AUTH_FLOOR = 250;

/* -------------------------------------------------------------------------- */
/* The file set                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every path under `src/`, as a `/`-joined relative string.
 *
 * A recursive `readdirSync` rather than a glob, and the difference is not
 * stylistic. `fs.globSync` skips dot-prefixed directories, so `app/**` silently
 * omits the three routes under `src/app/.well-known/` — three request handlers
 * that a glob-based sweep reports as if they did not exist. Leg (a) pins one of
 * them by name so this cannot quietly regress. Names only; nothing under
 * `generated/` is ever read (CLAUDE.md).
 */
function allPaths(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p).split(sep).join("/"))
    .sort();
}

function nonTest(paths: string[]): string[] {
  return paths
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"));
}

/**
 * Every request-handling module in the tree. `app/**` rather than `app/api/**`
 * on purpose: `app/mcp/route.ts` and the clinician share routes handle requests
 * too, and a resolver reached from one of those is exactly as interesting as
 * one reached from under `api/`.
 */
function routeModules(): string[] {
  return nonTest(
    allPaths().filter((p) => p.startsWith("app/") && p.endsWith("/route.ts")),
  );
}

/** Every non-test source file under `src/`, generated client excluded. */
function sourceFiles(): string[] {
  return nonTest(
    allPaths().filter((p) => p.endsWith(".ts") || p.endsWith(".tsx")),
  );
}

const textCache = new Map<string, string>();

function read(rel: string): string {
  const cached = textCache.get(rel);
  if (cached !== undefined) return cached;
  const text = readFileSync(join(SRC, rel), "utf8");
  textCache.set(rel, text);
  return text;
}

/* -------------------------------------------------------------------------- */
/* The matcher                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every identifier in a module's parsed source.
 *
 * Identifiers only, which means: imports (including the original name of an
 * aliased one), calls, declarations, type references. Not comments, not string
 * literals. A route file may say in prose why it is not delegable without being
 * enrolled by saying so — the failure mode of a text matcher, and the reason
 * the plan asked for AST here.
 */
function identifiersIn(source: string, fileName: string): Set<string> {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) found.add(node.text);
    node.forEachChild(walk);
  };
  parsed.forEachChild(walk);
  return found;
}

const identifierCache = new Map<string, Set<string>>();

function identifiers(rel: string): Set<string> {
  const cached = identifierCache.get(rel);
  if (cached !== undefined) return cached;
  const found = identifiersIn(read(rel), rel);
  identifierCache.set(rel, found);
  return found;
}

/**
 * Does this module name `symbol` in code?
 *
 * The substring test runs first and decides nothing: it only skips files whose
 * raw text cannot contain the identifier, because the text is a strict superset
 * of the identifier set. Every candidate that survives it is decided by the
 * AST. Both halves are proved below against synthetic modules.
 */
function namesSymbol(rel: string, symbol: string): boolean {
  if (!read(rel).includes(symbol)) return false;
  return identifiers(rel).has(symbol);
}

function modulesNaming(files: readonly string[], symbol: string): string[] {
  return files.filter((rel) => namesSymbol(rel, symbol));
}

/* -------------------------------------------------------------------------- */
/* The call matcher: which symbol is called, and with what                    */
/* -------------------------------------------------------------------------- */

/**
 * One call site, with its callee resolved back to the ORIGINAL exported name
 * and its first argument, when that argument is a plain string literal.
 *
 * The membership matcher above answers "does this module name the symbol",
 * which is the right question for an allowlist and the wrong one for the write
 * leg: `requireRecordAuth("read")` and `requireRecordAuth("write")` name the
 * same identifier and mean opposite things. So this walks call expressions and
 * resolves the callee through the module's own import table — an aliased
 * import (`requireRecordAuth as resolveRecord`) and a namespace-qualified call
 * (`auth.requireRecordAuth`) both come back as `requireRecordAuth`, which is
 * the property that makes "the write set equals this literal" hold against a
 * module that renames its import.
 */
interface CallSite {
  /** The original exported name, after alias resolution. */
  name: string;
  /** The first argument when it is a string literal; null otherwise. */
  firstArg: string | null;
}

function callSitesIn(source: string, fileName: string): CallSite[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // local name -> original exported name, and the set of namespace imports.
  const aliases = new Map<string, string>();
  const namespaces = new Set<string>();
  parsed.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) return;
    const bindings = node.importClause?.namedBindings;
    if (!bindings) return;
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      return;
    }
    for (const spec of bindings.elements) {
      aliases.set(spec.name.text, (spec.propertyName ?? spec.name).text);
    }
  });

  const calls: CallSite[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      let name: string | null = null;
      if (ts.isIdentifier(callee)) {
        name = aliases.get(callee.text) ?? callee.text;
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        namespaces.has(callee.expression.text)
      ) {
        name = callee.name.text;
      }
      if (name !== null) {
        const first = node.arguments[0];
        calls.push({
          name,
          firstArg: first && ts.isStringLiteralLike(first) ? first.text : null,
        });
      }
    }
    node.forEachChild(walk);
  };
  parsed.forEachChild(walk);
  return calls;
}

const callCache = new Map<string, CallSite[]>();

function callSites(rel: string): CallSite[] {
  const cached = callCache.get(rel);
  if (cached !== undefined) return cached;
  const found = callSitesIn(read(rel), rel);
  callCache.set(rel, found);
  return found;
}

/**
 * Every call in this module that reaches the audit table through the Prisma
 * client instead of through `auditLog()`.
 *
 * Matched structurally: a call whose callee is `<something>.auditLog.<verb>`,
 * read off the property-access chain rather than off the file's text, so a
 * comment or a string discussing the old shape cannot produce a finding and a
 * call broken across lines cannot hide one. The delegated actor column is
 * stamped in exactly one place, so any client-level write against this table
 * is a row filed with no actor.
 */
const AUDIT_WRITE_VERBS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "upsert",
  "update",
  "updateMany",
]);

function directAuditWritesIn(source: string, fileName: string): string[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        AUDIT_WRITE_VERBS.has(callee.name.text) &&
        ts.isPropertyAccessExpression(callee.expression) &&
        callee.expression.name.text === "auditLog"
      ) {
        found.push(
          `${callee.expression.expression.getText()}.auditLog.${callee.name.text}`,
        );
      }
    }
    node.forEachChild(walk);
  };
  parsed.forEachChild(walk);
  return found;
}

/** Does this module call `symbol` anywhere, under any import name? */
function callsSymbol(rel: string, symbol: string): boolean {
  if (!read(rel).includes(symbol)) return false;
  return callSites(rel).some((c) => c.name === symbol);
}

/** The `GrantNeed` literals this module passes to the record resolver. */
function recordNeeds(rel: string): Set<string> {
  if (!read(rel).includes(RECORD_RESOLVER)) return new Set();
  return new Set(
    callSites(rel)
      .filter((c) => c.name === RECORD_RESOLVER && c.firstArg !== null)
      .map((c) => c.firstArg as string),
  );
}

/** Names of the top-level functions a module exports. */
function exportedFunctionNames(rel: string): string[] {
  const parsed = ts.createSourceFile(
    rel,
    read(rel),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names: string[] = [];
  parsed.forEachChild((node) => {
    if (!ts.isFunctionDeclaration(node) || !node.name) return;
    const exported = node.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported) names.push(node.name.text);
  });
  return names;
}

/* -------------------------------------------------------------------------- */
/* The frozen lists                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Route modules permitted to act on a record that may not be the caller's.
 *
 * Every member carries a line in the classification record that says why it
 * may. A route absent from that record cannot enter this list.
 *
 * The value is the reason, in one line, in the maintainer's words. Not the
 * route's description — the argument for why a delegate reading or writing
 * through it cannot extend their own reach.
 *
 * Note what a member means: the MODULE reaches the resolver. Until v1.36.x
 * that was the GET arm alone in every case; eleven of these files now also
 * reach it from a POST arm, and those eleven are frozen a second time in
 * {@link DELEGABLE_WRITE_ROUTES} with their own leg below. Membership here is
 * therefore necessary and not sufficient for a delegable write: a file can sit
 * in this list and still refuse every mutation, which is what the other
 * thirty-one do. Any write arm not named in the write literal is a diff two
 * lists have to agree on.
 */
const DELEGABLE_ROUTES: Record<string, string> = {
  "app/api/measurements/route.ts":
    "The record's readings. The GET returns values, units, timestamps and notes scoped `userId: user.id`; the POST arms are delegable writes (see the write literal) and the PUT / DELETE beside them are not.",
  "app/api/measurements/[id]/route.ts":
    "One reading of the record, fetched by id and guarded against the resolved user before it is serialised. The PUT and DELETE beside it keep `requireAuth()`.",
  "app/api/measurements/series/route.ts":
    "A chart series over the record's own readings. Every `where` and every raw-SQL predicate binds the resolved user id; the route holds no write arm at all.",
  "app/api/measurements/series-batch/route.ts":
    "The multi-type form of the same series read, delegating to `readSeriesBatch(user.id, …)`. Nothing but the resolved id reaches the query.",
  "app/api/measurement-reminders/route.ts":
    "The record's own reminder schedule — what the owner asked to be reminded of, not a notification channel or a device. The GET reads `userId: user.id`; creating a reminder stays on `requireAuth()`.",
  "app/api/measurement-reminders/[id]/route.ts":
    "One reminder of the record, fetched by id then guarded against the resolved user. The PUT and DELETE keep `requireAuth()`.",
  "app/api/labs/route.ts":
    "The record's lab results. The only nested include is the biomarker's own reference range — no third party, no credential. Creating a result is a delegable write; editing and deleting one are not.",
  "app/api/labs/[id]/route.ts":
    "One lab result of the record, fetched by id then guarded against the resolved user before anything is serialised.",
  "app/api/biomarkers/route.ts":
    "The record's biomarker catalogue: the analytes this account tracks and the ranges it tracks them against. Adding a marker is a delegable write; the PUT and DELETE on the sibling route are refused.",
  "app/api/biomarkers/[id]/route.ts":
    "One biomarker of the record, fetch-then-guard against the resolved user.",
  "app/api/allergies/route.ts":
    "The record's allergy list — the single most useful thing a caregiver can read, and a plain list of the owner's own rows. The POST beside it is NOT delegable and is deliberately absent from the write literal below: the only surface that posts to it lives under `/settings`, which a switch closes, so admitting the write would freeze a permission ahead of any caller for it. The route comment carries the argument.",
  "app/api/allergies/[id]/route.ts":
    "One allergy of the record, fetch-then-guard against the resolved user.",
  "app/api/family-history/route.ts":
    "The record's family history. The payload describes the owner's relatives, so it is the one admitted read where third-party health information is present by design rather than by accident; a caregiver reading it is the use the feature exists for, and the row is stored as the owner's. Its POST is not delegable, for the reason its allergy sibling gives plus one of its own — see the route comment.",
  "app/api/family-history/[id]/route.ts":
    "One family-history entry of the record, fetch-then-guard against the resolved user.",
  "app/api/mental-health/assessments/route.ts":
    "The record's screener history. The module gate resolves against the record, so a delegate sees the surface only where the owner switched it on; the rate limit on the POST arm is untouched and that arm still refuses under a switch.",
  "app/api/anamnesis/facts/route.ts":
    "The record's health-profile facts, read through `readHealthProfileFacts(user.id)`. The module holds write helpers, and the GET calls none of them.",
  "app/api/mood-entries/route.ts":
    "The record's mood entries. The nested include is the tag vocabulary — a key and a kind, no identifiers. Note that `GET /api/mood/tags` is refused and stays refused: it pulls the owner's tag LAYOUT, which is a presentation preference and belongs to the person, not the record.",
  "app/api/mood-entries/[id]/route.ts":
    "One mood entry of the record, fetch-then-guard against the resolved user.",
  "app/api/custom-metrics/route.ts":
    "The record's own metric definitions and their latest values. Every `where` carries the resolved user id.",
  "app/api/custom-metrics/[id]/route.ts":
    "One custom metric of the record, scoped by the resolved user id in the query itself.",
  "app/api/custom-metrics/[id]/entries/route.ts":
    "The entries of one custom metric, reached only after the metric itself resolves under the record's user id — the ownership hop runs before the entry query, on the read arm and on the delegable create arm alike.",
  "app/api/personal-records/route.ts":
    "The record's personal bests, `where: { userId: user.id }`. Nothing else in the file.",
  "app/api/sleep/night/route.ts":
    "The record's hypnogram. Read-only, module-gated on the record, no write of any kind on the path.",
  "app/api/sleep/rhythm/route.ts":
    "The record's sleep rhythm, built from `buildSleepRhythm(user.id)` and gated on the record's sleep module.",
  "app/api/nutrients/route.ts":
    "The record's nutrient overview. It reads the last ingest audit row to date the data — integration-adjacent metadata, and no credential, endpoint or token crosses the wire.",
  "app/api/nutrients/daily/route.ts":
    "One nutrient's daily series over the record, scoped by the resolved user id.",
  "app/api/illness/episodes/route.ts":
    "The record's illness episodes. Module-gated on the record on both arms, so a delegate gets the surface only where the owner switched it on; the create arm is a delegable write.",
  "app/api/illness/episodes/[id]/route.ts":
    "One episode of the record, fetch-then-guard against the resolved user.",
  "app/api/illness/episodes/[id]/day-logs/route.ts":
    "The day logs of one episode. The episode-scoped queries are safe because `loadOwnedEpisode(id, user.id)` runs first and now resolves against the record; the upsert arm keeps `requireAuth()`.",
  "app/api/workouts/route.ts":
    "The record's workout list. Verified to carry no AI-written paragraph: the single-workout route beside it does, and stays refused for exactly that reason.",
  "app/api/cycle/cycles/route.ts":
    "The record's cycle history. Whether cycle tracking applies is a property of the record, and the gate gets there by re-loading the profile and gender for the resolved user id — note that the `gender` argument at the call site is dead (`requireCycleEnabled` names it `_gender`), so it is the id that carries the substitution, not that argument.",
  "app/api/cycle/day-logs/route.ts":
    'One day of the record\'s cycle log. The `auditLog("cycle.day-log.upsert")` in this file belongs to the PUT, which keeps `requireAuth()`.',
  "app/api/cycle/profile/route.ts":
    "The record's cycle profile, supplied by the gate itself. This is the one cycle route that does read the auth-context gender directly — `isCycleEnabled(user.gender, gate.profile)` computes the `resolved` flag it returns — and post-substitution that is the owner's.",
  "app/api/cycle/symptoms/custom/route.ts":
    "The record's own custom symptom vocabulary. The create arm carries the rate limit and keeps `requireAuth()`.",
  "app/api/medications/route.ts":
    "The record's medication cabinet. The cached list projection keys on the same resolved id it scopes to, so the owner's cell holds the owner's data. Returns no ingest endpoint and no token count — the route that does is refused.",
  "app/api/medications/[id]/route.ts":
    "One medication of the record, fetch-then-guard against the resolved user before anything is serialised.",
  "app/api/medications/[id]/cadence/route.ts":
    "One medication's cadence, behind `assertMedicationOwnership(id, user.id)` — the shared guard, resolved against the record.",
  "app/api/medications/[id]/schedule-revisions/route.ts":
    "One medication's archived schedule eras, behind the same ownership guard. The create arm keeps `requireAuth()` and its compliance backfill with it.",
  "app/api/medications/[id]/side-effects/route.ts":
    "One medication's recorded side effects, behind the same ownership guard. The rate limit in this file belongs to the create arm, which is a delegable write and keys its bucket on the ACTOR for exactly that reason.",
  "app/api/medications/[id]/inventory/route.ts":
    "One medication's inventory, behind the same ownership guard. The rate limit in this file belongs to the create arm.",
  "app/api/medications/[id]/phase-config/route.ts":
    "One medication's reminder phase config, behind the same ownership guard. The upsert arm keeps `requireAuth()`.",
  "app/api/medications/[id]/intake/route.ts":
    "One medication's intake history, behind the same ownership guard. Marking a dose is a delegable write, and the one that notifies the owner rather than only filing an audit row.",
  "app/api/medications/intake/route.ts":
    "The account-wide intake list, scoped through the resolved user. Its cache cell keys on the same id it scopes to, and the canonical slot write on the POST arm is delegable.",
  "app/api/medications/compliance/route.ts":
    "Batched compliance across the record's cabinet. The one delegable read that spends a quota, so its rate-limit bucket keys on the ACTOR: a delegate must burn their own allowance rather than lock the owner out, and must not collect a fresh one by switching records.",
};

/**
 * Route modules permitted to WRITE into a record that may not be the caller's.
 *
 * A strict subset of {@link DELEGABLE_ROUTES}, and the shorter list on purpose:
 * a delegate adds to a record and never rewrites it. No delete, no edit, no
 * restore, no import, no sync ingest sits here, and `PUT /api/medications/[id]`
 * is deliberately absent — adding a medication is in, correcting one is not,
 * including the one the delegate created ten seconds ago with a typo in the
 * dose. Every member is a create.
 *
 * Membership is decided by the ARGUMENT, not by the identifier: a module joins
 * this list when it passes `"write"` to `requireRecordAuth`. That is what the
 * thirty-one read-only delegable modules do not do, and it is the difference
 * the identifier matcher above cannot see.
 *
 * v1.36.x — `POST /api/allergies` and `POST /api/family-history` left this
 * list, and the removal is worth reading before either is proposed again. The
 * argument for admitting them was never wrong; what they lacked was a caller.
 * The only surface in the product that posts to either lives in Settings →
 * Anamnese, and a switch closes `/settings` — so a delegate could not reach
 * the form at any grant level, and the two entries were a permission frozen
 * ahead of the surface that would exercise it. Both delegable READ arms stay:
 * a caregiver reading the allergy list is what the feature is for. Whoever
 * builds a caregiver-reachable medical-history surface adds them back in the
 * same diff, which is the two-ended change this list is meant to hold to.
 *
 * Every member also has to call `auditLog`, asserted below. That is not a
 * stylistic preference. The decision not to add a `writtenBy` column to eleven
 * tables rests entirely on the audit trail carrying the actor, and `auditLog`
 * is the only writer that stamps `actorUserId` — a member that filed its rows
 * through a bare `prisma.auditLog.create`, or filed none at all, would make a
 * delegate's contribution indistinguishable from the owner's own. Asserting it
 * here is what turns that decision from a thing nobody has forgotten yet into
 * a property of the list.
 */
const DELEGABLE_WRITE_ROUTES: Record<string, string> = {
  "app/api/measurements/route.ts":
    "Entering a reading. Both POST arms — single and batch — land rows under the resolved record; the safety-floor check, the reminder satisfaction and the rollup recompute all address the same record and are correct under substitution.",
  "app/api/labs/route.ts":
    "Entering a lab result. The free-text path may mint a biomarker, and mints it into the RECORD's catalogue — a result added to somebody's record that left the marker on the helper's account would be worse than useless to the owner.",
  "app/api/biomarkers/route.ts":
    "Adding an analyte to the record's catalogue. A name the record already tracks is the ordinary 409 from the same `(userId, name)` uniqueness the owner would hit themselves.",
  "app/api/illness/episodes/route.ts":
    "Opening an illness episode. The module gate runs against the RECORD before the write, so a delegate cannot create an episode inside a record whose owner switched the module off.",
  "app/api/custom-metrics/[id]/entries/route.ts":
    "Adding a value to one of the record's own metrics. The metric resolves under the record first, so a delegate can only feed a definition the owner made.",
  "app/api/medications/[id]/side-effects/route.ts":
    "Recording a side effect. Admitted on one condition, met at the call site: the POST rate bucket keys on the ACTOR, so a delegate burns their own allowance rather than the owner's and cannot collect a fresh one by switching records.",
  "app/api/medications/route.ts":
    "Adding a medication with its nested schedule. The schedule is the point — a medication nobody scheduled reminds nobody of anything. The edit and delete verbs on the sibling route stay refused.",
  "app/api/medications/intake/route.ts":
    "Marking a dose, canonical slot form. The cross-device sync, the web-push dose-clear and the badge recount stay addressed to the OWNER, which is correct: it is their dose and their devices. The owner also gets told who marked it.",
  "app/api/medications/[id]/intake/route.ts":
    "Marking a dose, per-medication form. Same family, same ownership guard against the record, same notification to the owner; this arm has no snooze, so the state is always one of the two markings.",
};

/**
 * Route modules that deliberately resolve the ACTOR and keep working under a
 * switch, because they serve the caller's own account and nothing of the
 * owner's.
 *
 * The intended members are the surfaces a switched session needs in order to
 * stay usable and to get back out: the account bootstrap payload, the switch
 * endpoint, logout, the native refresh route, the locale read. Two of them
 * exist so far. The rest arrive as their own diffs here; naming them before
 * they exist would freeze a guess.
 */
const ACTOR_ROUTES: Record<string, string> = {
  "app/api/account/switch/route.ts":
    "The way back out. Every other route refuses under a switch, so if this one did too a browser could enter a record and never leave it. It reads and writes exactly one row — the caller's own session — renders nothing of the owner's, and grants nothing: the account it stamps is validated against a live grant first, and the stamp is re-checked on every request after.",
  "app/api/auth/me/route.ts":
    "The app shell reads it on every boot, including while a switch is on: the switcher, the banner naming whose record is open, and the route back out all bind this payload. Every field it returns is the caller's own — their preferences, their modules, their identity — and the one field about the switch says only which records they may open and which they are inside. It reads no row of the owner's, and its `accountAccess` block grants nothing: the resolver re-checks the grant on every delegated request regardless of what this payload said a moment ago.",
};

/**
 * Entries across all three lists. Pinned so that the reason-loop below cannot
 * stay a formality by accident: every addition has to be counted here as well
 * as listed above, which is one more place a careless admission has to pass.
 */
const FROZEN_ENTRY_COUNT = 55;

/**
 * The two surfaces that authenticate a Bearer token outside `requireAuth` —
 * frozen as a set by `bearer-scope-enforcement-guard.test.ts`, repeated here
 * for the one property that guard does not cover: neither may reach either new
 * resolver. Both hand-roll their own token resolution, so neither would inherit
 * the refusal arms that make the switch fail closed.
 *
 * The value is the identifier that proves the file is still that surface. If a
 * file stops resolving a Bearer token, the "it never reaches the resolvers"
 * assertion below becomes true for the wrong reason, so the anchor is checked
 * first.
 */
const OUT_OF_BAND_BEARER: Record<string, string> = {
  // Hand-rolled `tokenHash` lookup; gates on the per-medication grant.
  "app/api/ingest/medication/route.ts": "tokenHash",
  // Resolves through `resolveMcpAuthContext`, the MCP edge of the resolver.
  "app/mcp/route.ts": "resolveMcpAuthContext",
};

/* -------------------------------------------------------------------------- */
/* The matcher's own proof                                                    */
/* -------------------------------------------------------------------------- */

describe("the matchers see what they look for", () => {
  /**
   * These run against strings, not the tree, and they are the reason the empty
   * allowlists above mean anything. Every leg below reports "no route calls
   * these resolvers". That sentence is worth exactly as much as the evidence
   * that the matcher could have said otherwise.
   */
  const DELEGABLE_MODULE = `
    import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
    import { apiSuccess } from "@/lib/api-response";

    export const GET = apiHandler(async () => {
      const { user, actor } = await requireRecordAuth("read");
      return apiSuccess({ owner: user.id, actor: actor.id });
    });
  `;

  const ALIASED_MODULE = `
    import { requireRecordAuth as resolveRecord } from "@/lib/api-handler";

    export const GET = apiHandler(async () => {
      const { user } = await resolveRecord("read");
      return apiSuccess({ id: user.id });
    });
  `;

  const NAMESPACE_MODULE = `
    import * as auth from "@/lib/api-handler";

    export const GET = auth.apiHandler(async () => {
      const { user } = await auth.requireActorAuth();
      return apiSuccess({ id: user.id });
    });
  `;

  const PROSE_ONLY_MODULE = `
    /**
     * Not delegable: requireRecordAuth would substitute the data scope, and
     * this route reads the caller's own notification channels. requireAdmin is
     * not used either.
     */
    import { apiHandler, requireAuth } from "@/lib/api-handler";

    const NOTE = "requireActorAuth";

    export const GET = apiHandler(async () => {
      const { user } = await requireAuth();
      return apiSuccess({ id: user.id, note: NOTE });
    });
  `;

  it("finds a direct call", () => {
    expect(identifiersIn(DELEGABLE_MODULE, "d.ts").has(RECORD_RESOLVER)).toBe(
      true,
    );
  });

  it("finds an aliased import, which a call-site matcher would miss", () => {
    const ids = identifiersIn(ALIASED_MODULE, "a.ts");
    expect(ids.has(RECORD_RESOLVER)).toBe(true);
    // The call itself reads `resolveRecord(`. Matching calls rather than
    // identifiers would have found nothing here and reported the route clean.
    expect(ids.has("resolveRecord")).toBe(true);
  });

  it("finds a namespace-qualified call", () => {
    expect(identifiersIn(NAMESPACE_MODULE, "n.ts").has(ACTOR_RESOLVER)).toBe(
      true,
    );
  });

  it("does not enrol a module that only mentions the resolvers", () => {
    const ids = identifiersIn(PROSE_ONLY_MODULE, "p.ts");
    expect(ids.has(RECORD_RESOLVER)).toBe(false);
    expect(ids.has(ACTOR_RESOLVER)).toBe(false);
    expect(ids.has("requireAdmin")).toBe(false);
    // And it is a real module, not an empty parse.
    expect(ids.has("requireAuth")).toBe(true);
  });

  it("the substring pre-filter decides nothing", () => {
    // The prose module contains all three names as raw text. If the pre-filter
    // were doing the deciding, the assertions above would be inverted.
    expect(PROSE_ONLY_MODULE.includes(RECORD_RESOLVER)).toBe(true);
    expect(PROSE_ONLY_MODULE.includes(ACTOR_RESOLVER)).toBe(true);
    expect(PROSE_ONLY_MODULE.includes("requireAdmin")).toBe(true);
  });

  it("reads the need argument through a direct, aliased and namespaced call", () => {
    // The write leg turns on this and nothing else. `requireRecordAuth("read")`
    // and `requireRecordAuth("write")` are the same identifier, so the
    // identifier matcher above cannot tell a delegable read from a delegable
    // write; if this matcher silently returned an empty set, the write leg
    // would compare an empty set to an empty literal and agree with itself.
    expect([...callSitesIn(DELEGABLE_MODULE, "d.ts")]).toContainEqual({
      name: RECORD_RESOLVER,
      firstArg: "read",
    });

    const WRITE_MODULE = `
      import { requireRecordAuth as resolveRecord } from "@/lib/api-handler";

      export const POST = apiHandler(async () => {
        const { user } = await resolveRecord("write");
        await auditLog("thing.create", { userId: user.id });
        return apiSuccess({ id: user.id });
      });
    `;
    const aliased = callSitesIn(WRITE_MODULE, "w.ts");
    // Resolved back through the import table: the call site itself reads
    // `resolveRecord(`, and a matcher keyed on the written name would report
    // this module as neither a read nor a write.
    expect(aliased).toContainEqual({
      name: RECORD_RESOLVER,
      firstArg: "write",
    });
    expect(aliased.some((c) => c.name === "auditLog")).toBe(true);

    const NAMESPACED_WRITE = `
      import * as auth from "@/lib/api-handler";

      export const POST = auth.apiHandler(async () => {
        const { user } = await auth.requireRecordAuth("write");
        return apiSuccess({ id: user.id });
      });
    `;
    expect(callSitesIn(NAMESPACED_WRITE, "nw.ts")).toContainEqual({
      name: RECORD_RESOLVER,
      firstArg: "write",
    });
  });

  it("does not read a need out of prose or an unrelated string", () => {
    // The word "write" appears twice as raw text here and neither occurrence
    // is an argument to the resolver. A grep-shaped matcher enrols this file.
    const NOT_A_WRITE = `
      /** This route is delegable for reads. It must never write. */
      import { requireRecordAuth } from "@/lib/api-handler";

      const MODE = "write";

      export const GET = apiHandler(async () => {
        const { user } = await requireRecordAuth("read");
        return apiSuccess({ id: user.id, mode: MODE });
      });
    `;
    const sites = callSitesIn(NOT_A_WRITE, "nr.ts");
    // Non-zero: the parse produced call sites, so the negative below is a
    // measurement rather than an empty walk.
    expect(sites.length).toBeGreaterThan(0);
    expect(sites).toContainEqual({ name: RECORD_RESOLVER, firstArg: "read" });
    expect(sites).not.toContainEqual({
      name: RECORD_RESOLVER,
      firstArg: "write",
    });
    expect(NOT_A_WRITE.includes('"write"')).toBe(true);
  });

  it("does not count an imported-but-uncalled auditLog", () => {
    // Leg (e)'s audit assertion asks whether the module CALLS the helper. An
    // import the module never reaches would satisfy an identifier matcher and
    // stamp no actor on anything.
    const IMPORTED_ONLY = `
      import { auditLog } from "@/lib/auth/audit";
      import { requireRecordAuth } from "@/lib/api-handler";

      export const POST = apiHandler(async () => {
        const { user } = await requireRecordAuth("write");
        return apiSuccess({ id: user.id, helper: auditLog.name });
      });
    `;
    const sites = callSitesIn(IMPORTED_ONLY, "io.ts");
    expect(sites).toContainEqual({ name: RECORD_RESOLVER, firstArg: "write" });
    expect(sites.some((c) => c.name === "auditLog")).toBe(false);
    // …while the identifier matcher, which is the one this would have fooled,
    // says yes.
    expect(identifiersIn(IMPORTED_ONLY, "io.ts").has("auditLog")).toBe(true);
  });

  it("sees a client-level audit write, and not a comment about one", () => {
    const OFFENDER = `
      import { prisma } from "@/lib/db";
      import { requireRecordAuth } from "@/lib/api-handler";

      export const POST = apiHandler(async () => {
        const { user } = await requireRecordAuth("write");
        prisma.auditLog
          .create({ data: { userId: user.id, action: "thing.failed" } })
          .catch(() => {});
        return apiSuccess({ id: user.id });
      });
    `;
    // Split across lines exactly as the shipped call sites were. A matcher
    // demanding a literal `prisma.auditLog.create(` on one line finds nothing
    // here — the class of bug this repository has already shipped twice.
    expect(directAuditWritesIn(OFFENDER, "off.ts")).toEqual([
      "prisma.auditLog.create",
    ]);

    const PROSE = `
      import { auditLog } from "@/lib/auth/audit";

      export const POST = apiHandler(async () => {
        // Through auditLog() rather than a bare prisma.auditLog.create,
        // because only the helper stamps the actor.
        await auditLog("thing.created", {});
        return apiSuccess({});
      });
    `;
    expect(directAuditWritesIn(PROSE, "prose.ts")).toEqual([]);
    expect(PROSE.includes("prisma.auditLog.create")).toBe(true);
  });

  it("the co-occurrence rule fires on a module that does both", () => {
    // Leg (c) finds nothing on today's tree because no delegable module runs a
    // role check. This is the shape it exists to catch, proved against the
    // same predicate the tree scan uses.
    const OFFENDER = `
      import { requireRecordAuth, requireAdmin } from "@/lib/api-handler";

      export const POST = apiHandler(async () => {
        await requireAdmin();
        const { user } = await requireRecordAuth("write");
        return apiSuccess({ id: user.id });
      });
    `;
    const ids = identifiersIn(OFFENDER, "o.ts");
    expect(ids.has(RECORD_RESOLVER)).toBe(true);
    expect(COOKIE_ONLY_HELPERS.some((h) => ids.has(h))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The anchor: the symbols this file names are the symbols in production       */
/* -------------------------------------------------------------------------- */

describe("the resolvers exist and live in one place", () => {
  it("both are exported from the auth layer", () => {
    // If either symbol were renamed, every leg below would find nothing and
    // agree with its empty allowlist. This is the assertion that stops that.
    const exported = exportedFunctionNames("lib/api-handler.ts");
    expect(exported.length).toBeGreaterThan(0);
    expect(exported).toContain(RECORD_RESOLVER);
    expect(exported).toContain(ACTOR_RESOLVER);
  });

  it("nothing outside the frozen route lists reaches either resolver", () => {
    // A shared helper calling `requireRecordAuth` would make every route that
    // imports it delegable without any route file saying so. The route-level
    // legs below cannot see that; this one can.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(SOURCE_FILE_FLOOR);

    const naming = files.filter(
      (rel) =>
        namesSymbol(rel, RECORD_RESOLVER) || namesSymbol(rel, ACTOR_RESOLVER),
    );

    expect(naming.length).toBeGreaterThan(0);
    expect(naming).toEqual(
      [
        // Declares both. Not a caller.
        "lib/api-handler.ts",
        ...Object.keys(DELEGABLE_ROUTES),
        ...Object.keys(ACTOR_ROUTES),
      ].sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* (a) the delegable list                                                     */
/* -------------------------------------------------------------------------- */

describe("(a) the delegable route set is frozen", () => {
  it("equals the frozen list", () => {
    const scanned = routeModules();

    // The scan must find routes. This is the count that starts non-zero; the
    // result set is the count that starts at zero, and they are not the same
    // claim. Without this line an empty glob and an empty allowlist agree.
    expect(scanned.length).toBeGreaterThan(ROUTE_MODULE_FLOOR);
    expect(scanned.every((rel) => rel.endsWith("/route.ts"))).toBe(true);
    expect(scanned).toContain("app/api/measurements/route.ts");
    // The dot-directory pin. A glob-based enumeration drops this file and the
    // two beside it without saying anything; the scan would still look healthy
    // at 444 modules. Naming one of them makes that failure loud.
    expect(scanned).toContain(
      "app/.well-known/oauth-protected-resource/route.ts",
    );

    // Positive control for this leg's own matcher. It was written when the
    // frozen list was empty and "no route names the resolver" and "the matcher
    // names nothing" were the same sentence; the list is populated now, so the
    // assertion below would catch a neutered matcher on its own. Kept anyway,
    // because a future removal could empty the list again and the day that
    // happens is not the day to rediscover this. `lib/api-handler.ts` is the
    // guaranteed positive — it declares the symbol.
    expect(modulesNaming(["lib/api-handler.ts"], RECORD_RESOLVER)).toEqual([
      "lib/api-handler.ts",
    ]);

    expect(modulesNaming(scanned, RECORD_RESOLVER)).toEqual(
      Object.keys(DELEGABLE_ROUTES).sort(),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* (b) the actor-surface list                                                 */
/* -------------------------------------------------------------------------- */

describe("(b) the actor-surface route set is frozen", () => {
  it("equals the frozen list", () => {
    const scanned = routeModules();

    expect(scanned.length).toBeGreaterThan(ROUTE_MODULE_FLOOR);

    // Positive control, same reason as leg (a).
    expect(modulesNaming(["lib/api-handler.ts"], ACTOR_RESOLVER)).toEqual([
      "lib/api-handler.ts",
    ]);

    expect(modulesNaming(scanned, ACTOR_RESOLVER)).toEqual(
      Object.keys(ACTOR_ROUTES).sort(),
    );
  });
});

describe("every frozen entry carries a reason", () => {
  it("names why the route may say what it says", () => {
    const entries = [
      ...Object.entries(DELEGABLE_ROUTES),
      ...Object.entries(DELEGABLE_WRITE_ROUTES),
      ...Object.entries(ACTOR_ROUTES),
    ];

    for (const [rel, reason] of entries) {
      expect(reason.trim().length, `${rel} has no reason`).toBeGreaterThan(0);
    }

    // The loop above now runs, once. The count stays because it is what makes
    // an addition visible twice — in the list and here — rather than once.
    expect(entries.length).toBe(FROZEN_ENTRY_COUNT);
  });
});

/* -------------------------------------------------------------------------- */
/* (c) the record resolver never sits beside a role or step-up check          */
/* -------------------------------------------------------------------------- */

describe("(c) a record resolver never shares a module with a role or step-up check", () => {
  it("no handler module names both", () => {
    const scanned = routeModules();
    expect(scanned.length).toBeGreaterThan(ROUTE_MODULE_FLOOR);

    // This leg's own non-zero proof, and the one that matters most here: the
    // offender set is empty today whether or not the helper names are right,
    // because no delegable module runs a role check. So each helper has to be
    // findable in the very tree being scanned. Rename `requireAdmin` and this
    // fails, rather than the guard quietly checking for a symbol that no
    // longer exists.
    for (const helper of COOKIE_ONLY_HELPERS) {
      expect(modulesNaming(scanned, helper).length, helper).toBeGreaterThan(0);
    }

    const offenders = scanned.filter((rel) => {
      if (!namesSymbol(rel, RECORD_RESOLVER)) return false;
      const ids = identifiers(rel);
      return COOKIE_ONLY_HELPERS.some((helper) => ids.has(helper));
    });

    expect(offenders).toEqual([]);
  });

  it("the declaration site is out of scope by construction", () => {
    // `lib/api-handler.ts` declares the record resolver AND all three cookie-
    // only helpers, so a scan of every source file would need it exempted, and
    // an exemption is a hole. Scoping the leg to handler modules removes the
    // need for one. This asserts the scoping still holds.
    const src = exportedFunctionNames("lib/api-handler.ts");
    expect(src).toContain(RECORD_RESOLVER);
    for (const helper of COOKIE_ONLY_HELPERS) expect(src).toContain(helper);
    expect(routeModules()).not.toContain("lib/api-handler.ts");
  });
});

/* -------------------------------------------------------------------------- */
/* (d) the out-of-band Bearer surfaces                                        */
/* -------------------------------------------------------------------------- */

describe("(d) the out-of-band Bearer surfaces stay out of the switch", () => {
  it("both are still route modules in the tree", () => {
    const scanned = routeModules();
    for (const rel of Object.keys(OUT_OF_BAND_BEARER)) {
      expect(scanned, rel).toContain(rel);
    }
  });

  it.each(Object.entries(OUT_OF_BAND_BEARER))(
    "%s resolves its own Bearer token and reaches neither resolver",
    (rel, anchor) => {
      const ids = identifiers(rel);

      // Non-zero proof, twice: the parse produced identifiers at all, and the
      // file is still the Bearer surface this list claims it is. A file that
      // stopped resolving a token would satisfy the two assertions below for a
      // reason that has nothing to do with the switch.
      expect(ids.size).toBeGreaterThan(0);
      expect(ids.has(anchor), `${rel} no longer names ${anchor}`).toBe(true);

      expect(ids.has(RECORD_RESOLVER)).toBe(false);
      expect(ids.has(ACTOR_RESOLVER)).toBe(false);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* (e) the delegable WRITE set                                                */
/* -------------------------------------------------------------------------- */

describe("(e) the delegable write set is frozen", () => {
  it("equals the frozen write list", () => {
    const scanned = routeModules();
    expect(scanned.length).toBeGreaterThan(ROUTE_MODULE_FLOOR);

    const writing = scanned.filter((rel) => recordNeeds(rel).has("write"));
    expect(writing).toEqual(Object.keys(DELEGABLE_WRITE_ROUTES).sort());
  });

  it("is a strict subset of the delegable set", () => {
    // A module cannot write into a record it may not read. The read list is
    // where the argument for each file lives, so a write entry with no read
    // entry would be an admission with no recorded reason.
    for (const rel of Object.keys(DELEGABLE_WRITE_ROUTES)) {
      expect(DELEGABLE_ROUTES, rel).toHaveProperty([rel]);
    }
    expect(Object.keys(DELEGABLE_WRITE_ROUTES).length).toBeLessThan(
      Object.keys(DELEGABLE_ROUTES).length,
    );
  });

  it("leaves the rest of the delegable set reading only", () => {
    // The non-zero half of the leg above, and the one that makes an empty
    // matcher fail: the read-only remainder must be found, must be large, and
    // must be found by the SAME matcher that decided the write set. If
    // `recordNeeds` stopped returning anything, this drops to zero and fails
    // rather than agreeing that nothing writes.
    const readOnly = Object.keys(DELEGABLE_ROUTES).filter(
      (rel) => !(rel in DELEGABLE_WRITE_ROUTES),
    );
    expect(readOnly.length).toBeGreaterThan(20);
    for (const rel of readOnly) {
      const needs = recordNeeds(rel);
      expect(needs.has("read"), `${rel} does not resolve a record read`).toBe(
        true,
      );
      expect(needs.has("write"), `${rel} writes without being listed`).toBe(
        false,
      );
    }
  });

  it("every write module files its rows through auditLog", () => {
    // The condition of admission, enforced. `auditLog()` is the only writer
    // that stamps `actorUserId`; a delegated write recorded without it is
    // indistinguishable from the owner having done it themselves, and the
    // decision NOT to add a provenance column to eleven tables was taken on
    // the strength of this trail existing.
    const modules = Object.keys(DELEGABLE_WRITE_ROUTES);
    expect(modules.length).toBeGreaterThan(0);

    for (const rel of modules) {
      expect(callsSymbol(rel, "auditLog"), `${rel} never calls auditLog`).toBe(
        true,
      );
    }
  });

  it("no write module reaches the audit table without the helper", () => {
    // The other half of the same property, and the failure this repository
    // actually shipped: the helper is imported and used on the happy path
    // while a validation-failure breadcrumb goes straight to the table, where
    // it lands with `actorUserId` NULL — a delegate's malformed payload filed
    // as if the owner had typed it. Eleven such calls existed across these
    // files before the write migration.
    //
    // AST, not text, per this file's own doctrine: these modules explain in
    // prose why they no longer call the client directly, and a comment saying
    // so must not be the thing that trips the guard.
    const modules = Object.keys(DELEGABLE_WRITE_ROUTES);
    expect(modules.length).toBeGreaterThan(0);

    for (const rel of modules) {
      expect(
        directAuditWritesIn(read(rel), rel),
        `${rel} writes an audit row without the helper`,
      ).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The counter-test: quiet on the innocent tree                               */
/* -------------------------------------------------------------------------- */

describe("the guard is quiet on the tree it was written against", () => {
  it("the bare-requireAuth population is scanned and produces no findings", () => {
    const scanned = routeModules();

    // The routes that resolve auth the ordinary way. They are the bulk of the
    // tree and the thing this guard must not shout at. Iterating them is what
    // makes "no findings" a measurement rather than a hope: 344 modules read,
    // parsed where the substring appears, and none of them names a resolver.
    const bare = modulesNaming(scanned, "requireAuth").filter(
      (rel) => !(rel in DELEGABLE_ROUTES) && !(rel in ACTOR_ROUTES),
    );
    expect(bare.length).toBeGreaterThan(BARE_REQUIRE_AUTH_FLOOR);

    for (const rel of bare) {
      expect(namesSymbol(rel, RECORD_RESOLVER), rel).toBe(false);
      expect(namesSymbol(rel, ACTOR_RESOLVER), rel).toBe(false);
    }
  });
});
