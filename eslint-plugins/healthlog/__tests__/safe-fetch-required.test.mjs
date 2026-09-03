import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../safe-fetch-required.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("safe-fetch-required", rule, {
  valid: [
    {
      code: "safeFetch(url, { requirePublicHost: true });",
      filename: "/repo/src/lib/notifications/senders/ntfy.ts",
    },
    // Same-origin relative paths never leave the origin.
    {
      code: 'fetch("/api/measurements");',
      filename: "/repo/src/app/dashboard/load.ts",
    },
    {
      code: "fetch(`/api/measurements/${id}`);",
      filename: "/repo/src/lib/queries/measurements.ts",
    },
    // The wrapper's own internals, including the aliased undici import it
    // actually uses. This is the spelling the rule learned to see, so the
    // exemption has to be proven, not assumed.
    {
      code: 'import { fetch as undiciFetch } from "undici"; undiciFetch(url);',
      filename: "/repo/src/lib/safe-fetch.ts",
    },
    {
      code: "fetch(url);",
      filename: "/repo/src/lib/safe-fetch-dispatcher.ts",
    },
    {
      code: "fetch(url);",
      filename: "/repo/src/lib/api/api-fetch.ts",
    },
    // Tests mock and assert against fetch directly.
    {
      code: 'import { fetch as f } from "undici"; f(url);',
      filename: "/repo/src/lib/__tests__/egress.test.ts",
    },
    {
      code: "fetch(url);",
      filename: "/repo/src/lib/__mocks__/transport.ts",
    },
    // Outside every enforced path: scripts and config are out of scope.
    {
      code: "fetch(url);",
      filename: "/repo/scripts/backfill.ts",
    },
    // An aliased import pointed at a relative path is still same-origin.
    {
      code: 'import { fetch as f } from "undici"; f("/api/version");',
      filename: "/repo/src/lib/version.ts",
    },
    // A named import that is not `fetch` binds nothing this rule cares about.
    {
      code: 'import { Agent } from "undici"; Agent(url);',
      filename: "/repo/src/lib/safe-fetch-dispatcher-helper.ts",
    },
  ],
  invalid: [
    {
      code: "fetch(url);",
      filename: "/repo/src/lib/ai/openai-client.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    {
      code: "globalThis.fetch(url);",
      filename: "/repo/src/app/api/withings/route.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    {
      code: "self.fetch(url);",
      filename: "/repo/src/lib/pwa/register.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    {
      code: 'globalThis["fetch"](url);',
      filename: "/repo/src/lib/ai/local-client.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    // Protocol-relative and backslash forms resolve off-origin, so the
    // same-origin exemption must not swallow them.
    {
      code: 'fetch("//evil.example/api");',
      filename: "/repo/src/lib/ai/anthropic-client.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    // The three paths that sat outside the enforced roots. They are
    // egress-free today; instrumentation.ts is where an exporter pointed at
    // an operator-supplied URL would land, and nothing would have said so.
    {
      code: "fetch(url);",
      filename: "/repo/src/proxy.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    {
      code: "fetch(otlpEndpoint, { method: 'POST' });",
      filename: "/repo/src/instrumentation.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    {
      code: "fetch(url);",
      filename: "/repo/src/cli/mcp-stdio.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    // The aliased import. `src/lib/safe-fetch.ts` writes exactly this
    // spelling, so it is a form the codebase demonstrably reaches for, and
    // the identifier check never matched it.
    {
      code: 'import { fetch as f } from "undici"; f(url);',
      filename: "/repo/src/lib/ai/codex-client.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    {
      code: 'import { fetch as undiciFetch } from "undici"; undiciFetch(url);',
      filename: "/repo/src/instrumentation.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    // The namespace form of the same escape.
    {
      code: 'import * as undici from "undici"; undici.fetch(url);',
      filename: "/repo/src/lib/notifications/senders/telegram.ts",
      errors: [{ messageId: "rawFetch" }],
    },
    // A default import named `fetch` was always caught; kept so the widening
    // cannot regress it.
    {
      code: 'import fetch from "node-fetch"; fetch(url);',
      filename: "/repo/src/lib/ai/local-client.ts",
      errors: [{ messageId: "rawFetch" }],
    },
  ],
});
