/**
 * v1.37.20 — the query-time synonym expansion behind document search.
 *
 * Watched red: the cross-register assertion below ("blutdruck" query hash
 * set overlaps a "blood pressure" document's token set) fails against the
 * pre-expansion `hashQueryTokens`, which hashed only the typed tokens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({
  // Deterministic fake subkey — the HMAC itself is irrelevant here; only
  // that query and index hashing agree.
  deriveSubkey: vi.fn(() => Buffer.alloc(32, 7)),
}));

import {
  expandQueryTokens,
  MAX_EXPANDED_QUERY_TOKENS,
  SEARCH_SYNONYM_GROUPS,
} from "../search-synonyms";
import { hashQueryTokens, tokenise, tokeniseAndHash } from "../content-index";

describe("the curated groups", () => {
  it("are all in tokeniser normal form (lowercase, no diacritics, length-gated)", () => {
    for (const group of SEARCH_SYNONYM_GROUPS) {
      for (const token of group) {
        // Round-tripping through the real tokeniser must return the token
        // unchanged — otherwise it could never match an indexed tag.
        expect(tokenise(token), token).toEqual([token]);
      }
    }
  });

  it("hold at least two members each (a group of one expands nothing)", () => {
    for (const group of SEARCH_SYNONYM_GROUPS) {
      expect(group.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("expandQueryTokens", () => {
  it("keeps the typed tokens first and appends the group members", () => {
    const out = expandQueryTokens(["blutdruck"]);
    expect(out[0]).toBe("blutdruck");
    expect(out).toContain("blood");
    expect(out).toContain("pressure");
    expect(out).toContain("hypertension");
  });

  it("passes an unknown token through untouched", () => {
    expect(expandQueryTokens(["zeruwatvz"])).toEqual(["zeruwatvz"]);
  });

  it("caps the expanded set without ever trimming typed tokens", () => {
    const typed = SEARCH_SYNONYM_GROUPS.slice(0, 24).map((g) => g[0]);
    const out = expandQueryTokens(typed);
    expect(out.length).toBeLessThanOrEqual(MAX_EXPANDED_QUERY_TOKENS);
    for (const token of typed) expect(out).toContain(token);
  });
});

describe("hashQueryTokens with expansion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets a German query match an English document (cross-register recall)", () => {
    const documentTags = tokeniseAndHash(
      "Blood pressure readings were stable throughout the stay",
    );
    const queryTags = hashQueryTokens("Blutdruck");
    expect(queryTags.some((tag) => documentTags.includes(tag))).toBe(true);
  });

  it("lets an English query match a German letter", () => {
    const documentTags = tokeniseAndHash(
      "Der Blutdruck war im Verlauf unauffaellig",
    );
    const queryTags = hashQueryTokens("hypertension");
    expect(queryTags.some((tag) => documentTags.includes(tag))).toBe(true);
  });

  it("still matches the typed word itself, expansion or not", () => {
    const documentTags = tokeniseAndHash("Koloskopie ohne Befund");
    const queryTags = hashQueryTokens("Koloskopie");
    expect(queryTags.some((tag) => documentTags.includes(tag))).toBe(true);
  });
});
