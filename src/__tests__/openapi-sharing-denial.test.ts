/**
 * v1.37.0 — one refusal, on every path a delegate can reach.
 *
 * A route that resolves through `requireRecordAuth` / `requireGuardianAuth` can
 * be asked to act on somebody else's record, and can therefore answer 403
 * `sharing.access.denied`. Before this file that fact was published once, on the
 * per-request selector parameter, and on none of the hundred and twenty
 * operations that produce it: a client reading the spec for `/api/measurements`
 * learned that the header existed somewhere and nothing about what the read
 * does when the grant behind it ends. This guard closes the pair — the set of
 * fenced operations is recomputed from the route sources on every run, and
 * every member has to publish the same sentence, byte for byte.
 *
 * ## Byte-identical, and why it is the point
 *
 * The refusal carries no reason on the wire. A selector naming an account that
 * does not exist, one naming an account that granted nothing, a grant whose
 * sections do not reach the surface, and a read grant on a write — all four are
 * the same status, the same code and the same bytes, because a distinguishable
 * refusal is an account-enumeration oracle for anyone with a login. A contract
 * that described them differently per path would invite a client to tell them
 * apart, and the first client that tried would be reading tea leaves. So the
 * description is ONE string, spliced into every fenced operation, and a
 * paraphrase on one path fails here.
 *
 * ## What this guard deliberately does not do
 *
 * - It classifies per VERB, not per file, because the two disagree on
 *   seventeen route modules: `GET /api/dashboard/widgets` is delegable and its
 *   `PUT` is not. The matcher takes each handler's own top-level declaration
 *   and follows every declaration in the same module it names, transitively —
 *   which is how `POST /api/custom-metrics` (body in `postCustomMetric`) and
 *   `POST /api/cycle/day-logs` (body in `postDayLog`, wrapped in
 *   `withIdempotency` and declared BELOW the `GET`) are classified correctly. A
 *   first draft that segmented on export boundaries and matched call sites got
 *   both of those wrong, in both directions.
 * - It resolves within the module only. A handler whose fence lived in an
 *   imported helper would read as unfenced; `sharing-surface-guard.test.ts` is
 *   what holds the declaration to the route module itself.
 * - It says nothing about the verbs that are NOT fenced. Those refuse a
 *   switched caller with `sharing.not_permitted` — a different fact, published
 *   today only where the sharing family itself documents it. Naming it on every
 *   authenticated path in the application is a larger contract change than a
 *   freeze should make.
 * - Comments are stripped before matching. `.../guardians/route.ts` names both
 *   fence helpers in a docblock explaining why it uses neither, and counting
 *   prose would classify an actor surface as delegable.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openApiPaths } from "@/lib/openapi/routes";
import { SHARING_ACCESS_DENIED_DESCRIPTION } from "@/lib/openapi/routes/shared";

const ROOT = process.cwd();
const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** A published operation, resolved to the module that serves it. */
interface PublishedOperation {
  path: string;
  method: HttpMethod;
  /** The operation object as the route table declares it. */
  operation: Record<string, unknown>;
  /** The handler's own declaration plus every module-local one it names. */
  handlerSource: string;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function routeModulePath(apiPath: string): string {
  return join(
    ROOT,
    "src/app",
    apiPath.replace(/\{([^}]+)\}/g, "[$1]"),
    "route.ts",
  );
}

/**
 * Every top-level declaration in a module, by name.
 *
 * The unit is the declaration and not the line range between two exports,
 * because a route module puts helpers wherever it likes: `cycle/day-logs`
 * declares `postDayLog` BELOW its `GET`, so a naive "from this export to the
 * next" slice hands GET a body that belongs to POST.
 */
function topLevelChunks(source: string): Map<string, string> {
  const declaration =
    /^(?:export\s+)?(?:async\s+function|function|const|let|class)\s+([A-Za-z0-9_$]+)/gm;
  const found = [...source.matchAll(declaration)];
  const chunks = new Map<string, string>();
  found.forEach((match, index) => {
    const from = match.index ?? 0;
    const to = found[index + 1]?.index ?? source.length;
    chunks.set(match[1], source.slice(from, to));
  });
  return chunks;
}

/**
 * The text a handler can reach: its own declaration plus every top-level
 * declaration in the same module it names, transitively.
 *
 * Both indirections in the tree need this. `apiHandler(postCustomMetric)`
 * names its body as a bare reference, and
 * `apiHandler(withIdempotency<[NextRequest]>(postDayLog))` names it as an
 * argument to a wrapper — neither is a call site, so a matcher keyed on
 * `name(` finds nothing and the handler reads as unfenced. It resolves within
 * the module only: a fence resolved in an imported helper would be missed, and
 * `sharing-surface-guard.test.ts` is what holds the declaration to the route
 * module.
 */
function handlerText(source: string, method: HttpMethod): string {
  const chunks = topLevelChunks(source);
  const own = chunks.get(method.toUpperCase());
  if (!own) return "";

  const seen = new Set([method.toUpperCase()]);
  let text = own;
  for (let depth = 0; depth < 5; depth += 1) {
    const named = [...text.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g)].map(
      (match) => match[1],
    );
    const next = named.filter((name) => chunks.has(name) && !seen.has(name));
    if (next.length === 0) break;
    for (const name of next) {
      seen.add(name);
      text += chunks.get(name);
    }
  }
  return text;
}

function publishedOperations(): PublishedOperation[] {
  const operations: PublishedOperation[] = [];
  const missing: string[] = [];
  for (const [path, item] of Object.entries(openApiPaths)) {
    const modulePath = routeModulePath(path);
    if (!existsSync(modulePath)) {
      missing.push(path);
      continue;
    }
    const source = stripComments(readFileSync(modulePath, "utf8"));
    for (const method of HTTP_METHODS) {
      const operation = (item as Record<string, unknown>)[method];
      if (!operation || typeof operation !== "object") continue;
      operations.push({
        path,
        method,
        operation: operation as Record<string, unknown>,
        handlerSource: handlerText(source, method),
      });
    }
  }
  // A published path with no route module would silently drop out of every
  // assertion below, so it fails here instead.
  expect(missing, "published paths with no route module").toEqual([]);
  return operations;
}

/** Does this handler resolve the record fence? */
function isFenced(operation: PublishedOperation): boolean {
  return /require(?:Record|Guardian)Auth\s*\(/.test(operation.handlerSource);
}

function refusal(
  operation: PublishedOperation,
): { description?: string; content?: unknown } | null {
  const responses = operation.operation.responses as
    Record<string, { description?: string; content?: unknown }> | undefined;
  return responses?.["403"] ?? null;
}

const operations = publishedOperations();
const fenced = operations.filter(isFenced);
const unfenced = operations.filter((operation) => !isFenced(operation));
const name = (operation: PublishedOperation) =>
  `${operation.method.toUpperCase()} ${operation.path}`;

describe("the sharing refusal every delegable path publishes", () => {
  it("discovers a real set of fenced operations", () => {
    // Non-zero, and anchored at both ends: a matcher that stopped matching
    // would leave every assertion below vacuously true.
    expect(operations.length).toBeGreaterThan(200);
    expect(fenced.length).toBeGreaterThan(100);

    const fencedNames = fenced.map(name);
    expect(fencedNames).toContain("GET /api/measurements");
    expect(fencedNames).toContain("POST /api/labs");
    expect(fencedNames).toContain("GET /api/dashboard/widgets");

    const unfencedNames = unfenced.map(name);
    // The other half of the same module: `PUT` and `DELETE` on the widget
    // layout are the caller's own settings and refuse a switch outright.
    expect(unfencedNames).toContain("PUT /api/dashboard/widgets");
    expect(unfencedNames).toContain("DELETE /api/dashboard/widgets");
    // An actor surface, and a route whose docblock names both fence helpers
    // while calling neither.
    expect(unfencedNames).toContain("GET /api/auth/me");
    expect(unfencedNames).toContain("GET /api/managed-profiles/{id}/guardians");
  });

  it("publishes the refusal on every fenced operation", () => {
    const silent = fenced.filter((operation) => {
      const response = refusal(operation);
      return (
        !response ||
        !response.description?.includes(SHARING_ACCESS_DENIED_DESCRIPTION)
      );
    });

    if (silent.length > 0) {
      throw new Error(
        `${silent.length} delegable operation(s) publish no sharing refusal:\n` +
          silent.map((operation) => `  ❌ ${name(operation)}`).join("\n") +
          "\n\nSpread `...recordRefusal()` into the operation's responses — or " +
          "`...recordRefusal(<the other reason>)` when it already answers 403 " +
          "for a module gate or a consent gate.",
      );
    }
  });

  it("says it the same way every time", () => {
    // One string, not ninety paraphrases. Collected from the published objects
    // rather than asserted against the constant, so a hand-written copy that
    // differs by a comma is what this catches.
    const sentences = new Set(
      fenced.map((operation) => {
        const description = refusal(operation)?.description ?? "";
        const at = description.indexOf(SHARING_ACCESS_DENIED_DESCRIPTION);
        return description.slice(at);
      }),
    );
    expect(sentences.size).toBe(1);
    expect([...sentences][0]).toBe(SHARING_ACCESS_DENIED_DESCRIPTION);

    // What the sentence has to carry: the code a client branches on, and the
    // indistinguishability that keeps it from being an enumeration oracle.
    expect(SHARING_ACCESS_DENIED_DESCRIPTION).toContain(
      "sharing.access.denied",
    );
    expect(SHARING_ACCESS_DENIED_DESCRIPTION.length).toBeGreaterThan(200);
  });

  it("keeps it off the paths that cannot answer with it", () => {
    const overreaching = unfenced.filter((operation) =>
      refusal(operation)?.description?.includes(
        SHARING_ACCESS_DENIED_DESCRIPTION,
      ),
    );
    expect(overreaching.map(name)).toEqual([]);
  });

  it("carries the refusal into the generated document", () => {
    const spec = readFileSync(join(ROOT, "docs/api/openapi.yaml"), "utf8");
    expect(spec).toContain(SHARING_ACCESS_DENIED_DESCRIPTION.slice(0, 60));
    // The emitter aliases identical response objects, so the sentence appears
    // once per DISTINCT composition rather than once per path. Both ends are
    // checked: the text is there, and the paths that reference it outnumber it.
    const aliases = spec.match(/"403": \*/g)?.length ?? 0;
    expect(aliases).toBeGreaterThan(fenced.length - 10);
  });
});
