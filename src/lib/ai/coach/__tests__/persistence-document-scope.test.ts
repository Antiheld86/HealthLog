import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * v1.29.x (S7) — the Coach persistence readers over the join-table + sticky-flag
 * model. These pin:
 *   1. Ownership stays narrowed (`userId`) on every read — no scope relaxation
 *      ever widens ownership.
 *   2. The rail list omits the scope filter (a union of health + fenced threads),
 *      while the document sheet passes `attachedDocumentId` (a join-row filter).
 *   3. The tool-route SEND path passes `documentScoped: false` (fenced threads
 *      404 there); the fenced endpoint passes `documentScoped: true`.
 *   4. The DTO carries `fenced` + `attachments[]` (+ `documentTitle` = the first
 *      attachment's resolved title, filename fallback).
 */

const findMany = vi.fn();
const findFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    coachConversation: {
      findMany: (...args: unknown[]) => findMany(...args),
      findFirst: (...args: unknown[]) => findFirst(...args),
    },
  },
}));

vi.mock("../bytes-codec", () => ({
  encryptToBytes: vi.fn(),
  decryptFromBytes: vi.fn(() => "decrypted body"),
}));

import {
  fetchConversationWithMessages,
  listConversations,
} from "../persistence";

const now = new Date("2026-07-16T10:00:00.000Z");

function att(
  documentId: string,
  title: string | null,
  filename: string | null,
) {
  return { documentId, document: { title, filename } };
}

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset();
});

describe("listConversations — filter + DTO", () => {
  it("omits the scope filter (union of both) but keeps userId narrowed, and maps fenced + attachments", async () => {
    findMany.mockResolvedValue([
      {
        id: "c1",
        title: "Health thread",
        createdAt: now,
        updatedAt: now,
        documentScoped: false,
        _count: { messages: 3 },
        attachments: [],
      },
      {
        id: "c2",
        title: "Fenced thread",
        createdAt: now,
        updatedAt: now,
        documentScoped: true,
        _count: { messages: 2 },
        attachments: [att("doc-1", "Blood panel", "panel.pdf")],
      },
    ]);

    const page = await listConversations({ userId: "user-1" });

    const where = findMany.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    expect("attachments" in where).toBe(false);

    expect(page.conversations[0]).toMatchObject({
      id: "c1",
      fenced: false,
      documentTitle: null,
    });
    expect(page.conversations[0].attachments).toEqual([]);
    expect(page.conversations[1]).toMatchObject({
      id: "c2",
      fenced: true,
      documentTitle: "Blood panel",
    });
    expect(page.conversations[1].attachments).toEqual([
      { documentId: "doc-1", title: "Blood panel" },
    ]);
  });

  it("applies the join-row filter when the document sheet passes attachedDocumentId", async () => {
    findMany.mockResolvedValue([]);
    await listConversations({ userId: "user-1", attachedDocumentId: "doc-9" });
    const where = findMany.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    expect(where.attachments).toEqual({ some: { documentId: "doc-9" } });
  });

  // v1.30.2 (QoL H1) — server-side title search for the full-history rail.
  it("keeps the title out of SQL when q is given (it is encrypted) and stays owner-scoped", async () => {
    findMany.mockResolvedValue([]);
    await listConversations({ userId: "user-1", q: "blood pressure" });
    const where = findMany.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    expect("title" in where).toBe(false);
  });

  it("trims q and omits the title filter for an empty/whitespace-only query", async () => {
    findMany.mockResolvedValue([]);
    await listConversations({ userId: "user-1", q: "   " });
    const where = findMany.mock.calls[0][0].where;
    expect("title" in where).toBe(false);
  });

  it("omits the title filter entirely when q is not given (existing behaviour unchanged)", async () => {
    findMany.mockResolvedValue([]);
    await listConversations({ userId: "user-1" });
    const where = findMany.mock.calls[0][0].where;
    expect("title" in where).toBe(false);
  });

  it("falls back to filename when the first attachment has no title", async () => {
    findMany.mockResolvedValue([
      {
        id: "c3",
        title: "t",
        createdAt: now,
        updatedAt: now,
        documentScoped: true,
        _count: { messages: 1 },
        attachments: [att("doc-3", null, "scan.pdf")],
      },
    ]);
    const page = await listConversations({ userId: "user-1" });
    expect(page.conversations[0].documentTitle).toBe("scan.pdf");
  });
});

describe("fetchConversationWithMessages — filter + DTO", () => {
  const baseRow = {
    id: "c2",
    title: "Fenced thread",
    createdAt: now,
    updatedAt: now,
    documentScoped: true,
    summaryEncrypted: null,
    attachments: [att("doc-1", "Blood panel", "panel.pdf")],
    messages: [
      {
        id: "m1",
        role: "user",
        encryptedContent: new Uint8Array(),
        metricSourceJson: null,
        providerType: null,
        promptVersion: null,
        tokensUsed: null,
        model: null,
        createdAt: now,
      },
    ],
  };

  it("reads across both scopes (no scope opt) while keeping userId narrowed and maps fenced + attachments", async () => {
    findFirst.mockResolvedValue(baseRow);
    const detail = await fetchConversationWithMessages("user-1", "c2");
    const where = findFirst.mock.calls[0][0].where;
    expect(where.id).toBe("c2");
    expect(where.userId).toBe("user-1");
    expect("documentScoped" in where).toBe(false);
    expect(detail?.fenced).toBe(true);
    expect(detail?.attachmentCount).toBe(1);
    expect(detail?.attachments).toEqual([
      { documentId: "doc-1", title: "Blood panel" },
    ]);
    expect(detail?.documentTitle).toBe("Blood panel");
  });

  it("the tool-route SEND path narrows to documentScoped: false (fenced threads 404)", async () => {
    findFirst.mockResolvedValue(null);
    await fetchConversationWithMessages("user-1", "c2", {
      documentScoped: false,
    });
    const where = findFirst.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    expect(where.documentScoped).toBe(false);
  });

  it("the fenced endpoint narrows to documentScoped: true", async () => {
    findFirst.mockResolvedValue(null);
    await fetchConversationWithMessages("user-1", "c2", {
      documentScoped: true,
    });
    const where = findFirst.mock.calls[0][0].where;
    expect(where.documentScoped).toBe(true);
  });

  it("the single-doc sheet narrows to a live join row for the path id (+ documentScoped true)", async () => {
    findFirst.mockResolvedValue(null);
    await fetchConversationWithMessages("user-1", "c2", {
      attachedDocumentId: "doc-1",
    });
    const where = findFirst.mock.calls[0][0].where;
    expect(where.userId).toBe("user-1");
    expect(where.documentScoped).toBe(true);
    expect(where.attachments).toEqual({ some: { documentId: "doc-1" } });
  });
});
