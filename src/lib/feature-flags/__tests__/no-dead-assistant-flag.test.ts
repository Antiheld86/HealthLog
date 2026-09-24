/**
 * Every assistant switch an operator can flip has to move something, a
 * switch that was retired stays retired, and the retired gate only shrinks.
 *
 * `healthScoreExplainer` did not move anything. It gated a caption beside the
 * Health-Score delta; the caption's component went when the health score was
 * replaced by the reference composite, and the toggle stayed on the admin
 * panel, in the flag matrix and in the API contract for two releases, so an
 * operator could turn it off, be told it saved, and change nothing at all.
 * `correlations` was the same shape one level down: it gated statistics, which
 * no model writes, so turning it off removed a computation and stopped no AI
 * work. A switch that lies is worse than no switch.
 *
 * Four guards:
 *
 *   1. The retired switches stay removed, in every place they lived.
 *   2. No sub-switch exists without a capability it covers, and none without a
 *      surface that reads it. Plumbing does not count: the admin panel, the
 *      loader, the hook and the two switch routes carry every switch by
 *      construction, so a dead one would look alive if they could vouch for
 *      it. A switch whose reader lands with the routes it covers is named in
 *      `AWAITING_READER` with the reason, and the entry fails the moment a
 *      reader appears, so it cannot outlive its reason.
 *   3. `requireAssistantSurface` is the retired gate. It answers only the
 *      operator layer; `requireAiCapability` answers every layer. The routes
 *      that still call it are frozen below, in both directions: a new caller
 *      fails, and a caller that moved to the capability gate fails until its
 *      entry is removed. When the list is empty the function and
 *      `AssistantDisabledError` are deleted and this guard asserts zero.
 *   4. The matchers find what they are meant to judge (non-zero counts), so a
 *      matcher that stopped matching cannot agree with an empty world.
 *
 * Mutation checks: adding `await requireAssistantSurface("coach")` to any
 * route outside the frozen list turns guard 3 red by file name; deleting the
 * `requireAiCapability("documentAi"` calls from the document routes (the only
 * reader of that switch's capabilities in the route tree) turns guard 2 red;
 * putting `assistantCorrelationsEnabled` back on the schema turns guard 1 red.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_FLAGS_DEFAULT,
  resolveAssistantFlags,
} from "@/lib/feature-flags";
import {
  AI_CAPABILITIES,
  AI_CAPABILITY_KEYS,
  AI_OPERATOR_SWITCHES,
} from "@/lib/ai/capabilities/types";

const ROOT = path.resolve(__dirname, "../../../..");
const LOCALES = ["de", "en", "es", "fr", "it", "pl", "ko"] as const;

interface RetiredSwitch {
  /** The wire name, also the admin copy key. */
  name: string;
  /** Names it went by on the schema and in the database. */
  columnNames: string[];
  /** The migration that dropped the column. */
  migration: string;
  column: string;
}

const RETIRED_SWITCHES: RetiredSwitch[] = [
  {
    name: "healthScoreExplainer",
    columnNames: [
      "assistantHealthScoreExplainerEnabled",
      "assistant_health_score_explainer_enabled",
    ],
    migration: "0288_drop_health_score_explainer_flag",
    column: "assistant_health_score_explainer_enabled",
  },
  {
    name: "correlations",
    columnNames: [
      "assistantCorrelationsEnabled",
      "assistant_correlations_enabled",
    ],
    migration: "0343_ai_capability_switches",
    column: "assistant_correlations_enabled",
  },
];

/**
 * The files that carry every switch whatever it does. None of them is
 * evidence that a switch gates anything.
 */
const PLUMBING = [
  "src/lib/feature-flags/index.ts",
  "src/hooks/use-feature-flags.ts",
  "src/components/admin/assistant-section.tsx",
  "src/app/api/feature-flags/route.ts",
  "src/app/api/admin/settings/assistant-flags/route.ts",
];

/**
 * Switches with no reader yet, and why that is correct for now. An entry is
 * a claim with an expiry: the test below fails as soon as a reader appears.
 */
const AWAITING_READER: Record<string, string> = {};

/**
 * Every file that still calls the retired gate. Only ever shrinks.
 */
const RETIRED_GATE_CALLERS = [
  "src/app/api/insights/biomarker-assessment/route.ts",
  "src/app/api/insights/blood-pressure-status/route.ts",
  "src/app/api/insights/bmi-status/route.ts",
  "src/app/api/insights/cards/route.ts",
  "src/app/api/insights/chat/[id]/route.ts",
  "src/app/api/insights/chat/messages/[id]/feedback/route.ts",
  "src/app/api/insights/chat/route.ts",
  "src/app/api/insights/coach-read/route.ts",
  "src/app/api/insights/coach/facts/[id]/route.ts",
  "src/app/api/insights/coach/facts/route.ts",
  "src/app/api/insights/coach/nudge-status/route.ts",
  "src/app/api/insights/coach/seeded-question/route.ts",
  "src/app/api/insights/coach/seen/route.ts",
  "src/app/api/insights/generate/route.ts",
  "src/app/api/insights/medication-compliance-status/route.ts",
  "src/app/api/insights/metric-status/route.ts",
  "src/app/api/insights/mood-status/route.ts",
  "src/app/api/insights/narrative/route.ts",
  "src/app/api/insights/pregenerate/route.ts",
  "src/app/api/insights/pulse-status/route.ts",
  "src/app/api/insights/weight-status/route.ts",
  "src/app/coach/page.tsx",
];

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "generated" || entry === "__tests__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/** Comment lines out, so prose naming a call is not read as one. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
}

const rel = (file: string) =>
  path.relative(ROOT, file).split(path.sep).join("/");

const SOURCES = sourceFiles(path.join(ROOT, "src"));

describe("retired switches stay removed", () => {
  for (const retired of RETIRED_SWITCHES) {
    describe(retired.name, () => {
      it("is absent from the resolved switch set, master on and master off", () => {
        const on = resolveAssistantFlags({ ...ASSISTANT_FLAGS_DEFAULT });
        const off = resolveAssistantFlags({
          ...ASSISTANT_FLAGS_DEFAULT,
          enabled: false,
        });
        for (const shape of [ASSISTANT_FLAGS_DEFAULT, on, off]) {
          expect(Object.keys(shape)).not.toContain(retired.name);
        }
      });

      it("declares no column on the Prisma schema", () => {
        const schema = readFileSync(
          path.join(ROOT, "prisma/schema.prisma"),
          "utf8",
        );
        for (const name of retired.columnNames) {
          expect(schema, `${name} is back on the schema`).not.toContain(name);
        }
      });

      it("is read and written nowhere in the source tree", () => {
        const readers = SOURCES.filter((file) =>
          retired.columnNames.some((name) => code(file).includes(name)),
        ).map(rel);
        expect(readers).toEqual([]);
      });

      it("carries no operator-panel wording in any locale", () => {
        for (const locale of LOCALES) {
          const bundle = JSON.parse(
            readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8"),
          ) as { admin: { assistant: Record<string, unknown> } };
          expect(
            Object.keys(bundle.admin.assistant),
            `${locale} still offers the switch`,
          ).not.toContain(retired.name);
        }
      });

      it("ships the migration that dropped the column", () => {
        const sql = readFileSync(
          path.join(
            ROOT,
            `prisma/migrations/${retired.migration}/migration.sql`,
          ),
          "utf8",
        );
        expect(sql).toContain(retired.column);
        expect(sql).toContain("DROP COLUMN");
      });
    });
  }
});

describe("no assistant sub-switch is a dead switch", () => {
  const subSwitches = Object.keys(ASSISTANT_FLAGS_DEFAULT).filter(
    (flag) => flag !== "enabled",
  );

  it("publishes exactly the switches the capability table knows", () => {
    expect([...subSwitches].sort()).toEqual([...AI_OPERATOR_SWITCHES].sort());
  });

  it("covers at least one capability with every switch", () => {
    for (const toggle of subSwitches) {
      const covered = AI_CAPABILITY_KEYS.filter(
        (key) => AI_CAPABILITIES[key].operatorSwitch === toggle,
      );
      expect(
        covered.length,
        `"${toggle}" covers no capability`,
      ).toBeGreaterThan(0);
    }
  });

  const plumbing = new Set(PLUMBING.map((file) => path.join(ROOT, file)));
  const corpus = SOURCES.filter((file) => !plumbing.has(file))
    .map(code)
    .join("\n");

  function hasReader(toggle: string): boolean {
    if (corpus.includes(`requireAssistantSurface("${toggle}")`)) return true;
    if (new RegExp(`flags\\.${toggle}\\b`).test(corpus)) return true;
    const capabilities = AI_CAPABILITY_KEYS.filter(
      (key) => AI_CAPABILITIES[key].operatorSwitch === toggle,
    );
    return capabilities.some((key) =>
      new RegExp(
        `(?:requireAiCapability|getAiCapability)\\(\\s*"${key}"|aiCapabilityForJob\\([^)]*"${key}"`,
      ).test(corpus),
    );
  }

  it("finds a surface that reads every switch the operator can turn off", () => {
    expect(subSwitches.length).toBeGreaterThan(0);
    for (const toggle of subSwitches) {
      if (toggle in AWAITING_READER) continue;
      expect(
        hasReader(toggle),
        `the "${toggle}" switch gates nothing — wire it to a surface or remove it`,
      ).toBe(true);
    }
  });

  it("drops an awaiting entry as soon as its switch has a reader", () => {
    for (const toggle of Object.keys(AWAITING_READER)) {
      expect(subSwitches, `${toggle} is not a switch`).toContain(toggle);
      expect(
        hasReader(toggle),
        `"${toggle}" has a reader now — remove it from AWAITING_READER`,
      ).toBe(false);
    }
  });
});

describe("the retired gate only shrinks", () => {
  const CALL = /(?:await|return|=)\s*requireAssistantSurface\s*\(/;
  const callers = SOURCES.filter(
    (file) =>
      rel(file) !== "src/lib/feature-flags/index.ts" && CALL.test(code(file)),
  )
    .map(rel)
    .sort();

  it("finds the callers it is meant to judge", () => {
    // A matcher that stopped matching would agree with an empty list.
    expect(callers.length).toBe(RETIRED_GATE_CALLERS.length);
  });

  it("gains no new caller", () => {
    const added = callers.filter(
      (file) => !RETIRED_GATE_CALLERS.includes(file),
    );
    expect(
      added,
      "a new route calls requireAssistantSurface; use requireAiCapability",
    ).toEqual([]);
  });

  it("forgets a caller once it has moved to the capability gate", () => {
    const moved = RETIRED_GATE_CALLERS.filter(
      (file) => !callers.includes(file),
    );
    expect(
      moved,
      "these no longer call requireAssistantSurface; remove them from the list",
    ).toEqual([]);
  });
});
