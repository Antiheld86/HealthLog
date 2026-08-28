/**
 * Every assistant switch an operator can flip has to move something.
 *
 * `healthScoreExplainer` did not. It gated a caption beside the
 * Health-Score delta; the caption's component went when the health
 * score was replaced by the reference composite, and the "?" control
 * the admin description still named had been retired a release before
 * that. The toggle stayed on the admin panel, in the flag matrix and in
 * the API contract for two releases, so an operator could turn it off,
 * be told it saved, and change nothing at all. A switch that lies is
 * worse than no switch.
 *
 * Two guards, one point. The first pins the removal so the flag cannot
 * drift back in pieces. The second is the general rule the removal came
 * from: no sub-flag is allowed to exist without a surface that reads it.
 * Plumbing does not count — the admin panel, the resolver, the hook and
 * the two routes carry every flag by construction, so a dead one would
 * look alive if they were allowed to vouch for it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ASSISTANT_FLAGS_DEFAULT,
  resolveAssistantFlags,
} from "@/lib/feature-flags";

const ROOT = path.resolve(__dirname, "../../../..");
const LOCALES = ["de", "en", "es", "fr", "it", "pl", "ko"] as const;

/** Names the retired switch went by, on the wire and in the database. */
const RETIRED_NAMES = [
  "healthScoreExplainer",
  "assistantHealthScoreExplainerEnabled",
  "assistant_health_score_explainer_enabled",
];

/**
 * The files that carry every flag whatever it does: the operator panel
 * that offers the switch, the resolver and hook that shape the matrix,
 * and the two routes that read and write it. None of them is evidence
 * that a flag gates anything.
 */
const PLUMBING = [
  "src/lib/feature-flags/index.ts",
  "src/hooks/use-feature-flags.ts",
  "src/components/admin/assistant-section.tsx",
  "src/app/api/feature-flags/route.ts",
  "src/app/api/admin/settings/assistant-flags/route.ts",
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

describe("the Health-Score explainer switch stays removed", () => {
  it("is absent from the resolved flag matrix, master on and master off", () => {
    const on = resolveAssistantFlags({ ...ASSISTANT_FLAGS_DEFAULT });
    const off = resolveAssistantFlags({
      ...ASSISTANT_FLAGS_DEFAULT,
      enabled: false,
    });
    for (const shape of [ASSISTANT_FLAGS_DEFAULT, on, off]) {
      expect(Object.keys(shape)).not.toContain("healthScoreExplainer");
    }
  });

  it("declares no column on the Prisma schema", () => {
    const schema = readFileSync(
      path.join(ROOT, "prisma/schema.prisma"),
      "utf8",
    );
    for (const name of RETIRED_NAMES) {
      expect(schema, `${name} is back on the schema`).not.toContain(name);
    }
  });

  it("carries no operator-panel wording in any locale", () => {
    for (const locale of LOCALES) {
      const bundle = JSON.parse(
        readFileSync(path.join(ROOT, `messages/${locale}.json`), "utf8"),
      ) as { admin: { assistant: Record<string, unknown> } };
      expect(
        Object.keys(bundle.admin.assistant),
        `${locale} still offers the switch`,
      ).not.toContain("healthScoreExplainer");
    }
  });

  it("ships the migration that dropped the column", () => {
    const sql = readFileSync(
      path.join(
        ROOT,
        "prisma/migrations/0288_drop_health_score_explainer_flag/migration.sql",
      ),
      "utf8",
    );
    expect(sql).toContain("assistant_health_score_explainer_enabled");
    expect(sql).toContain("DROP COLUMN");
  });
});

describe("no assistant sub-flag is a dead switch", () => {
  it("finds a surface that reads every flag the operator can turn off", () => {
    const plumbing = new Set(PLUMBING.map((rel) => path.join(ROOT, rel)));
    const sources = sourceFiles(path.join(ROOT, "src")).filter(
      (file) => !plumbing.has(file),
    );
    const corpus = sources.map((file) => readFileSync(file, "utf8")).join("\n");

    const subFlags = Object.keys(ASSISTANT_FLAGS_DEFAULT).filter(
      (flag) => flag !== "enabled",
    );
    expect(subFlags.length).toBeGreaterThan(0);

    for (const flag of subFlags) {
      const gatedOnTheServer = corpus.includes(
        `requireAssistantSurface("${flag}")`,
      );
      const readOnTheClient = new RegExp(`flags\\.${flag}\\b`).test(corpus);
      expect(
        gatedOnTheServer || readOnTheClient,
        `the "${flag}" switch gates nothing — wire it to a surface or remove it`,
      ).toBe(true);
    }
  });
});
