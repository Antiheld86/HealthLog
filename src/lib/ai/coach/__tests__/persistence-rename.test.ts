import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { updateMany } = vi.hoisted(() => ({ updateMany: vi.fn() }));

vi.mock("@/lib/db", () => ({
  prisma: {
    coachConversation: { updateMany },
  },
}));

import { renameConversation } from "../persistence";
import { decryptFromBytes } from "../bytes-codec";

beforeEach(() => {
  updateMany.mockReset();
});

describe("renameConversation", () => {
  it("includes owner id in the database update predicate", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    await expect(
      renameConversation("owner-1", "conversation-1", "Renamed"),
    ).resolves.toEqual({ id: "conversation-1", title: "Renamed" });
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "conversation-1", userId: "owner-1" });
    // v1.39.3 — the new title is stored as ciphertext and the readable column
    // is cleared, so a legacy row never keeps its old title beside the new one.
    expect(arg.data.title).toBeNull();
    expect(decryptFromBytes(arg.data.titleEncrypted)).toBe("Renamed");
  });

  it("returns null when the owned update matched no row", async () => {
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      renameConversation("owner-1", "foreign-or-missing", "Renamed"),
    ).resolves.toBeNull();
  });
});
