/**
 * v1.39.3 — the Coach conversation title in both backup formats.
 *
 * A disaster-recovery file carries the title as stored: the ciphertext, or
 * for a row the free-text backfill has not reached yet the old readable value
 * (sealing it on the way out would make the export non-deterministic). A
 * portable file carries it readable, for the person who owns it. A restore of
 * any of these writes the ciphertext column and never the readable one, and a
 * file written before this release (readable title only) still restores.
 */
import { describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  buildCoachBackupSection,
  restoreCoachData,
  type RestoredCoachConversation,
} from "../coach-backup";
import { parseBackupPayload } from "@/lib/validations/backup";

const at = "2026-09-20T10:00:00.000Z";

function row(id: string, title: string | null, sealed: string | null) {
  return {
    id,
    title,
    titleEncrypted: sealed === null ? null : encryptToBytes(sealed),
    documentScoped: false,
    summaryEncrypted: null,
    summaryUpdatedAt: null,
    summaryTurnCount: 0,
    createdAt: new Date(at),
    updatedAt: new Date(at),
    messages: [],
    attachments: [],
  };
}

function prismaWith(rows: ReturnType<typeof row>[]) {
  return {
    coachConversation: { findMany: vi.fn().mockResolvedValue(rows) },
  } as never;
}

const rows = [
  row("c1", null, "Sealed title"),
  row("c2", "Legacy readable title", null),
];

describe("coach backup title", () => {
  it("a disaster-recovery file carries the title as stored", async () => {
    const section = await buildCoachBackupSection(prismaWith(rows), "u1", {
      purpose: "disaster-recovery",
    });
    const [sealed, legacy] = section.coachConversations;
    expect(JSON.stringify(sealed)).not.toContain("Sealed title");
    expect(sealed).not.toHaveProperty("title");
    expect(
      decryptFromBytes(Buffer.from(sealed.titleEncrypted!, "base64")),
    ).toBe("Sealed title");
    expect(legacy).toMatchObject({ title: "Legacy readable title" });
    expect(legacy).not.toHaveProperty("titleEncrypted");
    // The same input exports byte-identically twice: nothing is sealed with
    // a fresh IV on the way out.
    const again = await buildCoachBackupSection(prismaWith(rows), "u1", {
      purpose: "disaster-recovery",
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(section));
  });

  it("a portable file carries the readable title and no ciphertext", async () => {
    const section = await buildCoachBackupSection(prismaWith(rows), "u1", {
      purpose: "portable-export",
    });
    expect(section.coachConversations.map((c) => c.title)).toEqual([
      "Sealed title",
      "Legacy readable title",
    ]);
    for (const c of section.coachConversations) {
      expect(c).not.toHaveProperty("titleEncrypted");
    }
  });

  it("a restore of either format, and of an older file, writes only the ciphertext", async () => {
    const created: Array<Record<string, unknown>> = [];
    const tx = {
      coachMessage: { count: vi.fn().mockResolvedValue(0) },
      coachConversationDocument: {
        count: vi.fn().mockResolvedValue(0),
        createMany: vi.fn(),
      },
      coachConversation: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          created.push(args.data);
          return args.data;
        }),
      },
    };
    const base = {
      documentScoped: false,
      createdAt: at,
      updatedAt: at,
      messages: [],
      attachments: [],
    };
    const conversations: RestoredCoachConversation[] = [
      {
        ...base,
        id: "dr",
        titleEncrypted: Buffer.from(encryptToBytes("From DR")).toString(
          "base64",
        ),
      },
      { ...base, id: "portable", title: "From a portable file" },
    ];
    await restoreCoachData(
      tx as never,
      "u1",
      { coachConversations: conversations },
      new Set(),
      { entries: [] } as never,
    );
    expect(created.map((d) => d.title)).toEqual([undefined, undefined]);
    expect(
      created.map((d) => decryptFromBytes(d.titleEncrypted as Uint8Array)),
    ).toEqual(["From DR", "From a portable file"]);
  });

  it("the wire schema accepts a pre-release file with a readable title", () => {
    const parsed = parseBackupPayload({
      schemaVersion: "2",
      exportedAt: at,
      userId: "u1",
      coachConversations: [
        {
          id: "old",
          title: "Written before the title was sealed",
          documentScoped: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
    });
    expect(parsed.coachConversations[0].title).toBe(
      "Written before the title was sealed",
    );
  });
});
