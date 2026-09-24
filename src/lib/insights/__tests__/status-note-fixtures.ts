/**
 * Shared fixtures for the status-generator tests that run against the real
 * status-note store (`status-cache.ts`) over a mocked `prisma`.
 *
 * `fakeBytesCodec` stands in for the at-rest codec so a fixture can build a
 * stored note from plain text and read back what a generator wrote. Wire it
 * with
 *
 *   vi.mock("@/lib/ai/coach/bytes-codec", async () =>
 *     (await import("./status-note-fixtures")).fakeBytesCodec,
 *   );
 *
 * It is not AES-GCM and does not try to be: these tests pin what the store
 * serves, re-dates and writes, not the cipher.
 */
import type { Mock } from "vitest";

const PREFIX = "enc:";

export const fakeBytesCodec = {
  encryptToBytes: (plain: string): Uint8Array =>
    new TextEncoder().encode(`${PREFIX}${plain}`),
  decryptFromBytes: (buf: Uint8Array): string => {
    const text = new TextDecoder().decode(buf);
    if (!text.startsWith(PREFIX)) throw new Error("unknown key id");
    return text.slice(PREFIX.length);
  },
};

/** The capability state every generator fixture runs under by default. */
export const CAPABILITY_AVAILABLE = {
  available: true,
  reason: null,
  onDeviceAllowed: true,
} as const;

/** One `InsightStatusCache` row as `findUnique` returns it. */
export function noteRow(fields: {
  text?: string | null;
  items?: unknown;
  dateKey: string;
  generatedAt?: Date | null;
  snapshotHash?: string | null;
  inputHash?: string | null;
  retryAt?: Date | null;
  negativeReason?: string | null;
}) {
  return {
    textEncrypted:
      fields.text == null ? null : fakeBytesCodec.encryptToBytes(fields.text),
    itemsEncrypted:
      fields.items === undefined
        ? null
        : fakeBytesCodec.encryptToBytes(JSON.stringify(fields.items)),
    inputHash: fields.inputHash ?? null,
    snapshotHash: fields.snapshotHash ?? null,
    dateKey: fields.dateKey,
    generatedAt:
      fields.generatedAt !== undefined ? fields.generatedAt : new Date(),
    retryAt: fields.retryAt ?? null,
    negativeReason: fields.negativeReason ?? null,
  };
}

/** A note a generator wrote through `insightStatusCache.upsert`, decoded. */
export interface WrittenNote {
  metric: string;
  locale: string;
  text: string | null;
  items: unknown;
  dateKey: string | undefined;
  snapshotHash: string | null | undefined;
  inputHash: string | null | undefined;
  retryAt: Date | null | undefined;
  negativeReason: string | null | undefined;
}

/**
 * Every `upsert` call on the mocked `insightStatusCache`, decoded from its
 * `create` arm (which carries the full row either way).
 */
export function upsertedNotes(upsert: Mock | unknown): WrittenNote[] {
  return (upsert as Mock).mock.calls.map((call) => {
    const create = (call[0] as { create: Record<string, unknown> }).create;
    const decode = (v: unknown) =>
      v instanceof Uint8Array ? fakeBytesCodec.decryptFromBytes(v) : null;
    const itemsJson = decode(create.itemsEncrypted);
    return {
      metric: create.metric as string,
      locale: create.locale as string,
      text: decode(create.textEncrypted),
      items: itemsJson === null ? null : JSON.parse(itemsJson),
      dateKey: create.dateKey as string | undefined,
      snapshotHash: create.snapshotHash as string | null | undefined,
      inputHash: create.inputHash as string | null | undefined,
      retryAt: create.retryAt as Date | null | undefined,
      negativeReason: create.negativeReason as string | null | undefined,
    };
  });
}

/** Only the upserts that wrote a note (not a bare negative-cache window). */
export function writtenNotes(upsert: Mock | unknown): WrittenNote[] {
  return upsertedNotes(upsert).filter((n) => n.text !== null);
}
