/**
 * Illness day-log write helper (v1.18.1) — the upsert behind
 * `POST .../episodes/{id}/day-logs`.
 *
 * UPSERT key: the canonical `(episodeId, date)`. `note` → `noteEncrypted`
 * (AES-256-GCM via the shared Bytes codec). Symptom links carry a 0–3
 * Jackson/WURSS severity (NULL = a plain presence link).
 *
 * Partial merge: a re-post that omits a field never nulls a previously
 * stored value — the UPDATE branch only overwrites the fields actually
 * present in the input. An explicit `null` clears.
 *
 * Symptom-key resolution is scoped to the global seeded catalog (illness
 * symptoms have no per-user custom rows in the MVP); unknown keys are
 * dropped silently.
 */
import { prisma } from "@/lib/db";
import { encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import type { IllnessDayLogInput } from "@/lib/validations/illness";
import { dayLogSymptomInclude, toIllnessDayLogDTO } from "@/lib/illness/dto";
import type { IllnessDayLogDTO } from "@/lib/illness/dto";
import type { Prisma } from "@/generated/prisma/client";

export interface IllnessDayLogWriteResult {
  id: string;
  existed: boolean;
  /** The full DTO of the written row — no second round-trip needed. */
  dto: IllnessDayLogDTO;
  /**
   * v1.37.0 — what this write destroyed, for the caller's audit row.
   *
   * The upsert is a rewrite wearing a create's verb: its UPDATE branch forces
   * `deletedAt: null`, so it revives a day the owner deliberately deleted, and
   * the symptom write is a full replacement of that day's links. Under MANAGE
   * somebody other than the owner can do both, so the two facts that would
   * otherwise vanish silently travel back with the result.
   */
  replaced: {
    /** Symptom keys the day carried before this write, sorted. */
    previousSymptomKeys: string[];
    /** True when the write brought a tombstoned day back. */
    revived: boolean;
  };
}

/** A symptom selection carrying its catalog key + optional 0–3 severity. */
export interface IllnessSymptomSelection {
  key: string;
  severity?: number | null;
}

/** A Prisma client OR an interactive-transaction client. */
type Db = typeof prisma | Prisma.TransactionClient;

/**
 * Resolve catalog symptom keys → `{ key, id }`, dropping unknown / inactive
 * keys silently.
 */
export async function resolveIllnessSymptomIds(
  keys: readonly string[],
  db: Db = prisma,
): Promise<{ key: string; id: string }[]> {
  if (keys.length === 0) return [];
  const unique = Array.from(new Set(keys));
  const rows = await db.illnessSymptom.findMany({
    where: { key: { in: unique }, isActive: true },
    select: { id: true, key: true },
  });
  return rows.map((r) => ({ key: r.key, id: r.id }));
}

/**
 * Replace the symptom-link set for a day-log. Each selection's optional
 * 1–3 severity is persisted on the link (NULL = a plain presence link).
 * Runs on the caller's client so it can join the day-log upsert in one
 * transaction (no torn state between the delete + create halves).
 */
export async function replaceIllnessSymptomLinks(
  dayLogId: string,
  selections: readonly IllnessSymptomSelection[],
  db: Db = prisma,
): Promise<void> {
  const resolved = await resolveIllnessSymptomIds(
    selections.map((s) => s.key),
    db,
  );
  const severityByKey = new Map(
    selections.map((s) => [
      s.key,
      typeof s.severity === "number" ? s.severity : null,
    ]),
  );
  await db.illnessSymptomLink.deleteMany({ where: { dayLogId } });
  if (resolved.length > 0) {
    await db.illnessSymptomLink.createMany({
      data: resolved.map(({ key, id }) => ({
        dayLogId,
        symptomId: id,
        severity: severityByKey.get(key) ?? null,
      })),
      skipDuplicates: true,
    });
  }
}

/**
 * Upsert one illness day-log on the `(episodeId, date)` key. The caller is
 * responsible for verifying the episode is owned + live before calling.
 * `tz` anchors the date string.
 */
export async function upsertIllnessDayLog(
  userId: string,
  episodeId: string,
  entry: IllnessDayLogInput,
  tz: string | null,
): Promise<IllnessDayLogWriteResult> {
  const where = { episodeId_date: { episodeId, date: entry.date } };

  // The upsert, the symptom-link replacement, and the final include-read all
  // run in ONE interactive transaction: no torn state between the link delete
  // + create halves, and no second round-trip — the written row (with its
  // flattened symptom links) comes straight back as the DTO.
  const { row, existed, replaced } = await prisma.$transaction(async (tx) => {
    const existing = await tx.illnessDayLog.findUnique({
      where,
      select: {
        id: true,
        functionalImpact: true,
        feverC: true,
        noteEncrypted: true,
        // v1.37.0 — the two facts the caller's audit row needs. Read inside
        // the same transaction as the write, so what is reported is what was
        // actually replaced rather than what a second read happened to see.
        deletedAt: true,
        symptomLinks: { select: { symptom: { select: { key: true } } } },
      },
    });

    // Partial merge against the stored row.
    const functionalImpact =
      entry.functionalImpact !== undefined
        ? (entry.functionalImpact ?? null)
        : (existing?.functionalImpact ?? null);
    const feverC =
      entry.feverC !== undefined
        ? (entry.feverC ?? null)
        : (existing?.feverC ?? null);

    // Note resolution with partial merge. When `note` is supplied, encrypt it
    // (an explicit empty/null clears the column). When `note` is OMITTED, the
    // existing ciphertext is preserved BYTE-FOR-BYTE — never decrypt→re-encrypt,
    // and never collapse an undecryptable existing value to null. A soft-decrypt
    // that returns null on an undecryptable column (rotation gap, GCM
    // corruption) must not be allowed to permanently wipe the stored note when
    // an unrelated field is the only thing being edited (mirrors the v1.18.1
    // 53-column rotation fix: a write path never re-writes an `*Encrypted`
    // column from a soft-decrypt result).
    const noteEncrypted =
      entry.note !== undefined
        ? entry.note
          ? encryptToBytes(entry.note)
          : null
        : (existing?.noteEncrypted ?? null);

    const upserted = await tx.illnessDayLog.upsert({
      where,
      create: {
        userId,
        episodeId,
        date: entry.date,
        tz,
        functionalImpact,
        feverC,
        noteEncrypted,
      },
      update: {
        functionalImpact,
        feverC,
        noteEncrypted,
        deletedAt: null,
      },
      select: { id: true },
    });

    if (entry.symptoms !== undefined) {
      await replaceIllnessSymptomLinks(upserted.id, entry.symptoms, tx);
    }

    const full = await tx.illnessDayLog.findUniqueOrThrow({
      where: { id: upserted.id },
      include: dayLogSymptomInclude,
    });

    return {
      row: full,
      existed: existing !== null,
      replaced: {
        previousSymptomKeys: (existing?.symptomLinks ?? [])
          .map((link) => link.symptom.key)
          .sort(),
        revived: existing?.deletedAt != null,
      },
    };
  });

  return { id: row.id, existed, dto: toIllnessDayLogDTO(row), replaced };
}
