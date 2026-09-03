import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Webhook verb rate-limit guard.
 *
 * The project rule for an inbound webhook is: per-source rate limit BEFORE
 * secret verification. The reason is not throughput, it is the oracle. A
 * secret comparison that answers 200 against 401 tells the caller whether it
 * guessed right; constant-time comparison hides the timing channel but not the
 * status code, so the only thing standing between a wrong guess and the next
 * one is the limiter. An unlimited verb is a free guessing machine and a free
 * load channel.
 *
 * The rule was applied per HANDLER rather than per FILE, which is how it drifted:
 * both Withings entrypoints, the Telegram bot webhook and the Coolify deploy
 * hook limited POST and left the verification verbs (GET / HEAD, the URL
 * reachability probes every webhook UI sends) comparing the same secret with
 * nothing in front of them. Reviewing the POST proved nothing about the sibling
 * export three lines below it.
 *
 * So this guard reasons about EVERY exported verb, not about files:
 *
 *   1. Discover the webhook routes from the filesystem — every `route.ts`
 *      under `src/app/api` whose path names a webhook, plus the explicitly
 *      listed unauthenticated inbound endpoints below.
 *   2. Resolve which local helpers reach a constant-time secret comparison and
 *      which reach the rate limiter, transitively, so a verb that delegates
 *      (`verifyTokenSegment`, `hasValidSecret`, `checkAndWarn`) is judged on
 *      what the helper does rather than on the call's spelling.
 *   3. For every exported verb that reaches a comparison, require that it also
 *      reaches the limiter and reaches it FIRST.
 *
 * A verb that compares no secret is not the subject here and is skipped — the
 * CSP report endpoint is the example: nothing to guess, and it rate-limits
 * anyway. A verb that never gets exported cannot be reached, which is why
 * WHOOP passes trivially: it exports POST only.
 *
 * LIMIT, stated so nobody reads more into a green run than it earns: this is a
 * source-text guard. It proves the limiter call precedes the comparison call in
 * the handler body; it does not prove the limiter and the POST share a bucket,
 * and a comparison moved into an imported module (rather than a local helper)
 * would fall outside the transitive resolution below. The per-route tests are
 * what prove the refusal.
 */

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const API_ROOT = "src/app/api";

/**
 * Inbound endpoints that are webhooks by behaviour but not by path. Listed
 * explicitly so the discovery below is not silently narrower than the class it
 * claims to cover.
 */
const EXTRA_WEBHOOK_ROUTES: ReadonlyArray<string> = [
  // Browser-posted CSP violation reports. Unauthenticated by design (the
  // browser cannot carry a secret), rate-limited, no comparison to shield.
  "src/app/api/monitoring/csp-report/route.ts",
];

/** The HTTP verbs Next.js recognises as route handlers. */
const HTTP_VERBS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/** A constant-time secret comparison, however it is spelled. */
const COMPARISON_NEEDLES = [
  "timingSafeEqual(",
  "timingSafeStringEqual(",
] as const;

/** The per-source rate limiter, direct or through the shared webhook helper. */
const LIMITER_NEEDLES = [
  "checkRateLimit(",
  "checkAuthSurfaceRateLimit(",
  "applyWebhookRateLimit(",
] as const;

/** Drop whole-line comments so a docstring mentioning a helper is not a call. */
function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("//") ||
        trimmed.startsWith("*") ||
        trimmed.startsWith("/*")
      ) {
        return "";
      }
      return line;
    })
    .join("\n");
}

/** Index of the earliest needle in `text`, or -1 when none appears. */
function firstIndexOfAny(text: string, needles: ReadonlyArray<string>): number {
  let best = -1;
  for (const needle of needles) {
    const at = text.indexOf(needle);
    if (at === -1) continue;
    if (best === -1 || at < best) best = at;
  }
  return best;
}

/** Every `route.ts` under `src/app/api`, as repo-relative POSIX paths. */
function findRouteFiles(): string[] {
  const hits: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__" || entry === "node_modules") continue;
        walk(full);
        continue;
      }
      if (entry !== "route.ts") continue;
      hits.push(relative(repoRoot, full).split(/[\\/]/).join("/"));
    }
  }

  walk(resolve(repoRoot, API_ROOT));
  return hits.sort();
}

function findWebhookRoutes(): string[] {
  const byPath = findRouteFiles().filter((p) =>
    p.toLowerCase().includes("webhook"),
  );
  return [...new Set([...byPath, ...EXTRA_WEBHOOK_ROUTES])].sort();
}

/**
 * Split a module into its top-level declarations. Crude on purpose: a
 * declaration runs from its own `const`/`function`/`export` keyword at column
 * zero to the next one. Good enough to attribute a call to the handler or the
 * helper that contains it.
 */
function topLevelBlocks(text: string): Array<{ name: string; body: string }> {
  const starts: Array<{ name: string; at: number }> = [];
  const re =
    /^(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z0-9_$]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    starts.push({ name: m[1], at: m.index });
  }
  return starts.map((s, i) => ({
    name: s.name,
    body: text.slice(
      s.at,
      i + 1 < starts.length ? starts[i + 1].at : undefined,
    ),
  }));
}

/**
 * The local helper names that transitively reach one of `needles`. Two passes
 * over the declaration list resolve one level of delegation
 * (`checkAndWarn` → `hasValidWebhookSecret` → `timingSafeStringEqual`), which
 * is the depth the webhook routes actually use; a third pass changes nothing
 * today and would be the place to grow if a route nests deeper.
 */
function helpersReaching(
  blocks: ReadonlyArray<{ name: string; body: string }>,
  needles: ReadonlyArray<string>,
): Set<string> {
  const reaching = new Set<string>();
  for (let pass = 0; pass < 4; pass += 1) {
    let grew = false;
    for (const block of blocks) {
      if (reaching.has(block.name)) continue;
      const direct = firstIndexOfAny(block.body, needles) !== -1;
      const viaHelper = [...reaching].some((h) => block.body.includes(`${h}(`));
      if (direct || viaHelper) {
        reaching.add(block.name);
        grew = true;
      }
    }
    if (!grew) break;
  }
  return reaching;
}

interface VerbVerdict {
  path: string;
  verb: string;
  comparisonAt: number;
  limiterAt: number;
}

function analyseRoute(path: string): VerbVerdict[] {
  const text = stripCommentLines(readFileSync(resolve(repoRoot, path), "utf8"));
  const blocks = topLevelBlocks(text);

  const comparisonHelpers = helpersReaching(blocks, COMPARISON_NEEDLES);
  const limiterHelpers = helpersReaching(blocks, LIMITER_NEEDLES);

  const verdicts: VerbVerdict[] = [];
  for (const block of blocks) {
    if (!HTTP_VERBS.includes(block.name as (typeof HTTP_VERBS)[number])) {
      continue;
    }
    if (!new RegExp(`^export\\s+const\\s+${block.name}\\b`).test(block.body)) {
      continue;
    }

    const comparisonAt = firstIndexOfAny(block.body, [
      ...COMPARISON_NEEDLES,
      ...[...comparisonHelpers]
        .filter((h) => h !== block.name)
        .map((h) => `${h}(`),
    ]);
    if (comparisonAt === -1) continue;

    const limiterAt = firstIndexOfAny(block.body, [
      ...LIMITER_NEEDLES,
      ...[...limiterHelpers]
        .filter((h) => h !== block.name)
        .map((h) => `${h}(`),
    ]);

    verdicts.push({ path, verb: block.name, comparisonAt, limiterAt });
  }
  return verdicts;
}

describe("webhook verb rate-limit guard", () => {
  const routes = findWebhookRoutes();
  const verdicts = routes.flatMap(analyseRoute);

  it("finds the webhook routes it claims to judge", () => {
    // An empty match set is the failure mode this project has already been
    // bitten by: a guard that matches nothing is green because it looked at
    // nothing. Both counts are floors, not inventories.
    expect(routes.length).toBeGreaterThanOrEqual(5);
    expect(
      routes,
      "the Withings path-segment webhook must be in the scanned set",
    ).toContain("src/app/api/withings/webhook/[token]/route.ts");
    expect(routes).toContain("src/app/api/telegram/webhook/route.ts");
    expect(routes).toContain("src/app/api/internal/deploy-webhook/route.ts");
  });

  it("recognises the verbs that compare a secret", () => {
    expect(
      verdicts.length,
      "no secret-comparing webhook verb was recognised — the matchers have " +
        "drifted away from the code they are supposed to judge",
    ).toBeGreaterThanOrEqual(8);
  });

  it("every secret-comparing verb rate-limits before it compares", () => {
    const offenders = verdicts
      .filter((v) => v.limiterAt === -1 || v.limiterAt > v.comparisonAt)
      .map((v) =>
        v.limiterAt === -1
          ? `  - ${v.path} → ${v.verb}: compares the secret with no rate limit at all`
          : `  - ${v.path} → ${v.verb}: rate limit runs AFTER the comparison`,
      );

    expect(
      offenders,
      [
        "Webhook verbs that compare a shared secret without a rate limit in front:",
        ...offenders,
        "",
        "A 200-against-401 answer is an oracle. Constant-time comparison hides",
        "the timing channel, not the status code — the limiter is what makes",
        "guessing expensive. Apply the same per-source limit the POST uses,",
        "on the same bucket, before the comparison.",
      ].join("\n"),
    ).toEqual([]);
  });
});
