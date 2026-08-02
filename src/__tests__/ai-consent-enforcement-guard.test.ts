/**
 * Structural guard on the AI consent boundary.
 *
 * Two surfaces shipped without a consent check — the self-context clarifying
 * questions and the AI-composed proactive nudge — for the same reason: nothing
 * connected "I am holding a live provider instance" to "I must have checked a
 * receipt first". Behavioural tests close the two we found. This closes the
 * class, so the third one cannot appear quietly.
 *
 * The invariant: a module that resolves a provider INSTANCE for a user
 * (`resolveProvider` / `resolveProviderChain` / `resolveProviderForTest`) holds
 * something it can call `generateCompletion` on. Every such module must also
 * pull in a consent helper — or sit on the allowlist below with a written
 * reason a reviewer signed off.
 *
 * WHAT THIS CANNOT PROVE — read this before trusting it:
 *
 *   - It is an IMPORT-level check. It proves a consent helper is in the
 *     module's scope, NOT that the gate is reached on every path through the
 *     file. A module could import `hasActiveConsentForSurface`, call it on one
 *     branch, and egress ungated on another; this guard stays green.
 *   - It cannot prove ORDER. A gate called after the provider call, or after
 *     the snapshot is built, passes here and is still wrong.
 *   - It cannot prove the SURFACE is right. Passing `"insights"` where the data
 *     is a Coach snapshot passes here.
 *   - It cannot prove an allowlist entry is HONEST. A reviewer who waves
 *     through a new entry with a plausible-sounding reason defeats it entirely.
 *     The allowlist is a review checkpoint, not a proof.
 *
 * What it does buy: a NEW ungated provider call site cannot land silently. The
 * author must either wire a consent helper or edit this file, and editing this
 * file puts the decision in front of a reviewer. That is the whole claim.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";

const SRC = join(process.cwd(), "src");

/** Every non-test `.ts` / `.tsx` under `src/`, minus the generated client. */
function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((p) => !p.startsWith("generated/"))
    .filter((p) => !p.includes("__tests__"))
    .filter((p) => !p.endsWith(".test.ts") && !p.endsWith(".test.tsx"))
    .sort();
}

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

/**
 * The helpers that hand back a live, callable provider for a user. Deliberately
 * NOT including the presence-only probes (`hasAnyConfiguredProvider`,
 * `resolveProviderAvailability`, `userRowHasProviderCredential`): those never
 * decrypt a key or construct a client, so they cannot egress anything.
 */
const RESOLUTION_HELPERS = [
  "resolveProvider",
  "resolveProviderChain",
  "resolveProviderForTest",
] as const;

/** The two sanctioned consent APIs. Either satisfies the guard. */
const CONSENT_HELPERS = [
  // Chain-shaped: throw-form and predicate-form.
  "assertConsentForChain",
  "chainRequiresServerManagedConsent",
  "hasActiveConsentForSurface",
  // Document-class, pick-shaped.
  "assertDocumentEgressConsent",
  "isExternalDocumentEgress",
] as const;

/**
 * Extract the named bindings a file imports from a given module specifier.
 * Handles the multi-line `import { a, b } from "…"` form the codebase uses.
 * Comments mentioning a helper are NOT import statements and do not count —
 * that distinction is the whole point of parsing the import rather than
 * grepping the file.
 */
function importedNamesFrom(source: string, moduleSpecifier: string): string[] {
  const re = new RegExp(
    `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${moduleSpecifier.replace(
      /[/\\^$*+?.()|[\]{}]/g,
      "\\$&",
    )}["']`,
    "g",
  );
  const names: string[] = [];
  for (const match of source.matchAll(re)) {
    for (const raw of match[1].split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0];
      if (name) names.push(name.trim());
    }
  }
  return names;
}

function resolvesAProvider(source: string): boolean {
  const imported = importedNamesFrom(source, "@/lib/ai/provider");
  return RESOLUTION_HELPERS.some((h) => imported.includes(h));
}

function importsAConsentHelper(source: string): boolean {
  const imported = importedNamesFrom(source, "@/lib/ai/consent-guard");
  return CONSENT_HELPERS.some((h) => imported.includes(h));
}

/**
 * Modules that resolve a provider and deliberately carry no consent helper.
 * Every entry needs a reason that survives a reviewer asking "what PHI does
 * this send?" — the answer here is "none" in every case.
 *
 * `lib/ai/provider.ts` needs no entry: it DEFINES the resolution helpers rather
 * than importing them, so the detector never flags it. That is correct — the
 * resolver constructs clients and never sends a prompt, and gating it would
 * invert the layering.
 */
const ALLOWLIST: Record<string, string> = {
  // --- Capability / config probes: resolve a chain, never call it. ---
  "lib/labs/ocr-capability.ts":
    "Resolves the chain to REPORT which entry could do vision/text OCR (mode, reason, pdfSupported). Makes no completion call. Every consumer that then egresses a document is gated at its own call site with assertDocumentEgressConsent.",
  "app/api/insights/provider-chain/route.ts":
    "Lists the user's configured chain and which entry is active, for the settings UI. Constructs clients but never calls generateCompletion. No health data in the request or the response.",
  "app/api/insights/comprehensive/route.ts":
    "Uses the resolver only as a boolean probe ((await resolveProvider(userId)).type !== 'none') to set hasProvider on the response. The generation path itself lives in lib/insights/comprehensive-generate.ts, which is gated.",

  // --- Connection test: a real provider call, but with no user data. ---
  "app/api/ai/test/route.ts":
    "Sends a fixed synthetic prompt to verify credentials resolve and the endpoint answers. No health data is read, so there is no PHI egress for a receipt to authorise. Bounded by its own 5/min rate limit.",
};

describe("every provider-resolving module carries a consent helper", () => {
  const resolvers = sourceFiles().filter((rel) => resolvesAProvider(read(rel)));

  it("finds the provider-resolving modules at all (the guard is wired up)", () => {
    // A refactor that renames the resolver or moves the module would otherwise
    // silently empty the set and make every assertion below vacuous.
    expect(resolvers.length).toBeGreaterThanOrEqual(8);
    expect(resolvers).toContain("lib/ai/coach/self-context-questions.ts");
    expect(resolvers).toContain("lib/jobs/coach-nudge-ai.ts");
  });

  it("gates every provider-resolving module that is not explicitly allowlisted", () => {
    const ungated = resolvers.filter(
      (rel) => !importsAConsentHelper(read(rel)) && !(rel in ALLOWLIST),
    );
    expect(ungated).toEqual([]);
  });

  it("keeps the allowlist free of stale entries", () => {
    // An entry that no longer resolves a provider is dead weight that hides
    // the next real one. Delete it rather than letting it rot.
    const stale = Object.keys(ALLOWLIST).filter(
      (rel) => !resolvers.includes(rel),
    );
    expect(stale).toEqual([]);
  });

  it("requires a substantive reason on every allowlist entry", () => {
    const thin = Object.entries(ALLOWLIST)
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([rel]) => rel);
    expect(thin).toEqual([]);
  });
});

describe("the consent guard itself stays the single source of the policy", () => {
  it("keeps the server-managed provider set defined in exactly one place", () => {
    // Both operator-credential tags must be classified in consent-guard.ts and
    // nowhere else — a second copy of this list is how the policy drifts.
    const guard = read("lib/ai/consent-guard.ts");
    expect(guard).toContain('"admin-openai"');
    expect(guard).toContain('"admin-codex"');

    const copies = sourceFiles().filter(
      (rel) =>
        rel !== "lib/ai/consent-guard.ts" &&
        /SERVER_MANAGED_PROVIDER_TYPES/.test(read(rel)),
    );
    expect(copies).toEqual([]);
  });
});
