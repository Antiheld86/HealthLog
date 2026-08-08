/**
 * The link service against real Postgres.
 *
 * Almost nothing asserted here is unit-testable, and that is the reason the
 * file exists rather than a mocked sibling. Ownership refusal is a `where`
 * clause; the duplicate no-op is a unique index plus `skipDuplicates`; the
 * soft-delete exclusion is another `where`. A fake client that ignored `where`
 * would report every one of them as working, which is precisely the shape of
 * green test this repository has been burned by.
 *
 * Two accounts are seeded for every case, because "scoped to the owner" is a
 * claim about the SECOND account and a single-account fixture cannot see it.
 */
import { beforeEach, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import {
  MAX_TARGETS_PER_CALL,
  linkTargets,
  listTargets,
  listDistinctTargets,
  listTargetsBySource,
  replaceTargets,
  unlinkTargets,
} from "@/lib/links";

import { getPrismaClient, truncateAllTables } from "./setup";

const OWNER = "link-owner";
const STRANGER = "link-stranger";

async function seedAccount(id: string) {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: { id, username: id, email: `${id}@example.test` },
  });
  const encounter = await prisma.encounter.create({
    data: {
      userId: id,
      occurredAt: new Date("2026-07-01T09:00:00.000Z"),
      status: "DONE",
      kind: "ROUTINE",
    },
  });
  const document = await prisma.inboundDocument.create({
    data: {
      userId: id,
      kind: "LAB_RESULT",
      title: `${id} report`,
      mimeType: "application/pdf",
      byteSize: 12,
      contentEncrypted: new Uint8Array([1, 2, 3]),
      contentCodec: "binary2",
      documentDate: new Date("2026-06-30T00:00:00.000Z"),
    },
  });
  const labResult = await prisma.labResult.create({
    data: {
      userId: id,
      analyte: "Ferritin",
      panel: "Iron panel",
      value: 91,
      unit: "ng/mL",
      takenAt: new Date("2026-06-30T09:00:00.000Z"),
    },
  });
  const episode = await prisma.illnessEpisode.create({
    data: {
      userId: id,
      label: `${id} condition`,
      type: "INFECTION",
      onsetAt: new Date("2026-06-20T00:00:00.000Z"),
    },
  });
  const vaccination = await prisma.vaccinationRecord.create({
    data: {
      userId: id,
      occurredAt: new Date("2026-05-14T00:00:00.000Z"),
      antigenSlug: "tdap",
    },
  });
  return { encounter, document, labResult, episode, vaccination };
}

let owner: Awaited<ReturnType<typeof seedAccount>>;
let stranger: Awaited<ReturnType<typeof seedAccount>>;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  owner = await seedAccount(OWNER);
  stranger = await seedAccount(STRANGER);
});

describe("link service — ownership", () => {
  it("refuses a target the caller does not own, and writes nothing", async () => {
    const prisma = getPrismaClient();
    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
      targetIds: [stranger.document.id],
    });

    expect(result.changed).toBe(0);
    expect(result.unknownTargetIds).toEqual([stranger.document.id]);
    // The refusal has to be visible in the table, not only in the return
    // value: a service that reported zero and wrote the row anyway would
    // satisfy the assertion above.
    expect(await prisma.encounterDocumentLink.count()).toBe(0);
  });

  it("refuses a source the caller does not own", async () => {
    const prisma = getPrismaClient();
    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: stranger.encounter.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });

    expect(result.unknownSource).toBe(true);
    expect(await prisma.encounterDocumentLink.count()).toBe(0);
  });

  it("links the owned ids and names the foreign ones in the same call", async () => {
    const prisma = getPrismaClient();
    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
      targetIds: [owner.document.id, stranger.document.id],
    });

    expect(result.changed).toBe(1);
    expect(result.unknownTargetIds).toEqual([stranger.document.id]);
    expect(await prisma.encounterDocumentLink.count()).toBe(1);
  });
});

describe("link service — idempotency", () => {
  it("linking the same pair twice succeeds and changes nothing the second time", async () => {
    const prisma = getPrismaClient();
    const request = {
      userId: OWNER,
      sourceKind: "encounter" as const,
      sourceId: owner.encounter.id,
      targetKind: "labResult" as const,
      targetIds: [owner.labResult.id],
    };

    const first = await linkTargets(prisma, request);
    const second = await linkTargets(prisma, request);

    expect(first.changed).toBe(1);
    expect(second.changed).toBe(0);
    expect(await prisma.encounterLabLink.count()).toBe(1);
  });

  it("unlinking a pair that was never linked is a success", async () => {
    const prisma = getPrismaClient();
    const result = await unlinkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "labResult",
      targetIds: [owner.labResult.id],
    });
    expect(result.changed).toBe(0);
  });

  it("counts a duplicated id in one call once", async () => {
    const prisma = getPrismaClient();
    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "conditionEpisode",
      targetIds: [owner.episode.id, owner.episode.id],
    });
    expect(result.changed).toBe(1);
    expect(await prisma.encounterConditionLink.count()).toBe(1);
  });
});

describe("link service — the cap", () => {
  it("refuses a call naming more targets than the cap", async () => {
    const prisma = getPrismaClient();
    const tooMany = Array.from(
      { length: MAX_TARGETS_PER_CALL + 1 },
      (_, i) => `target-${i}`,
    );
    await expect(
      linkTargets(prisma, {
        userId: OWNER,
        sourceKind: "encounter",
        sourceId: owner.encounter.id,
        targetKind: "document",
        targetIds: tooMany,
      }),
    ).rejects.toThrow(/above the cap/);
  });

  it("accepts a call exactly at the cap", async () => {
    const prisma = getPrismaClient();
    const atCap = Array.from(
      { length: MAX_TARGETS_PER_CALL },
      (_, i) => `target-${i}`,
    );
    // Every id is unknown, so nothing is written — the point is that the cap
    // itself does not reject a call sitting on the boundary.
    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
      targetIds: atCap,
    });
    expect(result.unknownTargetIds).toHaveLength(MAX_TARGETS_PER_CALL);
  });
});

describe("link service — soft deletes", () => {
  it("will not link a tombstoned target", async () => {
    const prisma = getPrismaClient();
    await prisma.inboundDocument.update({
      where: { id: owner.document.id },
      data: { deletedAt: new Date() },
    });

    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });
    expect(result.unknownTargetIds).toEqual([owner.document.id]);
    expect(await prisma.encounterDocumentLink.count()).toBe(0);
  });

  it("will not link onto a tombstoned source", async () => {
    const prisma = getPrismaClient();
    await prisma.encounter.update({
      where: { id: owner.encounter.id },
      data: { deletedAt: new Date() },
    });

    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });
    expect(result.unknownSource).toBe(true);
  });

  it("still unlinks a target the account has since deleted", async () => {
    const prisma = getPrismaClient();
    await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });
    await prisma.inboundDocument.update({
      where: { id: owner.document.id },
      data: { deletedAt: new Date() },
    });

    // Refusing here would leave a filing nobody can clear.
    const result = await unlinkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });
    expect(result.changed).toBe(1);
  });

  it("drops a tombstoned target out of the resolved list", async () => {
    const prisma = getPrismaClient();
    await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });
    await prisma.inboundDocument.update({
      where: { id: owner.document.id },
      data: { deletedAt: new Date() },
    });

    const listed = await listTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
    });
    expect(listed).toEqual([]);
  });
});

describe("link service — replace", () => {
  it("drops what is no longer named and adds what is missing", async () => {
    const prisma = getPrismaClient();
    const second = await prisma.illnessEpisode.create({
      data: {
        userId: OWNER,
        label: "Second condition",
        type: "INFECTION",
        onsetAt: new Date("2026-06-25T00:00:00.000Z"),
      },
    });

    await replaceTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "conditionEpisode",
      targetIds: [owner.episode.id],
    });
    await replaceTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "conditionEpisode",
      targetIds: [second.id],
    });

    const linked = await prisma.encounterConditionLink.findMany({
      where: { encounterId: owner.encounter.id },
      select: { episodeId: true },
    });
    expect(linked.map((row) => row.episodeId)).toEqual([second.id]);
  });

  it("clears every link when the set is empty", async () => {
    const prisma = getPrismaClient();
    await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "conditionEpisode",
      targetIds: [owner.episode.id],
    });
    await replaceTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "conditionEpisode",
      targetIds: [],
    });
    expect(await prisma.encounterConditionLink.count()).toBe(0);
  });
});

describe("link service — resolved reads", () => {
  it("returns a label and a date, never a bare id", async () => {
    const prisma = getPrismaClient();
    await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "labResult",
      targetIds: [owner.labResult.id],
    });

    const listed = await listTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "labResult",
    });
    expect(listed).toEqual([
      {
        id: owner.labResult.id,
        label: "Iron panel · Ferritin",
        date: "2026-06-30T09:00:00.000Z",
      },
    ]);
  });

  it("keys a batched read by source and omits sources with no links", async () => {
    const prisma = getPrismaClient();
    const other = await prisma.encounter.create({
      data: {
        userId: OWNER,
        occurredAt: new Date("2026-07-02T09:00:00.000Z"),
        status: "DONE",
        kind: "ROUTINE",
      },
    });
    await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: owner.encounter.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });

    const bySource = await listTargetsBySource(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceIds: [owner.encounter.id, other.id],
      targetKind: "document",
    });
    expect(bySource.get(owner.encounter.id)).toHaveLength(1);
    expect(bySource.has(other.id)).toBe(false);
  });

  it("offers a distinct target only while a live source still points at it", async () => {
    const prisma = getPrismaClient();
    await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "document",
      sourceId: owner.document.id,
      targetKind: "conditionEpisode",
      targetIds: [owner.episode.id],
    });

    expect(
      await listDistinctTargets(prisma, {
        userId: OWNER,
        sourceKind: "document",
        targetKind: "conditionEpisode",
      }),
    ).toHaveLength(1);

    await prisma.inboundDocument.update({
      where: { id: owner.document.id },
      data: { deletedAt: new Date() },
    });

    expect(
      await listDistinctTargets(prisma, {
        userId: OWNER,
        sourceKind: "document",
        targetKind: "conditionEpisode",
      }),
    ).toEqual([]);
  });

  it("does not leak another account's links into a read", async () => {
    const prisma = getPrismaClient();
    await linkTargets(prisma, {
      userId: STRANGER,
      sourceKind: "encounter",
      sourceId: stranger.encounter.id,
      targetKind: "document",
      targetIds: [stranger.document.id],
    });

    const listed = await listTargets(prisma, {
      userId: OWNER,
      sourceKind: "encounter",
      sourceId: stranger.encounter.id,
      targetKind: "document",
    });
    expect(listed).toEqual([]);
  });
});

/**
 * The `vaccination:document` pair, one case per invariant the facade claims.
 *
 * The pair is new; the invariants are not. Repeating them here rather than
 * trusting the encounter cases is the point — every one of them is a `where`
 * clause or an index on a DIFFERENT table, and a pair wired to the wrong
 * column or the wrong ownership probe would pass every test above while
 * exposing this one.
 */
describe("link service — the vaccination pair", () => {
  it("links a dose to the page it was transcribed from", async () => {
    const prisma = getPrismaClient();
    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "vaccination",
      sourceId: owner.vaccination.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });

    expect(result.changed).toBe(1);
    expect(result.unknownTargetIds).toEqual([]);
    expect(await prisma.vaccinationDocumentLink.count()).toBe(1);
    // Written against the right columns, not merely written: a pair wired to
    // the wrong column would still increment the count above.
    const row = await prisma.vaccinationDocumentLink.findFirstOrThrow();
    expect({
      vaccinationId: row.vaccinationId,
      documentId: row.documentId,
      userId: row.userId,
    }).toEqual({
      vaccinationId: owner.vaccination.id,
      documentId: owner.document.id,
      userId: OWNER,
    });
  });

  it("refuses a document another account owns", async () => {
    const prisma = getPrismaClient();
    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "vaccination",
      sourceId: owner.vaccination.id,
      targetKind: "document",
      targetIds: [stranger.document.id],
    });

    expect(result.changed).toBe(0);
    expect(result.unknownTargetIds).toEqual([stranger.document.id]);
    expect(await prisma.vaccinationDocumentLink.count()).toBe(0);
  });

  it("refuses a dose another account owns", async () => {
    const prisma = getPrismaClient();
    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "vaccination",
      sourceId: stranger.vaccination.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });

    expect(result.unknownSource).toBe(true);
    expect(await prisma.vaccinationDocumentLink.count()).toBe(0);
  });

  it("links the same pair twice without writing a second row", async () => {
    const prisma = getPrismaClient();
    const request = {
      userId: OWNER,
      sourceKind: "vaccination" as const,
      sourceId: owner.vaccination.id,
      targetKind: "document" as const,
      targetIds: [owner.document.id],
    };
    expect((await linkTargets(prisma, request)).changed).toBe(1);
    expect((await linkTargets(prisma, request)).changed).toBe(0);
    expect(await prisma.vaccinationDocumentLink.count()).toBe(1);
  });

  it("refuses a call naming more targets than the cap", async () => {
    const prisma = getPrismaClient();
    await expect(
      linkTargets(prisma, {
        userId: OWNER,
        sourceKind: "vaccination",
        sourceId: owner.vaccination.id,
        targetKind: "document",
        targetIds: Array.from(
          { length: MAX_TARGETS_PER_CALL + 1 },
          (_, index) => `doc-${index}`,
        ),
      }),
    ).rejects.toThrow(/cap/);
    expect(await prisma.vaccinationDocumentLink.count()).toBe(0);
  });

  it("will not link onto a dose the account has deleted", async () => {
    const prisma = getPrismaClient();
    await prisma.vaccinationRecord.update({
      where: { id: owner.vaccination.id },
      data: { deletedAt: new Date() },
    });

    const result = await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "vaccination",
      sourceId: owner.vaccination.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });
    expect(result.unknownSource).toBe(true);
    expect(await prisma.vaccinationDocumentLink.count()).toBe(0);
  });

  it("resolves the linked page to a label and a date, never a bare id", async () => {
    const prisma = getPrismaClient();
    await linkTargets(prisma, {
      userId: OWNER,
      sourceKind: "vaccination",
      sourceId: owner.vaccination.id,
      targetKind: "document",
      targetIds: [owner.document.id],
    });

    const listed = await listTargets(prisma, {
      userId: OWNER,
      sourceKind: "vaccination",
      sourceId: owner.vaccination.id,
      targetKind: "document",
    });
    expect(listed).toEqual([
      {
        id: owner.document.id,
        label: `${OWNER} report`,
        date: "2026-06-30T00:00:00.000Z",
      },
    ]);
  });

  it("does not leak another account's dose links into a read", async () => {
    const prisma = getPrismaClient();
    await linkTargets(prisma, {
      userId: STRANGER,
      sourceKind: "vaccination",
      sourceId: stranger.vaccination.id,
      targetKind: "document",
      targetIds: [stranger.document.id],
    });

    expect(
      await listTargets(prisma, {
        userId: OWNER,
        sourceKind: "vaccination",
        sourceId: stranger.vaccination.id,
        targetKind: "document",
      }),
    ).toEqual([]);
  });

  it("has no table joining a dose to a lab result", async () => {
    // The ceiling, asserted rather than only commented: the vaccination
    // source owns exactly one pair, and asking for a second is a programming
    // error the facade refuses loudly instead of inventing a table for.
    const prisma = getPrismaClient();
    await expect(
      linkTargets(prisma, {
        userId: OWNER,
        sourceKind: "vaccination",
        sourceId: owner.vaccination.id,
        targetKind: "labResult",
        targetIds: [owner.labResult.id],
      }),
    ).rejects.toThrow(/No link table joins a vaccination to a labResult/);
  });
});
