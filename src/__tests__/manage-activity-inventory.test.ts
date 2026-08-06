import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { revokeBody } from "@/components/settings/access/grants-given-card";
import { recordActivityVerbLine } from "@/lib/record-activity/activity-verb";

/**
 * Every MANAGE-admitted action names itself, in all six locales.
 *
 * ## What this asks that the sibling guard does not
 *
 * `src/lib/record-activity/__tests__/verb-map-covers-routes.test.ts` asks the
 * same question of the WRITE surface: a delegable write whose audit action has
 * no sentence renders as "made a change". MANAGE is where that answer stops
 * being merely vague and starts being wrong. A WRITE delegate can only add,
 * and "somebody added something" is at least the right shape of fact. A MANAGE
 * delegate can change and remove entries the owner made themselves, so the
 * generic line would tell an owner that something happened in their record
 * while withholding the only part they need — whether a reading was corrected
 * or deleted, whether a medication was stopped, whether the dose history was
 * purged. The level ships under "reconstructable or refused", and a feed that
 * cannot say which verb ran does not reconstruct anything.
 *
 * So the inventory here is the MANAGE half of the same sweep, and it goes two
 * steps further than its sibling:
 *
 *   1. it resolves the sentence by CALLING the map rather than by matching
 *      `case "…"` in its source, because a `case` inside a comment matches and
 *      an action whose arm falls through to the fallback does not;
 *   2. it follows the resolved key into all six bundles, because a key that
 *      exists only in English renders as its own dotted path to everyone else.
 *
 * ## PHI
 *
 * Two legs, and both are about the same failure. The activity feed reads out
 * of the audit table, the audit table is not encrypted, and the temptation
 * whenever a sentence feels thin is to put the value in it — "{name} changed
 * your weight from 81 to 78". That is a health figure in a second store with
 * its own retention and no rotation story. So: every verb line interpolates
 * `name` and nothing else, in every locale, and the feed's own DTO carries no
 * `details` field for a future caller to reach for.
 *
 * ## Why the counts are of MATCHES
 *
 * The verdict is an empty list of unmapped actions, and an empty match set
 * says exactly the same thing. Every leg therefore pins the size of what it
 * matched — modules walked, MANAGE modules found, one of them named, actions
 * read, sentences resolved — so a matcher that quietly stopped matching fails
 * instead of passing. `describe("the matcher sees what it looks for")` proves
 * both halves against synthetic modules, including the one shape that silenced
 * the sibling guard: a resolver call prettier broke across lines.
 */
const API = join(process.cwd(), "src/app/api");
const MESSAGES = join(process.cwd(), "messages");
const ACTIVITY_ROUTE = join(
  process.cwd(),
  "src/app/api/account/activity/route.ts",
);
const GRANTS_GIVEN_CARD = join(
  process.cwd(),
  "src/components/settings/access/grants-given-card.tsx",
);

/** The declaration a MANAGE-level route makes. */
const RECORD_RESOLVER = "requireRecordAuth";
/** The level this file is the inventory of. */
const MANAGE = "manage";
/** What an action with no sentence of its own renders as. */
const FALLBACK_KEY = "recordSharing.activity.acted";
/** The six bundles the product ships. */
const LOCALES = ["de", "en", "es", "fr", "it", "pl"] as const;

/** Every `route.ts` under `src/app/api`, walked rather than globbed: a glob's
 *  `*` skips a leading dot and this tree has dot-directories. */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.name === "route.ts") out.push(full);
  }
  return out;
}

interface ModuleFacts {
  /** Does the module pass `"manage"` to the record resolver anywhere. */
  managesRecord: boolean;
  /**
   * The action names of the module's AWAITED `auditLog("…")` calls.
   *
   * Awaited on purpose: a fire-and-forget breadcrumb on a validation failure
   * is not something to narrate to the owner.
   */
  awaitedAuditActions: string[];
}

/**
 * Read both facts off one parse.
 *
 * AST rather than substrings, for the reason the sibling guard learned by
 * going green while matching nothing: prettier moves a call's argument onto
 * its own line the moment the call grows a second one, and
 * `requireRecordAuth("manage"` stops appearing in the source text without
 * anything about the route changing. The import table resolves a local name
 * back to its exported one, so an alias and a namespace-qualified call both
 * count, and a comment naming either symbol counts for nothing.
 */
export function moduleFacts(source: string, fileName: string): ModuleFacts {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

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

  /** The original exported name behind this callee, or null. */
  const calleeName = (callee: ts.Expression): string | null => {
    if (ts.isIdentifier(callee)) return aliases.get(callee.text) ?? callee.text;
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      namespaces.has(callee.expression.text)
    ) {
      return callee.name.text;
    }
    return null;
  };

  /** The first argument when it is a plain string literal. */
  const firstStringArg = (node: ts.CallExpression): string | null => {
    const first = node.arguments[0];
    return first && ts.isStringLiteralLike(first) ? first.text : null;
  };

  let managesRecord = false;
  const awaitedAuditActions: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name === RECORD_RESOLVER && firstStringArg(node) === MANAGE) {
        managesRecord = true;
      }
    }
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)) {
      const call = node.expression;
      if (calleeName(call.expression) === "auditLog") {
        const action = firstStringArg(call);
        if (action !== null) awaitedAuditActions.push(action);
      }
    }
    node.forEachChild(visit);
  };
  parsed.forEachChild(visit);

  return { managesRecord, awaitedAuditActions };
}

/** The message key one action resolves to, or the fallback. */
function verbKeyFor(action: string): { key: string; params: string[] } {
  let key = "";
  let params: string[] = [];
  recordActivityVerbLine(
    (resolved, given) => {
      key = resolved;
      params = Object.keys(given ?? {});
      return resolved;
    },
    action,
    "Alex",
  );
  return { key, params };
}

function bundle(locale: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(MESSAGES, `${locale}.json`), "utf8"),
  ) as Record<string, unknown>;
}

/** The leaf at a dotted path, or undefined. */
function leaf(root: Record<string, unknown>, key: string): unknown {
  let node: unknown = root;
  for (const segment of key.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** The `{placeholders}` a translated sentence interpolates. */
function placeholders(sentence: string): string[] {
  return [...sentence.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe("the matcher sees what it looks for", () => {
  const REFORMATTED = `
    import { requireRecordAuth } from "@/lib/api-handler";
    import { auditLog } from "@/lib/auth/audit";

    export const DELETE = apiHandler(async () => {
      const { user } = await requireRecordAuth(
        "manage",
        "labs",
      );
      await auditLog("thing.delete", { userId: user.id });
      return apiSuccess({ id: user.id });
    });
  `;

  it("matches a resolver call broken across lines", () => {
    // The shape that silenced the sibling guard: the argument moves onto its
    // own line and a substring test goes quiet with nothing else changed.
    expect(REFORMATTED.includes('requireRecordAuth("manage"')).toBe(false);
    const facts = moduleFacts(REFORMATTED, "r.ts");
    expect(facts.managesRecord).toBe(true);
    expect(facts.awaitedAuditActions).toEqual(["thing.delete"]);
  });

  it("matches an aliased and a namespace-qualified resolver call", () => {
    const ALIASED = `
      import { requireRecordAuth as resolveRecord } from "@/lib/api-handler";
      import { auditLog as record } from "@/lib/auth/audit";

      export const DELETE = apiHandler(async () => {
        const { user } = await resolveRecord("manage", "labs");
        await record("thing.aliased");
        return apiSuccess({ id: user.id });
      });
    `;
    expect(moduleFacts(ALIASED, "a.ts")).toEqual({
      managesRecord: true,
      awaitedAuditActions: ["thing.aliased"],
    });

    const NAMESPACED = `
      import * as auth from "@/lib/api-handler";

      export const DELETE = auth.apiHandler(async () => {
        const { user } = await auth.requireRecordAuth("manage", "labs");
        return apiSuccess({ id: user.id });
      });
    `;
    expect(moduleFacts(NAMESPACED, "n.ts").managesRecord).toBe(true);
  });

  it("does not enrol a write route that only talks about managing", () => {
    const WRITE_ONLY = `
      /** Delegable for writes. It must never take requireRecordAuth("manage"). */
      import { requireRecordAuth } from "@/lib/api-handler";

      const LEVEL = "manage";

      export const POST = apiHandler(async () => {
        const { user } = await requireRecordAuth("write", "labs");
        return apiSuccess({ id: user.id, level: LEVEL });
      });
    `;
    // The raw text carries the exact substring a naive membership test uses.
    expect(WRITE_ONLY.includes('requireRecordAuth("manage")')).toBe(true);
    expect(moduleFacts(WRITE_ONLY, "wo.ts").managesRecord).toBe(false);
  });

  it("reads only the awaited audit calls", () => {
    const MIXED = `
      import { requireRecordAuth } from "@/lib/api-handler";
      import { auditLog } from "@/lib/auth/audit";

      export const DELETE = apiHandler(async () => {
        const { user } = await requireRecordAuth("manage", "labs");
        void auditLog("thing.breadcrumb", {});
        await auditLog("thing.delete", { userId: user.id });
        return apiSuccess({ id: user.id });
      });
    `;
    expect(moduleFacts(MIXED, "m.ts").awaitedAuditActions).toEqual([
      "thing.delete",
    ]);
  });

  it("still reports the fallback for an action nobody mapped", () => {
    // The positive control for the recording translator below. Without it, a
    // `verbKeyFor` that always returned the same string would report every
    // action as specific and this file would prove nothing.
    expect(verbKeyFor("nothing.anybody.mapped").key).toBe(FALLBACK_KEY);
  });
});

describe("every MANAGE action has a sentence of its own", () => {
  const routes = routeFiles(API);
  const manageModules = routes
    .map((file) => ({ file, ...moduleFacts(readFileSync(file, "utf8"), file) }))
    .filter((m) => m.managesRecord);
  const actions = [
    ...new Set(manageModules.flatMap((m) => m.awaitedAuditActions)),
  ].sort();

  it("matches the MANAGE modules, and not zero of them", () => {
    // A walk that finds nothing agrees with an inventory that covers nothing.
    expect(routes.length).toBeGreaterThan(300);
    expect(manageModules.length).toBeGreaterThan(0);
    // Named anchors, so a matcher that collapsed to one stray file fails
    // rather than clearing the floor. Deleting a reading and purging a dose
    // history are the two acts the level exists for and the two an owner most
    // needs named.
    const found = manageModules.map((m) => relative(process.cwd(), m.file));
    expect(found).toContain("src/app/api/measurements/[id]/route.ts");
    expect(found).toContain(
      "src/app/api/medications/[id]/intake/purge/route.ts",
    );
    // And the actions themselves were read, not merely looked for.
    expect(actions.length).toBeGreaterThan(40);
  });

  it("gives every one of them a specific verb rather than the fallback", () => {
    const generic = actions.filter(
      (action) => verbKeyFor(action).key === FALLBACK_KEY,
    );

    expect(
      generic,
      "a MANAGE action with no verb line renders to the owner as the generic " +
        "'made a change'. Add a case to activity-verb.ts and a sentence to " +
        "all six bundles.",
    ).toEqual([]);
  });

  it("resolves every verb key in all six bundles", () => {
    const bundles = new Map(LOCALES.map((l) => [l, bundle(l)] as const));
    const missing: string[] = [];
    let resolved = 0;

    for (const action of actions) {
      const { key } = verbKeyFor(action);
      for (const locale of LOCALES) {
        const value = leaf(bundles.get(locale)!, key);
        if (typeof value === "string" && value.length > 0) resolved += 1;
        else missing.push(`${locale}: ${key}`);
      }
    }

    expect(missing.sort()).toEqual([]);
    // Six locales for every action, and the actions were counted above.
    expect(resolved).toBe(actions.length * LOCALES.length);
  });

  it("interpolates the actor's name and nothing else, in every locale", () => {
    const bundles = new Map(LOCALES.map((l) => [l, bundle(l)] as const));
    const leaky: string[] = [];
    let checked = 0;

    for (const action of actions) {
      const { key, params } = verbKeyFor(action);
      // The call site's own parameters first: a sentence cannot leak a value
      // the map never hands it.
      if (params.join(",") !== "name") leaky.push(`${key} passes ${params}`);
      for (const locale of LOCALES) {
        const value = leaf(bundles.get(locale)!, key);
        if (typeof value !== "string") continue;
        checked += 1;
        const found = placeholders(value);
        if (found.length !== 1 || found[0] !== "name") {
          leaky.push(`${locale}: ${key} interpolates ${found.join(", ")}`);
        }
      }
    }

    expect(leaky.sort()).toEqual([]);
    expect(checked).toBe(actions.length * LOCALES.length);
  });
});

describe("the retention disclosure does not depend on a race", () => {
  /**
   * The sentence that bounds attribution — "who entered what is answerable for
   * the next N days" — used to appear only if a SECOND query had already
   * answered. The revoke dialog reads the grant list; the number came off the
   * activity feed. Two independent requests, and whichever lost decided
   * whether the owner was told. An owner who clicked quickly, or whose
   * activity read failed, ended a manage grant having read one sentence fewer
   * than an owner who clicked slowly, with nothing on screen to indicate that
   * a sentence was missing.
   *
   * The number now rides the same payload as the row: if there is a grant to
   * revoke, `retentionDays` is already in hand. Deterministic means there is
   * no branch left, which is what both legs below check from opposite sides —
   * one that the sentence is always composed, one that the second query is
   * gone.
   */
  const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key}(${JSON.stringify(params)})` : key;

  it("states the window on every grant that could have written something", () => {
    for (const access of ["WRITE", "MANAGE"] as const) {
      const body = revokeBody({ t, access, name: "Alex", retentionDays: 90 });
      expect(body).toContain("recordSharing.given.revokeEntriesStay");
      expect(body).toContain(
        'recordSharing.given.revokeAttribution({"days":90})',
      );
    }
    // READ keeps neither: a read grant never put anything in the record, so
    // saying what happens to what they entered would describe an act that
    // cannot have occurred.
    const read = revokeBody({
      t,
      access: "READ",
      name: "Alex",
      retentionDays: 90,
    });
    expect(read).not.toContain("recordSharing.given.revokeAttribution");
  });

  it("takes the number from the read that produced the row", () => {
    const source = readFileSync(GRANTS_GIVEN_CARD, "utf8");
    // Positive control: the matcher can see a hook name in this file at all.
    expect(source.match(/useAccountGrants/g)?.length ?? 0).toBeGreaterThan(0);
    // And the second query, whose arrival used to decide the copy, is gone.
    expect(source).not.toContain("useRecordActivity");
    // The branch it fed is gone with it. A required number cannot be absent,
    // so there is nothing left for a caller to omit — which is the difference
    // between "the sentence is usually there" and "there is no path without
    // it". Both halves are named: the optional marker and the guard.
    expect(source).not.toContain("retentionDays?:");
    expect(source).not.toContain("retentionDays !== undefined");
    expect(source.match(/retentionDays: number/g)?.length ?? 0).toBe(1);
  });
});

describe("the activity feed carries no audit detail", () => {
  /**
   * The DTO the owner's feed publishes, read off the route.
   *
   * A field-level assertion rather than a sentence in a comment, because the
   * pressure to widen it is real and constant: every thin sentence in the feed
   * looks like it wants the value that would make it specific, and the audit
   * row usually has one. `details` is a free-form JSON column written by sixty
   * handlers; publishing it would put whatever any of them decided to file in
   * front of the record owner, and some of them file a label.
   */
  it("publishes five fields, and `details` is not one of them", () => {
    const source = readFileSync(ACTIVITY_ROUTE, "utf8");
    const parsed = ts.createSourceFile(
      ACTIVITY_ROUTE,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    let members: string[] | null = null;
    parsed.forEachChild((node) => {
      if (!ts.isInterfaceDeclaration(node)) return;
      if (node.name.text !== "RecordActivityEntry") return;
      members = node.members
        .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : ""))
        .filter((n) => n.length > 0)
        .sort();
    });

    // The interface was found at all. `toEqual` against null would report the
    // absence as a mismatch of the list, which reads like the wrong failure.
    expect(
      members,
      "RecordActivityEntry not found in the route",
    ).not.toBeNull();
    expect(members).toEqual(["accesses", "action", "actor", "createdAt", "id"]);
  });
});
