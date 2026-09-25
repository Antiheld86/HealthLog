import { describe, expect, it, vi } from "vitest";

import {
  documentOptionsWithSuggestions,
  isNearAnchor,
  type VaultDocument,
} from "../vault-document-options";

function doc(
  id: string,
  documentDate: string | null,
  extra: Partial<VaultDocument> = {},
): VaultDocument {
  return {
    id,
    title: `Doc ${id}`,
    filename: null,
    documentDate,
    reportDate: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    ...extra,
  };
}

const LABELS = {
  suggested: "Suggested",
  month: (iso: string) => iso.slice(0, 7),
  date: (iso: string) => iso.slice(0, 10),
};

describe("isNearAnchor", () => {
  const anchor = "2026-05-10T00:00:00.000Z";
  it("is inclusive at seven days either side", () => {
    expect(isNearAnchor("2026-05-03", anchor)).toBe(true);
    expect(isNearAnchor("2026-05-17", anchor)).toBe(true);
    expect(isNearAnchor("2026-05-02", anchor)).toBe(false);
    expect(isNearAnchor("2026-05-18", anchor)).toBe(false);
  });
  it("never matches without an anchor or a date", () => {
    expect(isNearAnchor(null, anchor)).toBe(false);
    expect(isNearAnchor("2026-05-10", null)).toBe(false);
  });
});

describe("documentOptionsWithSuggestions", () => {
  it("offers the WHOLE vault, not only the documents near the record's date", () => {
    // A childhood record dated years before the dose it also covers is the
    // case the old picker could not reach.
    const options = documentOptionsWithSuggestions(
      [doc("near", "2026-05-12"), doc("old", "1991-03-01")],
      "2026-05-10T00:00:00.000Z",
      LABELS,
    );
    expect(options.map((o) => o.id)).toEqual(["near", "old"]);
  });

  it("puts the documents within the window on top under one suggestion group", () => {
    const options = documentOptionsWithSuggestions(
      [
        doc("recent", "2026-09-01"),
        doc("near", "2026-05-12"),
        doc("old", "1991-03-01"),
      ],
      "2026-05-10T00:00:00.000Z",
      LABELS,
    );
    expect(options[0]).toMatchObject({
      id: "near",
      group: { key: "suggested", label: "Suggested" },
    });
    expect(options.slice(1).map((o) => o.id)).toEqual(["recent", "old"]);
    expect(options[1]!.group).toEqual({ key: "2026-09", label: "2026-09" });
  });

  it("reads a report date when the filing date is missing", () => {
    const options = documentOptionsWithSuggestions(
      [doc("lab", null, { reportDate: "2026-05-09" })],
      "2026-05-10T00:00:00.000Z",
      LABELS,
    );
    expect(options[0]!.group?.key).toBe("suggested");
  });

  it("without an anchor keeps the plain month grouping", () => {
    const options = documentOptionsWithSuggestions(
      [doc("a", "2026-05-12")],
      null,
      LABELS,
    );
    expect(options[0]!.group?.key).toBe("2026-05");
  });
});

describe("fetchWholeVault", () => {
  it("asks only for pages the list route accepts, and walks every cursor", async () => {
    const { documentListQuerySchema } =
      await import("@/lib/validations/inbound-documents");
    const apiFetch = await import("@/lib/api/api-fetch");
    const urls: string[] = [];
    const pages = [
      { documents: [doc("a", "2026-05-01")], nextCursor: "a" },
      { documents: [doc("b", "1991-03-01")], nextCursor: null },
    ];
    const spy = vi
      .spyOn(apiFetch, "apiGet")
      .mockImplementation(async (url: string) => {
        urls.push(url);
        return pages.shift() as never;
      });
    try {
      const { fetchWholeVault } = await import("../vault-document-options");
      const documents = await fetchWholeVault();
      expect(documents.map((d) => d.id)).toEqual(["a", "b"]);
      expect(urls).toHaveLength(2);
      for (const url of urls) {
        // The route parses its query with this schema and answers a 422 to
        // anything it refuses; the picker used to read that 422 as an empty
        // vault.
        const params = Object.fromEntries(
          new URL(url, "http://local").searchParams,
        );
        expect(documentListQuerySchema.safeParse(params).success).toBe(true);
      }
      expect(urls[1]).toContain("cursor=a");
    } finally {
      spy.mockRestore();
    }
  });
});
