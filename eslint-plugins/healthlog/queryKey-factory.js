/**
 * @fileoverview ESLint rule — `queryKey` / `mutationKey` literal-array
 * factory enforcement across the complete client tree.
 *
 * Every TanStack key must come from `src/lib/query-keys/`. The rule flags a
 * bare array wherever a key is supplied, in either of the two shapes TanStack
 * accepts:
 *
 *   - the object property, `{ queryKey: [ … ] }` / `{ mutationKey: [ … ] }`;
 *   - the FIRST POSITIONAL argument of the QueryClient methods that take a key
 *     directly, `setQueryData([ … ], value)`, `getQueryData([ … ])`, and their
 *     siblings below.
 *
 * The positional shape was invisible until 2026-09-03. `setQueryData` seeds
 * the same cache cell that `queryKey:` reads, so a literal there is the same
 * defect written differently — and a probe placing one in a component
 * produced no error at all.
 *
 * Enforced roots: `src/components/`, `src/hooks/`, `src/lib/queries/`,
 * `src/app/`, and any source module declaring top-level `"use client"`.
 * `src/app/` joined the list on the same date: the server prefetch pages there
 * build the keys the client subsequently reads, and a server key that differs
 * from the client's is a cache miss at best and a poisoned cell at worst. They
 * carry no `"use client"` directive, so nothing guarded them before.
 *
 * Accepted call-site shapes include direct factory calls, identifiers already
 * built from the factory, and conditionals selecting factory calls. Tests and
 * the factory definition directory are exempt because they intentionally
 * construct literal fixtures and tuples.
 *
 * Limits, so a green run is not read as more than it is: the positional check
 * matches by METHOD NAME, so a key handed to a helper of the project's own
 * naming (`seedCache(["…"], v)`) is not seen, and conversely an unrelated
 * object with a `setQueryData` method would be flagged. A key assembled into a
 * variable before the call site (`const k = ["a", id]`) is invisible to both
 * checks — only the literal at the key position is matched.
 *
 * @see src/lib/query-keys/
 * @see src/lib/__tests__/query-keys.test.ts
 */

"use strict";

const FACTORY_HOME_DIRECTORY = "src/lib/query-keys";

// Components and hooks are client-facing by convention. Query modules are
// client-transitive even if a future refactor moves the directive to a barrel.
// `src/app/` is where the server prefetch pages seed the client's cache, so
// their keys have to come from the same factory the client reads from.
const GUARDED_ROOTS = [
  "src/components/",
  "src/hooks/",
  "src/lib/queries/",
  "src/app/",
];

// QueryClient methods whose FIRST argument is a query key or mutation key,
// supplied positionally rather than inside an options object. Everything else
// on the client (`invalidateQueries`, `prefetchQuery`, …) takes a filters or
// options object and is covered by the `queryKey:` property check.
const POSITIONAL_KEY_METHODS = new Set([
  "setQueryData",
  "getQueryData",
  "getQueryState",
  "setQueryDefaults",
  "getQueryDefaults",
  "setMutationDefaults",
  "getMutationDefaults",
]);

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

function isGuarded(filename, sourceCode) {
  const posix = toPosix(filename);
  if (!posix.startsWith("src/") && !posix.includes("/src/")) return false;
  if (
    posix.startsWith(`${FACTORY_HOME_DIRECTORY}/`) ||
    posix.includes(`/${FACTORY_HOME_DIRECTORY}/`)
  ) {
    return false;
  }
  if (isTestFile(posix)) return false;
  if (GUARDED_ROOTS.some((root) => posix.includes(root))) return true;
  return sourceCode.ast.body.some(
    (statement) =>
      statement.type === "ExpressionStatement" &&
      statement.directive === "use client",
  );
}

/**
 * The called name, whether the call is bare (`setQueryData(…)`, destructured
 * off the client), a member (`qc.setQueryData(…)`), or a static computed
 * member (`qc["setQueryData"](…)`).
 */
function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type !== "MemberExpression") return null;
  if (!callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  if (callee.computed && callee.property.type === "Literal") {
    return typeof callee.property.value === "string"
      ? callee.property.value
      : null;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const queryKeyFactoryRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow literal-array `queryKey` / `mutationKey` declarations in client modules. Use `queryKeys.<entry>()` from `src/lib/query-keys/` instead.",
      recommended: false,
    },
    messages: {
      bareArray:
        "Bare-array `{{prop}}: [ … ]` bypasses the queryKeys factory. Import from `@/lib/query-keys` and call `queryKeys.<entry>()` so cache-invalidation bundles stay in lockstep.",
      positionalArray:
        "Bare-array key passed to `{{call}}( … )` bypasses the queryKeys factory. It seeds or reads the same cache cell as a `queryKey`, so import from `@/lib/query-keys` and call `queryKeys.<entry>()` instead.",
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    if (!filename || !isGuarded(filename, sourceCode)) {
      return {};
    }

    function checkProperty(node) {
      // `node` is a Property like `queryKey: [ … ]`. Only flag the
      // bare ArrayExpression form — identifiers, call expressions,
      // conditional expressions, etc. are all acceptable indirection
      // through the factory.
      if (!node.value || node.value.type !== "ArrayExpression") return;

      const keyName =
        node.key.type === "Identifier"
          ? node.key.name
          : node.key.type === "Literal"
            ? node.key.value
            : null;
      if (keyName !== "queryKey" && keyName !== "mutationKey") return;

      context.report({
        node,
        messageId: "bareArray",
        data: { prop: keyName },
      });
    }

    function checkPositional(node) {
      const name = calleeName(node.callee);
      if (!name || !POSITIONAL_KEY_METHODS.has(name)) return;
      const first = node.arguments[0];
      if (!first || first.type !== "ArrayExpression") return;

      context.report({
        node: first,
        messageId: "positionalArray",
        data: { call: name },
      });
    }

    return {
      Property: checkProperty,
      CallExpression: checkPositional,
    };
  },
};

module.exports = {
  rules: {
    "queryKey-factory": queryKeyFactoryRule,
  },
};
