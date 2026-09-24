import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/consent/receipts", () => ({
  AI_EXTRACTION_CONSENT_KIND: "ai_extraction",
  latestActiveReceipt: vi.fn(),
}));

import {
  ConsentRequiredError,
  assertConsentForChain,
  assertDocumentEgressConsent,
  assertExtractionConsentForChain,
  chainRequiresServerManagedConsent,
  hasActiveConsentForSurface,
  isExternalDocumentEgress,
} from "../consent-guard";
import { latestActiveReceipt } from "@/lib/consent/receipts";
import type { ProviderChainResolved } from "../provider-runner";
import type { ConsentKind } from "@/lib/validations/consent";

const mockedLatest = vi.mocked(latestActiveReceipt);

/** Minimal chain entry — the gate only inspects `providerType`. */
function entry(providerType: string): ProviderChainResolved {
  return {
    providerType: providerType as ProviderChainResolved["providerType"],
    instance: {
      type: providerType,
      generateCompletion: vi.fn(),
    } as unknown as ProviderChainResolved["instance"],
  };
}

/** A receipt stub — only presence/absence matters to the gate. */
const RECEIPT = { id: "r1" } as unknown as Awaited<
  ReturnType<typeof latestActiveReceipt>
>;

/**
 * Drive `latestActiveReceipt` from a set of kinds the user is granted.
 * Any kind in the set returns a receipt; everything else returns null.
 */
function grant(kinds: ConsentKind[]): void {
  const set = new Set(kinds);
  mockedLatest.mockImplementation(async (_userId: string, kind: ConsentKind) =>
    set.has(kind) ? RECEIPT : null,
  );
}

describe("chainRequiresServerManagedConsent", () => {
  it("is true only when the chain contains a server-managed (admin-openai) entry", () => {
    expect(chainRequiresServerManagedConsent([entry("admin-openai")])).toBe(
      true,
    );
    expect(
      chainRequiresServerManagedConsent([
        entry("openai"),
        entry("admin-openai"),
      ]),
    ).toBe(true);
  });

  it("is true for the operator-shared central Codex (admin-codex)", () => {
    expect(chainRequiresServerManagedConsent([entry("admin-codex")])).toBe(
      true,
    );
    expect(
      chainRequiresServerManagedConsent([entry("codex"), entry("admin-codex")]),
    ).toBe(true);
  });

  it("is false for pure BYOK / local / codex chains", () => {
    expect(chainRequiresServerManagedConsent([entry("openai")])).toBe(false);
    expect(chainRequiresServerManagedConsent([entry("anthropic")])).toBe(false);
    expect(chainRequiresServerManagedConsent([entry("local")])).toBe(false);
    expect(chainRequiresServerManagedConsent([entry("codex")])).toBe(false);
    expect(
      chainRequiresServerManagedConsent([entry("codex"), entry("local")]),
    ).toBe(false);
  });
});

describe("hasActiveConsentForSurface", () => {
  beforeEach(() => mockedLatest.mockReset());

  it("accepts the surface-specific kind for coach", async () => {
    grant(["ai_coach"]);
    expect(await hasActiveConsentForSurface("u1", "coach")).toBe(true);
  });

  it("accepts the surface-specific kind for insights", async () => {
    grant(["ai_insights_only"]);
    expect(await hasActiveConsentForSurface("u1", "insights")).toBe(true);
  });

  it("accepts the master ai_full grant for either surface", async () => {
    grant(["ai_full"]);
    expect(await hasActiveConsentForSurface("u1", "coach")).toBe(true);
    expect(await hasActiveConsentForSurface("u1", "insights")).toBe(true);
  });

  it("does NOT cross surfaces: insights-only does not satisfy coach", async () => {
    grant(["ai_insights_only"]);
    expect(await hasActiveConsentForSurface("u1", "coach")).toBe(false);
  });

  it("returns false when no receipt is on file", async () => {
    grant([]);
    expect(await hasActiveConsentForSurface("u1", "insights")).toBe(false);
  });
});

describe("assertConsentForChain", () => {
  beforeEach(() => mockedLatest.mockReset());

  it("throws ConsentRequiredError on a server-managed chain with no receipt", async () => {
    grant([]);
    await expect(
      assertConsentForChain({
        userId: "u1",
        chain: [entry("admin-openai")],
        surface: "insights",
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it("carries the locked errorCode for the iOS contract", async () => {
    grant([]);
    const err = await assertConsentForChain({
      userId: "u1",
      chain: [entry("admin-openai")],
      surface: "coach",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConsentRequiredError);
    expect((err as ConsentRequiredError).errorCode).toBe("consent.ai.required");
  });

  it("proceeds (no throw) on a server-managed chain WITH an active receipt", async () => {
    grant(["ai_coach"]);
    await expect(
      assertConsentForChain({
        userId: "u1",
        chain: [entry("admin-openai")],
        surface: "coach",
      }),
    ).resolves.toBeUndefined();
  });

  it("never reads consent and never throws for a pure BYOK chain", async () => {
    grant([]);
    await expect(
      assertConsentForChain({
        userId: "u1",
        chain: [entry("openai")],
        surface: "insights",
      }),
    ).resolves.toBeUndefined();
    expect(mockedLatest).not.toHaveBeenCalled();
  });

  it("never reads consent and never throws for a pure local chain", async () => {
    grant([]);
    await expect(
      assertConsentForChain({
        userId: "u1",
        chain: [entry("local")],
        surface: "insights",
      }),
    ).resolves.toBeUndefined();
    expect(mockedLatest).not.toHaveBeenCalled();
  });

  it("STILL gates a BYOK-primary chain that has an admin-openai fallback (fail-closed)", async () => {
    grant([]);
    await expect(
      assertConsentForChain({
        userId: "u1",
        chain: [entry("openai"), entry("admin-openai")],
        surface: "insights",
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });
});

describe("isExternalDocumentEgress", () => {
  it("treats only the self-hosted local provider as non-egress", () => {
    expect(isExternalDocumentEgress("local")).toBe(false);
  });

  it("treats every external provider as document egress", () => {
    for (const p of [
      "codex",
      "openai",
      "anthropic",
      "admin-openai",
      "admin-codex",
    ]) {
      expect(isExternalDocumentEgress(p)).toBe(true);
    }
  });
});

describe("assertDocumentEgressConsent", () => {
  beforeEach(() => {
    mockedLatest.mockReset();
  });

  it("never reads consent and never throws for a LOCAL document pick", async () => {
    grant([]);
    await expect(
      assertDocumentEgressConsent({ userId: "u1", providerType: "local" }),
    ).resolves.toBeUndefined();
    expect(mockedLatest).not.toHaveBeenCalled();
  });

  // The live gap the governance fix closes: codex was ungated for documents.
  it("REQUIRES a receipt to send a document to codex (the closed gap)", async () => {
    grant([]);
    await expect(
      assertDocumentEgressConsent({ userId: "u1", providerType: "codex" }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it("requires a receipt for BYOK document egress too (openai / anthropic)", async () => {
    grant([]);
    for (const p of ["openai", "anthropic", "admin-openai"]) {
      await expect(
        assertDocumentEgressConsent({ userId: "u1", providerType: p }),
      ).rejects.toBeInstanceOf(ConsentRequiredError);
    }
  });

  it("proceeds for an external pick with an active extraction receipt", async () => {
    grant(["ai_extraction"]);
    await expect(
      assertDocumentEgressConsent({ userId: "u1", providerType: "codex" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds for an external pick with the master ai_full receipt", async () => {
    grant(["ai_full"]);
    await expect(
      assertDocumentEgressConsent({ userId: "u1", providerType: "openai" }),
    ).resolves.toBeUndefined();
  });

  // K1: the analysis and the Coach consents no longer cover documents.
  it("refuses an external pick when only the analysis or Coach consent is active", async () => {
    for (const kinds of [
      ["ai_insights_only"],
      ["ai_coach"],
    ] as ConsentKind[][]) {
      grant(kinds);
      await expect(
        assertDocumentEgressConsent({ userId: "u1", providerType: "codex" }),
      ).rejects.toBeInstanceOf(ConsentRequiredError);
    }
  });

  it("names the extraction group on the refusal", async () => {
    grant([]);
    await expect(
      assertDocumentEgressConsent({ userId: "u1", providerType: "codex" }),
    ).rejects.toMatchObject({ surface: "extraction" });
  });
});

describe("extraction consent does not satisfy the other groups", () => {
  it("an ai_extraction receipt alone satisfies neither the Coach nor the analysis", async () => {
    grant(["ai_extraction"]);
    await expect(hasActiveConsentForSurface("u1", "coach")).resolves.toBe(
      false,
    );
    await expect(hasActiveConsentForSurface("u1", "insights")).resolves.toBe(
      false,
    );
    await expect(hasActiveConsentForSurface("u1", "extraction")).resolves.toBe(
      true,
    );
  });
});

describe("assertExtractionConsentForChain (lab report scans)", () => {
  beforeEach(() => mockedLatest.mockReset());

  it("is a no-op for a chain of local entries only", async () => {
    grant([]);
    await expect(
      assertExtractionConsentForChain({
        userId: "u1",
        chain: [entry("local")],
      }),
    ).resolves.toBeUndefined();
    expect(mockedLatest).not.toHaveBeenCalled();
  });

  it("requires an extraction receipt for a BYOK chain, unlike the self-snapshot rule", async () => {
    grant([]);
    await expect(
      assertExtractionConsentForChain({
        userId: "u1",
        chain: [entry("local"), entry("anthropic")],
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    // The self-snapshot rule would have admitted the same chain.
    await expect(
      assertConsentForChain({
        userId: "u1",
        chain: [entry("anthropic")],
        surface: "insights",
      }),
    ).resolves.toBeUndefined();
  });

  it("admits the chain with an extraction receipt", async () => {
    grant(["ai_extraction"]);
    await expect(
      assertExtractionConsentForChain({
        userId: "u1",
        chain: [entry("openai")],
      }),
    ).resolves.toBeUndefined();
  });
});
