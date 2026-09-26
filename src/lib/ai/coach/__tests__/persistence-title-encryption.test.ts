/**
 * v1.39.3 — the Coach conversation title is encrypted at rest. These pin the
 * three things that change with it:
 *   1. every write stores the title as ciphertext and never in the readable
 *      column;
 *   2. every read prefers the ciphertext, falls back to the readable column
 *      only for a row the backfill has not reached, and never falls back past
 *      a ciphertext that does not open;
 *   3. the history search, which used to be an SQL `ILIKE`, still finds titles
 *      (sealed and legacy alike), case-insensitively, and pages with the same
 *      cursor contract.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { findMany, create } = vi.hoisted(() => ({
  findMany: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachConversation: { findMany },
    $transaction: async (
      fn: (tx: { coachConversation: { create: typeof create } }) => unknown,
    ) => fn({ coachConversation: { create } }),
  },
}));

import {
  createConversation,
  listConversations,
  readConversationTitle,
} from "../persistence";
import { decryptFromBytes, encryptToBytes } from "../bytes-codec";

const now = new Date("2026-09-20T10:00:00.000Z");

interface StoredRow {
  id: string;
  title: string | null;
  titleEncrypted: Uint8Array | null;
}

function fullRow(row: StoredRow) {
  return {
    ...row,
    createdAt: now,
    updatedAt: now,
    documentScoped: false,
    _count: { messages: 2 },
    attachments: [],
  };
}

/**
 * A findMany that answers both reads of the search path: the id + title scan
 * (select) and the page fetch (`id: { in }`).
 */
function serve(rows: StoredRow[]) {
  findMany.mockImplementation(
    async (args: {
      where: { id?: { in: string[] } };
      select?: unknown;
      take?: number;
    }) => {
      if (args.where.id) {
        // Returned out of order on purpose: the page must follow the scan order.
        return rows
          .filter((r) => args.where.id!.in.includes(r.id))
          .reverse()
          .map(fullRow);
      }
      if (args.select) return rows.slice(0, args.take);
      return rows.slice(0, args.take).map(fullRow);
    },
  );
}

beforeEach(() => {
  findMany.mockReset();
  create.mockReset();
});

describe("createConversation", () => {
  it("stores the summarised title as ciphertext only", async () => {
    create.mockResolvedValue({
      id: "c1",
      title: null,
      titleEncrypted: null,
      createdAt: now,
      updatedAt: now,
      documentScoped: false,
    });
    const dto = await createConversation({
      userId: "u1",
      title: "Is   my resting pulse\nhigher since the new job?",
    });
    const data = create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("title");
    expect(decryptFromBytes(data.titleEncrypted)).toBe(
      "Is my resting pulse higher since the new job?",
    );
    expect(dto.title).toBe("Is my resting pulse higher since the new job?");
  });
});

describe("readConversationTitle", () => {
  it("prefers the ciphertext over a readable value", () => {
    expect(
      readConversationTitle({
        title: "stale",
        titleEncrypted: encryptToBytes("sealed"),
      }),
    ).toBe("sealed");
  });

  it("falls back to the readable column only when there is no ciphertext", () => {
    expect(
      readConversationTitle({ title: "legacy", titleEncrypted: null }),
    ).toBe("legacy");
    expect(readConversationTitle({ title: null, titleEncrypted: null })).toBe(
      "",
    );
  });

  it("throws on a ciphertext that does not open instead of showing the readable value", () => {
    expect(() =>
      readConversationTitle({
        title: "must not leak",
        titleEncrypted: new TextEncoder().encode("not-a-ciphertext"),
      }),
    ).toThrow();
  });
});

describe("listConversations title search", () => {
  const rows: StoredRow[] = [
    { id: "c5", title: null, titleEncrypted: encryptToBytes("Blood pressure") },
    { id: "c4", title: null, titleEncrypted: encryptToBytes("Sleep debt") },
    // A row the backfill has not reached yet is still searchable.
    { id: "c3", title: "Morning BLOOD pressure spikes", titleEncrypted: null },
    { id: "c2", title: null, titleEncrypted: encryptToBytes("Knee pain") },
    {
      id: "c1",
      title: null,
      titleEncrypted: encryptToBytes("blood pressure and salt"),
    },
  ];

  it("matches decrypted and legacy titles case-insensitively, in rail order", async () => {
    serve(rows);
    const page = await listConversations({ userId: "u1", q: "Blood Pressure" });
    expect(page.conversations.map((c) => c.id)).toEqual(["c5", "c3", "c1"]);
    expect(page.conversations.map((c) => c.title)).toEqual([
      "Blood pressure",
      "Morning BLOOD pressure spikes",
      "blood pressure and salt",
    ]);
    expect(page.nextCursor).toBeNull();
    // The scan stays owner-scoped and never matches in SQL.
    const scan = findMany.mock.calls[0][0];
    expect(scan.where.userId).toBe("u1");
    expect("title" in scan.where).toBe(false);
  });

  it("pages the matches with the cursor contract of the unfiltered rail", async () => {
    serve(rows);
    const first = await listConversations({
      userId: "u1",
      q: "blood",
      limit: 2,
    });
    expect(first.conversations.map((c) => c.id)).toEqual(["c5", "c3"]);
    expect(first.nextCursor).toBe("c3");

    const second = await listConversations({
      userId: "u1",
      q: "blood",
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.conversations.map((c) => c.id)).toEqual(["c1"]);
    expect(second.nextCursor).toBeNull();
  });

  it("answers an unknown cursor with an empty page", async () => {
    serve(rows);
    const page = await listConversations({
      userId: "u1",
      q: "blood",
      cursor: "gone",
    });
    expect(page.conversations).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
