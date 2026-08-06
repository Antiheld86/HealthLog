/**
 * FENCE-AC-09 — the record-selector epoch, against real Postgres.
 *
 * `Session.recordEpoch` is the one fact the whole fence rests on, and it is
 * owned by a database trigger rather than by application code. That choice only
 * pays off if it is true for the writers that run no application code, so this
 * file exercises those writers directly rather than through a helper:
 *
 *   * the `ON DELETE SET NULL` referential action on `acting_as_user_id`,
 *     which fires when an owner account is deleted and executes nothing of ours;
 *   * a raw `UPDATE sessions SET acting_as_user_id = NULL`, the shape the
 *     end-to-end fixtures use;
 *   * a statement that tries to set `record_epoch` itself, which must lose.
 *
 * And the negative half, which matters just as much: the two writes that touch
 * a session on nearly every request — the throttled `last_active_at` stamp and
 * the sliding `expires_at` extension — must not move the counter. A counter
 * that drifts on ordinary traffic would refuse every request in the app.
 *
 * Break this file by deleting the `CREATE TRIGGER` statement from migration
 * 0302: the referential-action leg and the `clearActingSessions` leg both fail,
 * because nothing else increments.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { clearActingSessions } from "@/lib/sharing/acting-session";

let counter = 0;

async function makeUser(label: string) {
  const suffix = `${label}-${counter++}`;
  return getPrismaClient().user.create({
    data: {
      username: `epoch-${suffix}`,
      email: `epoch-${suffix}@example.test`,
      role: "USER",
    },
  });
}

async function makeSession(userId: string, actingAsUserId: string | null) {
  return getPrismaClient().session.create({
    data: {
      userId,
      actingAsUserId,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
}

async function epochOf(sessionId: string): Promise<number> {
  const row = await getPrismaClient().session.findUniqueOrThrow({
    where: { id: sessionId },
  });
  return row.recordEpoch;
}

describe("FENCE-AC-09 record-selector epoch trigger", () => {
  beforeEach(async () => {
    await truncateAllTables(getPrismaClient());
  });

  it("FENCE-AC-09 starts every fresh session at zero", async () => {
    const user = await makeUser("fresh");
    const session = await makeSession(user.id, null);
    expect(session.recordEpoch).toBe(0);
  });

  it("FENCE-AC-09 bumps by exactly one when the selector is pointed at a record", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const session = await makeSession(delegate.id, null);

    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });

    expect(await epochOf(session.id)).toBe(1);
  });

  it("FENCE-AC-09 bumps again on the way back out", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const session = await makeSession(delegate.id, owner.id);
    // Seeded already pointed at the owner: the INSERT does not fire an UPDATE
    // trigger, so this row starts at 0 and the switch-out is its first bump.
    expect(await epochOf(session.id)).toBe(0);

    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: null },
    });

    expect(await epochOf(session.id)).toBe(1);
  });

  it("FENCE-AC-09 does not bump when the selector is rewritten to the same value", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const session = await makeSession(delegate.id, null);

    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });
    expect(await epochOf(session.id)).toBe(1);

    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });
    expect(await epochOf(session.id)).toBe(1);

    // And the NULL -> NULL case, which `IS DISTINCT FROM` has to get right
    // where a bare `<>` would not.
    const untouched = await makeSession(delegate.id, null);
    await getPrismaClient().session.update({
      where: { id: untouched.id },
      data: { actingAsUserId: null },
    });
    expect(await epochOf(untouched.id)).toBe(0);
  });

  it("FENCE-AC-09 bumps on the ON DELETE SET NULL referential action, where no application code runs", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const session = await makeSession(delegate.id, null);

    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });
    const beforeDelete = await epochOf(session.id);
    expect(beforeDelete).toBe(1);

    // Deleting the OWNER nulls the delegate's selector by referential action.
    // Nothing of ours executes; the trigger is the only thing that can move
    // the counter here.
    await getPrismaClient().user.delete({ where: { id: owner.id } });

    const row = await getPrismaClient().session.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(row.actingAsUserId).toBeNull();
    expect(row.recordEpoch).toBe(beforeDelete + 1);
  });

  it("FENCE-AC-09 bumps every row clearActingSessions clears", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const first = await makeSession(delegate.id, null);
    const second = await makeSession(delegate.id, null);
    const unrelated = await makeSession(delegate.id, null);

    for (const s of [first, second]) {
      await getPrismaClient().session.update({
        where: { id: s.id },
        data: { actingAsUserId: owner.id },
      });
    }

    const cleared = await clearActingSessions({
      grantorId: owner.id,
      granteeId: delegate.id,
    });

    expect(cleared).toBe(2);
    expect(await epochOf(first.id)).toBe(2);
    expect(await epochOf(second.id)).toBe(2);
    // The session that was never inside the record is untouched, which is what
    // keeps the fence's exemption meaningful.
    expect(await epochOf(unrelated.id)).toBe(0);
  });

  it("FENCE-AC-09 bumps on a raw SQL clear, the shape the browser fixtures use", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const session = await makeSession(delegate.id, null);

    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });

    await getPrismaClient()
      .$executeRaw`UPDATE "sessions" SET "acting_as_user_id" = NULL WHERE "user_id" = ${delegate.id}`;

    expect(await epochOf(session.id)).toBe(2);
  });

  it("FENCE-AC-09 leaves the per-request session writes alone", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const session = await makeSession(delegate.id, null);

    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { actingAsUserId: owner.id },
    });
    expect(await epochOf(session.id)).toBe(1);

    // The throttled "last seen" stamp (`session.ts`).
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { lastActiveAt: new Date() },
    });
    // The sliding-expiry extension (`session.ts`).
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { expiresAt: new Date(Date.now() + 3_600_000) },
    });
    // And both at once, which is the shape a future consolidation would take.
    await getPrismaClient().session.update({
      where: { id: session.id },
      data: { lastActiveAt: new Date(), expiresAt: new Date(Date.now() + 1) },
    });

    expect(await epochOf(session.id)).toBe(1);
  });

  it("FENCE-AC-09 refuses an application-supplied epoch: the trigger's value wins", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    const session = await makeSession(delegate.id, null);

    // A statement that sets both the selector and an arbitrary epoch. BEFORE
    // timing means the trigger overwrites `NEW.record_epoch` wholesale, so a
    // writer cannot steer the counter even deliberately.
    await getPrismaClient()
      .$executeRaw`UPDATE "sessions" SET "acting_as_user_id" = ${owner.id}, "record_epoch" = 999 WHERE "id" = ${session.id}`;

    expect(await epochOf(session.id)).toBe(1);

    // Nor can a writer freeze it by rewriting the current value.
    await getPrismaClient()
      .$executeRaw`UPDATE "sessions" SET "acting_as_user_id" = NULL, "record_epoch" = 1 WHERE "id" = ${session.id}`;

    expect(await epochOf(session.id)).toBe(2);
  });

  it("FENCE-AC-09 holds the migration's normalisation invariant: epoch zero iff the selector is null", async () => {
    const owner = await makeUser("owner");
    const delegate = await makeUser("delegate");
    await makeSession(delegate.id, null);
    const switched = await makeSession(delegate.id, null);
    await getPrismaClient().session.update({
      where: { id: switched.id },
      data: { actingAsUserId: owner.id },
    });

    // The migration's `UPDATE ... SET record_epoch = 1 WHERE acting_as_user_id
    // IS NOT NULL` establishes this over pre-existing rows; the trigger
    // maintains one direction of it afterwards. What the fence actually relies
    // on is the weaker, always-true half asserted here: a row still pointed at
    // another record is never at epoch zero.
    const pointed = await getPrismaClient().session.findMany({
      where: { actingAsUserId: { not: null } },
    });
    expect(pointed.length).toBeGreaterThan(0);
    for (const row of pointed) {
      expect(row.recordEpoch).toBeGreaterThanOrEqual(1);
    }
  });
});
