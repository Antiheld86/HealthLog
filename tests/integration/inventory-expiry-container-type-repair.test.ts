/**
 * Integration coverage for `0276_inventory_expiry_container_type_repair`.
 *
 * The repair reverses the rows the in-use clock wrote off although their
 * container never carried one. A unit test cannot prove it: the predicate is
 * SQL, it reads an enum column and compares a timestamp against `NOW()`, and
 * the testcontainer starts empty so the migration itself has nothing to touch
 * when it runs at boot. This test seeds the before-state, applies the EXACT
 * migration SQL from disk, and asserts what moved, what did not, and that a
 * second application changes nothing further.
 *
 * Requires Docker / OrbStack; driven by CI's integration job (and
 * `pnpm test:integration` locally).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import type {
  MedicationContainerType,
  MedicationInventoryState,
  PrismaClient,
} from "@/generated/prisma/client";

const REPAIR_SQL = readFileSync(
  resolve(
    process.cwd(),
    "prisma/migrations/0276_inventory_expiry_container_type_repair/migration.sql",
  ),
  "utf8",
);

const DAY_MS = 24 * 60 * 60 * 1000;
const USER_ID = "inventory-repair-user";

interface SeedInput {
  containerType: MedicationContainerType;
  state: MedicationInventoryState;
  unitsRemaining?: number;
  firstUseAt?: Date | null;
  printedExpiry?: Date | null;
  expiresAt?: Date | null;
}

async function seedItem(
  prisma: PrismaClient,
  medicationId: string,
  input: SeedInput,
): Promise<string> {
  const row = await prisma.medicationInventoryItem.create({
    data: {
      userId: USER_ID,
      medicationId,
      state: input.state,
      containerType: input.containerType,
      unitsTotal: 60,
      unitsRemaining: input.unitsRemaining ?? 54,
      firstUseAt: input.firstUseAt ?? null,
      printedExpiry: input.printedExpiry ?? null,
      expiresAt: input.expiresAt ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

async function readItem(prisma: PrismaClient, id: string) {
  const row = await prisma.medicationInventoryItem.findUniqueOrThrow({
    where: { id },
    select: {
      state: true,
      expiresAt: true,
      printedExpiry: true,
      firstUseAt: true,
      unitsRemaining: true,
      // Part of the read so the idempotency assertion below can see a
      // second application touching a row it should have skipped.
      updatedAt: true,
    },
  });
  return row;
}

describe("0276 inventory expiry container-type repair — integration", () => {
  let medicationId: string;

  beforeEach(async () => {
    const prisma = getPrismaClient();
    await truncateAllTables(prisma);
    await prisma.user.create({
      data: {
        id: USER_ID,
        username: "inventory-repair",
        email: "inventory-repair@example.test",
      },
    });
    const med = await prisma.medication.create({
      data: {
        userId: USER_ID,
        name: "Tablets",
        dose: "10mg",
        deliveryForm: "ORAL",
      },
      select: { id: true },
    });
    medicationId = med.id;
  });

  it("restores a wrongly expired blister to IN_USE and clears its deadline", async () => {
    const prisma = getPrismaClient();
    const openedAt = new Date(Date.now() - 45 * DAY_MS);
    const id = await seedItem(prisma, medicationId, {
      containerType: "BLISTER",
      state: "EXPIRED",
      firstUseAt: openedAt,
      printedExpiry: null,
      // What the old `computeExpiresAt` persisted: firstUseAt + 30 days.
      expiresAt: new Date(openedAt.getTime() + 30 * DAY_MS),
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);

    const row = await readItem(prisma, id);
    expect(row.state).toBe("IN_USE");
    // No printed expiry was recorded, so none is invented.
    expect(row.expiresAt).toBeNull();
    expect(row.printedExpiry).toBeNull();
    expect(row.firstUseAt).toEqual(openedAt);
    expect(Number(row.unitsRemaining)).toBe(54);
  });

  it("restores an unopened clock-less container to ACTIVE", async () => {
    const prisma = getPrismaClient();
    const id = await seedItem(prisma, medicationId, {
      containerType: "OTHER",
      state: "EXPIRED",
      firstUseAt: null,
      printedExpiry: null,
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);

    expect((await readItem(prisma, id)).state).toBe("ACTIVE");
  });

  it("keeps the printed expiry as the row's deadline when one is recorded", async () => {
    const prisma = getPrismaClient();
    const printed = new Date(Date.now() + 200 * DAY_MS);
    const openedAt = new Date(Date.now() - 45 * DAY_MS);
    const id = await seedItem(prisma, medicationId, {
      containerType: "BOTTLE",
      state: "EXPIRED",
      firstUseAt: openedAt,
      printedExpiry: printed,
      expiresAt: new Date(openedAt.getTime() + 30 * DAY_MS),
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);

    const row = await readItem(prisma, id);
    expect(row.state).toBe("IN_USE");
    expect(row.expiresAt).toEqual(printed);
  });

  it("leaves an expired pen alone — its clock is real", async () => {
    const prisma = getPrismaClient();
    const openedAt = new Date(Date.now() - 45 * DAY_MS);
    const expiresAt = new Date(openedAt.getTime() + 30 * DAY_MS);
    const id = await seedItem(prisma, medicationId, {
      containerType: "PEN",
      state: "EXPIRED",
      firstUseAt: openedAt,
      expiresAt,
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);

    const row = await readItem(prisma, id);
    expect(row.state).toBe("EXPIRED");
    expect(row.expiresAt).toEqual(expiresAt);
  });

  it("leaves an expired ampoule alone — its clock is real", async () => {
    const prisma = getPrismaClient();
    const id = await seedItem(prisma, medicationId, {
      containerType: "AMPOULE",
      state: "EXPIRED",
      firstUseAt: new Date(Date.now() - 45 * DAY_MS),
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);

    expect((await readItem(prisma, id)).state).toBe("EXPIRED");
  });

  it("leaves a container whose printed expiry genuinely lapsed alone", async () => {
    const prisma = getPrismaClient();
    const printed = new Date(Date.now() - 3 * DAY_MS);
    const id = await seedItem(prisma, medicationId, {
      containerType: "BLISTER",
      state: "EXPIRED",
      firstUseAt: new Date(Date.now() - 45 * DAY_MS),
      printedExpiry: printed,
      expiresAt: printed,
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);

    const row = await readItem(prisma, id);
    expect(row.state).toBe("EXPIRED");
    expect(row.expiresAt).toEqual(printed);
  });

  it("leaves a drained container alone — nothing to give back", async () => {
    const prisma = getPrismaClient();
    const id = await seedItem(prisma, medicationId, {
      containerType: "BLISTER",
      state: "EXPIRED",
      unitsRemaining: 0,
      firstUseAt: new Date(Date.now() - 45 * DAY_MS),
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);

    expect((await readItem(prisma, id)).state).toBe("EXPIRED");
  });

  it.each(["ACTIVE", "IN_USE", "USED_UP"] as const)(
    "leaves the state of a %s row alone",
    async (state) => {
      const prisma = getPrismaClient();
      const id = await seedItem(prisma, medicationId, {
        containerType: "BLISTER",
        state,
        unitsRemaining: state === "USED_UP" ? 0 : 54,
        expiresAt: new Date(Date.now() + 10 * DAY_MS),
      });

      await prisma.$executeRawUnsafe(REPAIR_SQL);

      expect((await readItem(prisma, id)).state).toBe(state);
    },
  );

  it("clears the pending clock deadline on a still-IN_USE blister", async () => {
    // The rows the flip has not reached yet. Their `expires_at` is the
    // old firstUseAt + 30 days, still in the future, and the daily
    // expire scan would have written them off on schedule.
    const prisma = getPrismaClient();
    const openedAt = new Date(Date.now() - 10 * DAY_MS);
    const id = await seedItem(prisma, medicationId, {
      containerType: "BLISTER",
      state: "IN_USE",
      firstUseAt: openedAt,
      printedExpiry: null,
      expiresAt: new Date(openedAt.getTime() + 30 * DAY_MS),
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);

    const row = await readItem(prisma, id);
    expect(row.state).toBe("IN_USE");
    expect(row.expiresAt).toBeNull();
  });

  it("leaves a pen's pending clock deadline in place", async () => {
    const prisma = getPrismaClient();
    const openedAt = new Date(Date.now() - 10 * DAY_MS);
    const expiresAt = new Date(openedAt.getTime() + 30 * DAY_MS);
    const id = await seedItem(prisma, medicationId, {
      containerType: "PEN",
      state: "IN_USE",
      firstUseAt: openedAt,
      printedExpiry: null,
      expiresAt,
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);

    const row = await readItem(prisma, id);
    expect(row.state).toBe("IN_USE");
    expect(row.expiresAt).toEqual(expiresAt);
  });

  it("is idempotent — a second application touches nothing", async () => {
    // `updatedAt` is part of the compared shape, so a second pass that
    // rewrites an already-correct row is visible even when the value it
    // writes is the same one.
    const prisma = getPrismaClient();
    const id = await seedItem(prisma, medicationId, {
      containerType: "BLISTER",
      state: "EXPIRED",
      firstUseAt: new Date(Date.now() - 45 * DAY_MS),
    });

    await prisma.$executeRawUnsafe(REPAIR_SQL);
    const first = await readItem(prisma, id);
    await prisma.$executeRawUnsafe(REPAIR_SQL);
    const second = await readItem(prisma, id);

    expect(second).toEqual(first);
  });
});
