/**
 * Every route on disk is either published or declared unpublished.
 *
 * `pnpm openapi:check` compares the registry against `docs/api/openapi.yaml`
 * and fails on drift between them. It has never compared the ROUTES against
 * the registry, so a route that was never registered at all produced no drift
 * and no failure: the spec was internally consistent and silently incomplete.
 * That is how two hundred and twenty-two paths, forty-three of them called by
 * the native client, ended up undocumented while the contract check ran green
 * on every commit for months. The first count taken of this gap said
 * forty-five, because it compared against the paths the YAML already listed
 * rather than against the verbs the routes export.
 *
 * This file closes the third side of the triangle. It walks `src/app` for
 * route modules, reads the HTTP verbs each one actually exports, and requires
 * every verb to be either present in the route table or named in
 * {@link UNPUBLISHED} with a reason. There is no third outcome. Adding a route
 * without touching either side fails here, which is the only place it can be
 * caught before a client goes looking for a contract that was never written.
 *
 * ## Why the exemption list carries prose
 *
 * A bare allowlist of paths decays into a place to put things. Each entry here
 * says WHY the route is absent from the public contract, so the next reader can
 * disagree with the reason rather than guess at it, and so an entry whose
 * reason has stopped being true is visible as text rather than as a path in a
 * list. The reasons fall into a small number of kinds — browser-only
 * navigation, an OAuth callback the provider drives, a webhook authenticated by
 * a shared secret, an internal cron trigger — and a route that does not fit one
 * of those kinds probably belongs in the spec.
 *
 * ## What this guard does NOT prove
 *
 * - It proves a verb is PRESENT in the table, not that the operation is
 *   accurate. A published path whose request schema has drifted from the
 *   handler passes here. That is the limit of a structural check; the accuracy
 *   comes from the schemas being imported from `src/lib/validations/*` rather
 *   than retyped.
 * - It reads exports with a regex over comment-stripped source. A verb exported
 *   through an indirection this matcher cannot see would read as absent, which
 *   fails loudly rather than passing quietly, and is the direction an
 *   imprecise matcher should fail in.
 * - `globSync` skips dot-directories by default, which once hid fourteen guards
 *   from `src/app/.well-known`. The sweep below passes an explicit pattern list
 *   that includes it, and asserts a floor on the number of modules found so an
 *   enumeration that silently matches nothing cannot read as full coverage.
 *
 * Mutation check: delete any single entry from {@link UNPUBLISHED} and this
 * file fails naming that path; delete a path from a registry module and it
 * fails naming the verbs that lost their contract.
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { relative } from "node:path";

import { describe, expect, it } from "vitest";

import { openApiPaths } from "@/lib/openapi/routes";

const ROOT = process.cwd();

/**
 * The verbs a route module can export. `HEAD` and `OPTIONS` are deliberately
 * out: Next.js answers both from the others, and neither is a contract a client
 * writes against.
 */
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * The kinds of route that are deliberately outside the published contract.
 *
 * A kind rather than a free-text reason per path, because these fall into a
 * small number of genuinely different shapes and writing the same sentence
 * seventy-three times would hide the one entry whose sentence is different. A
 * route that fits none of these kinds belongs in the spec.
 */
const REASONS = {
  /**
   * `requireAdmin()` is cookie-only by construction (`src/lib/api-handler.ts`),
   * so a Bearer token cannot reach these however wide its scope. The only
   * caller that can is the operator's own browser on the admin console, which
   * ships with the server and does not read a spec to find out what it talks
   * to. Publishing them would describe an API surface that no API client can
   * use.
   */
  adminConsole:
    "cookie-only admin console; requireAdmin() refuses every Bearer caller",
  /**
   * A browser navigation, not a request a client makes and reads. The response
   * is a redirect to the provider's own authorise page; the client that starts
   * it is a link, and the thing that follows it is the address bar.
   */
  browserHandoff:
    "browser navigation that ends at the provider's authorise page",
  /**
   * Driven by the provider, arriving with the provider's own query string. A
   * client never constructs one, and the contract that governs its shape is
   * the provider's, not this one.
   */
  oauthCallback: "provider-driven redirect back from an OAuth authorise step",
  /**
   * Called by the provider, authenticated by a shared secret rather than by a
   * session or a token. The payload shape is the provider's to define, and
   * documenting it here would suggest a caller could construct one.
   */
  providerWebhook:
    "provider-called, authenticated by a shared secret rather than a session",
  /**
   * Serves the deployment itself: crash reports, web vitals, the analytics
   * proxy, the deploy hook. No user-facing client calls these, and two of them
   * accept a body defined by a browser reporting standard rather than by us.
   */
  internalOps: "serves the deployment itself, not any user-facing client",
  /**
   * The Model Context Protocol transport and the OAuth dance in front of it.
   * These speak wire formats that MCP and RFC 8414 / RFC 7591 define, including
   * error bodies the standard response envelope cannot express, which is why
   * they are the documented exception to the `apiHandler` rule as well.
   */
  mcpTransport: "speaks the MCP and OAuth wire formats, not this envelope",
  /**
   * A clinician share link, authenticated by the URL credential itself. The
   * audience is a person who was sent a link, and the whole point is that they
   * need nothing else — no account, no token, and no contract to read.
   */
  shareLink:
    "authenticated by the URL credential, for a recipient with no account",
  /**
   * A discovery document whose format belongs to somebody else: Apple's
   * associated-domains file, and the two OAuth metadata documents. Their shape
   * is fixed by an external specification, so restating it here would create a
   * second source of truth that can only be wrong.
   */
  wellKnown: "format fixed by an external specification",
} as const;

type ExemptionKind = keyof typeof REASONS;

interface Exemption {
  kind: ExemptionKind;
  /** The verbs this exemption covers. Any other verb must be published. */
  methods: readonly HttpMethod[];
}

/**
 * Routes that are deliberately not in the public contract.
 *
 * Keyed by path, listing the verbs the exemption covers, so a route that grows
 * a new verb has to justify it rather than inherit somebody else's reason.
 */
const UNPUBLISHED: Readonly<Record<string, Exemption>> = {
  "/api/admin/ai-quality": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/ai-settings": { kind: "adminConsole", methods: ["GET", "PUT"] },
  "/api/admin/app-logs": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/audit-log": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/audit-log/actions": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/backup/test": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/backups": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/backups/run": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/backups/upload": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/backups/{id}/download": {
    kind: "adminConsole",
    methods: ["GET"],
  },
  "/api/admin/backups/{id}/restore": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/backups/{id}/summary": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/central-codex": {
    kind: "adminConsole",
    methods: ["DELETE", "GET"],
  },
  "/api/admin/central-codex/device-poll": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/central-codex/device-start": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/data": { kind: "adminConsole", methods: ["DELETE"] },
  "/api/admin/drain-per-sample-cumulative": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/encryption/rotate": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/encryption/status": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/host-metrics": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/import-apple-health-export": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/monitoring/glitchtip-test": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/monitoring/umami-test": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/notifications/health": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/notifications/reminder-check": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/notifications/test": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/rollups/recompute": { kind: "adminConsole", methods: ["POST"] },
  "/api/admin/settings": { kind: "adminConsole", methods: ["GET", "PUT"] },
  "/api/admin/settings/assistant-flags": {
    kind: "adminConsole",
    methods: ["GET", "PUT"],
  },
  "/api/admin/settings/module-availability": {
    kind: "adminConsole",
    methods: ["GET", "PATCH"],
  },
  "/api/admin/settings/web-push-vapid/generate": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/status": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/tokens": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/users": { kind: "adminConsole", methods: ["GET"] },
  "/api/admin/users/{id}": { kind: "adminConsole", methods: ["PUT"] },
  "/api/admin/users/{id}/force-logout": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/admin/users/{id}/reset-password": {
    kind: "adminConsole",
    methods: ["POST"],
  },
  "/api/fitbit/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/google-health/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/nightscout/connect": { kind: "browserHandoff", methods: ["POST"] },
  "/api/oura/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/polar/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/strava/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/whoop/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/withings/connect": { kind: "browserHandoff", methods: ["GET"] },
  "/api/internal/deploy-webhook": {
    kind: "internalOps",
    methods: ["GET", "POST"],
  },
  "/api/internal/web-vitals": { kind: "internalOps", methods: ["POST"] },
  "/api/monitoring/csp-report": { kind: "internalOps", methods: ["POST"] },
  "/api/monitoring/glitchtip": { kind: "internalOps", methods: ["POST"] },
  "/api/monitoring/settings": { kind: "internalOps", methods: ["GET"] },
  "/api/monitoring/umami-script": { kind: "internalOps", methods: ["GET"] },
  "/api/send": { kind: "internalOps", methods: ["POST"] },
  "/api/mcp/oauth/authorize": {
    kind: "mcpTransport",
    methods: ["GET", "POST"],
  },
  "/api/mcp/oauth/register": { kind: "mcpTransport", methods: ["POST"] },
  "/api/mcp/oauth/token": { kind: "mcpTransport", methods: ["POST"] },
  "/mcp": { kind: "mcpTransport", methods: ["DELETE", "GET", "POST"] },
  "/api/auth/oidc/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/fitbit/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/google-health/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/oura/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/polar/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/strava/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/whoop/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/withings/callback": { kind: "oauthCallback", methods: ["GET"] },
  "/api/telegram/webhook": {
    kind: "providerWebhook",
    methods: ["GET", "POST"],
  },
  "/api/whoop/webhook/{token}": { kind: "providerWebhook", methods: ["POST"] },
  "/api/withings/webhook": {
    kind: "providerWebhook",
    methods: ["GET", "POST"],
  },
  "/api/withings/webhook/{token}": {
    kind: "providerWebhook",
    methods: ["GET", "POST"],
  },
  "/c/{token}/fhir": { kind: "shareLink", methods: ["GET"] },
  "/c/{token}/report.pdf": { kind: "shareLink", methods: ["GET"] },
  "/.well-known/apple-app-site-association": {
    kind: "wellKnown",
    methods: ["GET"],
  },
  "/.well-known/oauth-authorization-server": {
    kind: "wellKnown",
    methods: ["GET"],
  },
  "/.well-known/oauth-protected-resource": {
    kind: "wellKnown",
    methods: ["GET"],
  },
};

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** `src/app/api/foo/[id]/route.ts` → `/api/foo/{id}`. */
function toApiPath(file: string): string {
  return (
    "/" +
    relative("src/app", file)
      .replace(/\/route\.ts$/, "")
      .replace(/\[\.\.\.([A-Za-z0-9_$]+)\]/g, "{$1}")
      .replace(/\[([A-Za-z0-9_$]+)\]/g, "{$1}")
  );
}

function exportedMethods(source: string): HttpMethod[] {
  return HTTP_METHODS.filter((method) =>
    new RegExp(
      `export\\s+(?:async\\s+)?(?:function\\s+${method}\\b|const\\s+${method}\\b)`,
    ).test(source),
  );
}

/**
 * Every route module under `src/app`, dot-directories included.
 *
 * The two patterns are not redundant: `globSync("src/app/**")` does not descend
 * into `.well-known`, and a sweep that quietly skips it is exactly the failure
 * this project has already had once.
 */
function routeModules(): string[] {
  const found = new Set<string>([
    ...globSync("src/app/**/route.ts", { cwd: ROOT }),
    ...globSync("src/app/**/.*/**/route.ts", { cwd: ROOT }),
  ]);
  return [...found].sort();
}

interface DiskRoute {
  path: string;
  methods: HttpMethod[];
}

function routesOnDisk(): DiskRoute[] {
  const routes: DiskRoute[] = [];
  for (const file of routeModules()) {
    const methods = exportedMethods(stripComments(readFileSync(file, "utf8")));
    if (methods.length === 0) continue;
    routes.push({ path: toApiPath(file), methods });
  }
  return routes;
}

describe("every route is published or declared unpublished", () => {
  const disk = routesOnDisk();

  it("finds the route modules at all", () => {
    // A floor, not a count: the point is that an enumeration returning nothing
    // cannot read as "everything is covered". The number moves with the tree,
    // so it sits well below the real one.
    expect(
      disk.length,
      "the route sweep found almost nothing, which means the pattern is wrong rather than the tree empty",
    ).toBeGreaterThan(300);
  });

  it("no route verb is missing from the contract without a reason", () => {
    const table = openApiPaths as Record<string, Record<string, unknown>>;
    const undocumented: string[] = [];

    for (const { path, methods } of disk) {
      const exempt = UNPUBLISHED[path];
      const published = table[path] ?? {};
      for (const method of methods) {
        if (exempt?.methods.includes(method)) continue;
        if (method.toLowerCase() in published) continue;
        undocumented.push(`${method} ${path}`);
      }
    }

    expect(
      undocumented,
      "these routes answer requests and no client can read what they answer with",
    ).toEqual([]);
  });

  it("the exemption list names routes that exist", () => {
    const byPath = new Map(disk.map((route) => [route.path, route.methods]));
    const stale: string[] = [];

    for (const [path, exempt] of Object.entries(UNPUBLISHED)) {
      const methods = byPath.get(path);
      if (!methods) {
        stale.push(`${path} (no such route)`);
        continue;
      }
      for (const method of exempt.methods) {
        if (!methods.includes(method)) {
          stale.push(`${method} ${path} (route does not export it)`);
        }
      }
    }

    expect(
      stale,
      "an exemption for a route that is gone hides the next route that needs one",
    ).toEqual([]);
  });

  it("the contract does not publish a path that no route serves", () => {
    const byPath = new Set(disk.map((route) => route.path));
    const phantom = Object.keys(openApiPaths).filter(
      (path) => !byPath.has(path),
    );

    expect(
      phantom,
      "a published path with no route behind it is a promise the deployment cannot keep",
    ).toEqual([]);
  });
});
