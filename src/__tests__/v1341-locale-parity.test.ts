import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../..");
const LOCALES = ["en", "de", "es", "fr", "it", "pl", "ko"] as const;

const REQUIRED_KEYS = [
  // Security: adding a passkey now requires an existing sign-in factor.
  "settings.passkeyReauth.title",
  "settings.passkeyReauth.description",
  "settings.passkeyReauth.methodLabel",
  "settings.passkeyReauth.methods.password",
  "settings.passkeyReauth.methods.totp",
  "settings.passkeyReauth.methods.passkey",
  "settings.passkeyReauth.methods.webauthn",
  "settings.passkeyReauth.currentPassword",
  "settings.passkeyReauth.authenticatorCode",
  "settings.passkeyReauth.authenticatorPlaceholder",
  "settings.passkeyReauth.verifyAndAdd",
  // Integrations/imports: operator policy and Apple ECG terminal outcome.
  "settings.nightscoutPrivateOperatorTitle",
  "settings.nightscoutPrivateOperatorDescription",
  "settings.sections.export.import.appleHealth.ecgResult",
  // Existing terminal contracts reused by the final v1.34.1 call sites.
  "insights.assessmentPreparing",
  "insights.noAnalysisYet",
  "insights.noProviderConfigured",
  "insights.noProviderAction",
  "common.loadFailed",
  "common.networkError",
  "settings.googleHealthSyncResult",
  "settings.googleHealthSyncFailed",
  "settings.googleHealthBackfillInProgress",
  "settings.syncOutcome.empty",
  "settings.syncOutcome.partial",
  "settings.syncOutcome.failed",
  // Retained score, records, and navigation contracts.
  // `insights.healthScore.method` was listed obsolete in v1.34.1 because its
  // only reference was `METRIC_PROVENANCE.HEALTH_SCORE.methodKey`, which the
  // card then passed as `method={null}` — a dangling reference, not a dead
  // one. The score card now renders that method paragraph in its disclosure
  // footer, so the key is a live contract again.
  "insights.healthScore.method",
  "insights.healthScore.bandSetter",
  "insights.healthScore.versionAndNoise",
  "insights.healthScore.methodVersion",
  "insights.healthScore.source",
  "records.profileFacts.save",
  "records.allergies.add",
  "records.allergies.addFirst",
  "records.family.add",
  "records.family.addFirst",
  "admin.shell.sectionsNav",
  "settings.shell.sectionsNav",
] as const;

const OBSOLETE_KEYS = [
  "insights.healthScore.algorithmChanged",
  "insights.healthScore.dismissAlgorithmChanged",
  "insights.healthScore.composition",
  "documents.detail.summary.regenerate",
  "records.profileFacts.correct",
  "settings.nightscoutPrivateHost",
  "settings.nightscoutPrivateHostHelp",
] as const;

const NEW_CALL_SITES = {
  "src/components/settings/security-section/passkey-list-section.tsx": [
    "settings.passkeyReauth.title",
    "settings.passkeyReauth.description",
    "settings.passkeyReauth.methodLabel",
    "settings.passkeyReauth.methods.password",
    "settings.passkeyReauth.methods.totp",
    "settings.passkeyReauth.methods.passkey",
    "settings.passkeyReauth.methods.webauthn",
    "settings.passkeyReauth.currentPassword",
    "settings.passkeyReauth.authenticatorCode",
    "settings.passkeyReauth.authenticatorPlaceholder",
    "settings.passkeyReauth.verifyAndAdd",
  ],
  "src/components/settings/integrations/nightscout-card.tsx": [
    "settings.nightscoutPrivateOperatorTitle",
    "settings.nightscoutPrivateOperatorDescription",
  ],
  "src/components/settings/import-panel/apple-health-import-card.tsx": [
    "settings.sections.export.import.appleHealth.ecgResult",
  ],
} as const;

type Catalog = Record<string, unknown>;

function readCatalog(locale: (typeof LOCALES)[number]): Catalog {
  return JSON.parse(
    readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8"),
  ) as Catalog;
}

function resolveLeaf(catalog: Catalog, dottedKey: string): string | undefined {
  let value: unknown = catalog;
  for (const segment of dottedKey.split(".")) {
    if (typeof value !== "object" || value === null || !(segment in value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" ? value : undefined;
}

function placeholders(message: string): string[] {
  return [
    ...new Set(
      [...message.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\b/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

describe("v1.34.1 locale reconciliation", () => {
  it("wires every newly introduced user-facing state through a literal t() call", () => {
    for (const [relativePath, keys] of Object.entries(NEW_CALL_SITES)) {
      const source = readFileSync(join(ROOT, relativePath), "utf8");
      for (const key of keys) {
        expect(source, `${relativePath} must translate ${key}`).toMatch(
          new RegExp(`\\bt\\(\\s*["']${key.replaceAll(".", "\\.")}["']`),
        );
      }
    }
  });

  it("provides every final contract in all six locales with ICU parity", () => {
    const catalogs = Object.fromEntries(
      LOCALES.map((locale) => [locale, readCatalog(locale)]),
    ) as Record<(typeof LOCALES)[number], Catalog>;

    for (const key of REQUIRED_KEYS) {
      const english = resolveLeaf(catalogs.en, key);
      expect(english, `messages/en.json is missing ${key}`).toBeTruthy();

      for (const locale of LOCALES) {
        const translated = resolveLeaf(catalogs[locale], key);
        expect(
          translated,
          `messages/${locale}.json is missing ${key}`,
        ).toBeTruthy();
        expect(
          placeholders(translated ?? ""),
          `messages/${locale}.json changed ICU placeholders for ${key}`,
        ).toEqual(placeholders(english ?? ""));
      }
    }
  });

  it("removes only the v1.34.1 copy proven obsolete after final call-site inventory", () => {
    for (const locale of LOCALES) {
      const catalog = readCatalog(locale);
      for (const key of OBSOLETE_KEYS) {
        expect(
          resolveLeaf(catalog, key),
          `messages/${locale}.json still contains obsolete ${key}`,
        ).toBeUndefined();
      }
    }

    const productionSource = Object.keys(NEW_CALL_SITES)
      .map((relativePath) => readFileSync(join(ROOT, relativePath), "utf8"))
      .join("\n");
    for (const key of OBSOLETE_KEYS) {
      expect(productionSource).not.toContain(`t("${key}")`);
      expect(productionSource).not.toContain(`t('${key}')`);
    }
  });
});
