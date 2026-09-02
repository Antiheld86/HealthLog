/**
 * @fileoverview ESLint rule — outbound `fetch` must route through the
 * `safeFetch` wrapper.
 *
 * v1.5.6 — `src/lib/safe-fetch.ts` is the documented egress entry point:
 * it pins `redirect: "manual"` + an `AbortSignal.timeout` by default and
 * gates the connect-time IP pin behind `requirePublicHost`. A raw
 * `fetch(...)` call under `src/lib/` or `src/app/` bypasses every one of
 * those defences, so this rule flags it at authoring time and in CI.
 *
 * Allowed:
 *   - `safeFetch(...)`                       — the wrapper itself.
 *   - calls inside `src/lib/safe-fetch.ts`   — the wrapper's own `fetch`.
 *   - calls inside `src/lib/safe-fetch-dispatcher.ts` — the pinned dispatcher.
 *   - test files (`*.test.ts(x)`, `__tests__/`, `__mocks__/`) — they
 *     mock or assert against `fetch` directly.
 *
 * The check is a syntactic `CallExpression` match against a bare
 * `fetch(` callee (Identifier `fetch`), the `globalThis.fetch(` /
 * `window.fetch(` / `self.fetch(` member forms, and — since 2026-09-03 —
 * any local name bound to a module's `fetch` export or reached through a
 * namespace import. `safeFetch` is a distinct identifier and never matches.
 *
 * The aliased spelling is not hypothetical: `src/lib/safe-fetch.ts` opens
 * with `import { fetch as undiciFetch } from "undici"`, so the codebase
 * demonstrably reaches for it, and every copy of that spelling outside the
 * wrapper escaped the rule in every file.
 *
 * Limits, so a green run is not read as more than it is: the binding scan
 * walks top-level `import` declarations only. A `require("undici").fetch`,
 * a dynamic `await import(...)`, a fetch handed through a parameter or
 * stored on an object, and a local shadow of an imported name are all
 * outside it — as is any egress that never spells `fetch` at all, such as
 * `http.request` or a client library with its own transport.
 *
 * Same-origin client fetches are exempt: a first argument that is a
 * string literal (or template head) starting with `/` is a relative,
 * same-origin request (`fetch("/api/…")`) that never leaves the origin
 * and has no SSRF / redirect-leak / DNS-rebinding surface. The wrapper
 * is for OUTBOUND egress to external hosts — absolute URLs or
 * variable-sourced targets — which is exactly what stays flagged.
 *
 * @see src/lib/safe-fetch.ts
 * @see src/lib/safe-fetch-dispatcher.ts
 */

"use strict";

// Files exempt from the rule — the wrapper internals and the test
// surface. Posix-style suffix matches against the absolute filename via
// `String#includes`, mirroring the queryKey-factory rule's convention.
const EXEMPT_FILES = [
  "src/lib/safe-fetch.ts",
  "src/lib/safe-fetch-dispatcher.ts",
  // The same-origin `/api/...` envelope wrapper: its `fetch` calls are
  // relative-path by contract (the api-fetch-required rule pins every
  // client call site onto it), so the egress defences don't apply.
  "src/lib/api/api-fetch.ts",
];

// Only enforce inside the application source. Scripts, config, and generated
// code are out of scope.
//
// The list carries three single files alongside the two directory roots.
// `src/proxy.ts`, `src/instrumentation.ts` and `src/cli/` sit outside
// `src/lib/` and `src/app/`, and the companion `healthlog/api-fetch-required`
// does not reach them either (it guards the client surface), so between them
// they were egress-unguarded. They are egress-free today; instrumentation is
// precisely where an exporter pointed at an operator-supplied URL would land,
// and nothing would have flagged it.
const ENFORCED_PATHS = [
  "src/lib/",
  "src/app/",
  "src/proxy.ts",
  "src/instrumentation.ts",
  "src/cli/",
];

// Objects that carry the platform `fetch`. Treated as namespaces below so the
// member form goes through one code path with the imported-namespace case.
const GLOBAL_FETCH_OBJECTS = ["globalThis", "window", "self"];

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(posix) ||
    /\.spec\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

function isEnforced(filename) {
  const posix = toPosix(filename);
  if (!ENFORCED_PATHS.some((path) => posix.includes(path))) return false;
  if (EXEMPT_FILES.some((f) => posix.includes(f))) return false;
  if (isTestFile(posix)) return false;
  return true;
}

/** @type {import("eslint").Rule.RuleModule} */
const safeFetchRequiredRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Outbound fetch must route through the safeFetch wrapper (src/lib/safe-fetch.ts).",
    },
    schema: [],
    messages: {
      rawFetch:
        'Raw fetch() bypasses the safeFetch wrapper\'s manual-redirect + timeout (and requirePublicHost) defences. Import { safeFetch } from "@/lib/safe-fetch" and call it instead.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    const sourceCode = context.sourceCode ?? context.getSourceCode();
    if (!filename || !isEnforced(filename)) {
      return {};
    }

    // Local names this module bound to somebody's `fetch`, collected from the
    // top-level imports before any call site is visited. `import { fetch as f }
    // from "undici"` makes `f(...)` a fetch call; `import * as undici from
    // "undici"` makes `undici.fetch(...)` one.
    const aliasedFetch = new Set();
    const namespaces = new Set([...GLOBAL_FETCH_OBJECTS]);
    for (const node of sourceCode.ast.body) {
      if (node.type !== "ImportDeclaration") continue;
      for (const specifier of node.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          const imported =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value;
          if (imported === "fetch") aliasedFetch.add(specifier.local.name);
        } else if (specifier.type === "ImportNamespaceSpecifier") {
          namespaces.add(specifier.local.name);
        }
      }
    }

    function isFetchCallee(callee) {
      // Bare `fetch(...)`, and any local name bound to an imported `fetch`.
      if (callee.type === "Identifier") {
        return callee.name === "fetch" || aliasedFetch.has(callee.name);
      }
      if (callee.type !== "MemberExpression") return false;
      // `globalThis.fetch(...)` / `window.fetch(...)` / `self.fetch(...)` and
      // `<namespace>.fetch(...)`, including the static computed spelling.
      if (
        callee.object.type !== "Identifier" ||
        !namespaces.has(callee.object.name)
      ) {
        return false;
      }
      const property = !callee.computed
        ? callee.property.type === "Identifier"
          ? callee.property.name
          : null
        : callee.property.type === "Literal"
          ? callee.property.value
          : null;
      return property === "fetch";
    }

    function isSameOriginRelative(arg) {
      if (!arg) return false;
      // A single leading `/` not followed by `/` or `\`. `//evil.com` is a
      // protocol-relative absolute URL and `/\evil.com` normalises to the
      // same under WHATWG parsing — both resolve off-origin, so neither is
      // a same-origin path and the wrapper must still cover them.
      const isRelativeHead = (head) => /^\/(?![/\\])/.test(head);
      // `fetch("/api/…")`
      if (arg.type === "Literal" && typeof arg.value === "string") {
        return isRelativeHead(arg.value);
      }
      // `fetch(`/api/${id}`)` — inspect the template's first cooked chunk.
      if (arg.type === "TemplateLiteral" && arg.quasis.length > 0) {
        return isRelativeHead(arg.quasis[0].value.cooked ?? "");
      }
      return false;
    }

    return {
      CallExpression(node) {
        if (!isFetchCallee(node.callee)) return;
        // Exempt same-origin relative-path requests — they never leave
        // the origin, so the wrapper's outbound defences do not apply.
        if (isSameOriginRelative(node.arguments[0])) return;
        context.report({ node, messageId: "rawFetch" });
      },
    };
  },
};

module.exports = safeFetchRequiredRule;
