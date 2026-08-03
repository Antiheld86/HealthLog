/**
 * v1.36.x — "somebody else marked your dose" helper.
 *
 * What is pinned here, and why each one is a property rather than an
 * observation:
 *
 *  1. The notification is addressed to the OWNER and names the acting person
 *     and the medication. The delegate is not a recipient anywhere in this
 *     file, because there is no delegate-directed push to assert.
 *  2. The self refusal lives in the helper, so a future call site that forgets
 *     to compare ids still cannot notify somebody about their own dose.
 *  3. A snooze is not a marking and produces nothing.
 *  4. The medication is read scoped to the owner — the name that reaches a
 *     lock screen comes from the recipient's own rows.
 *  5. Nothing here throws: a failed notification never fails the write that
 *     produced it.
 *
 * Mutation check (run before this file was committed): deleting the
 * `actorId === ownerId` guard turns "fires nothing when the owner marks their
 * own dose" red with `expected "spy" to not be called at all, but actually
 * been called 1 times`. Deleting the `messageKey === null` return turns the
 * snooze case red the same way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchLocalisedMock = vi.fn();
const addWarningMock = vi.fn();

vi.mock("@/lib/notifications/dispatch-localised", () => ({
  dispatchLocalisedNotification: (...args: unknown[]) =>
    dispatchLocalisedMock(...args),
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: addWarningMock, addMeta: vi.fn() }),
}));

const userFindUnique = vi.fn();
const medicationFindFirst = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: { findUnique: (...a: unknown[]) => userFindUnique(...a) },
    medication: { findFirst: (...a: unknown[]) => medicationFindFirst(...a) },
  },
}));

import {
  delegatedIntakeMessageKey,
  notifyDelegatedIntake,
} from "@/lib/notifications/delegated-intake";

const OWNER = "owner-account";
const DELEGATE = "delegate-account";
const MEDICATION = "med-1";

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue({
    username: "wren",
    displayName: "Wren",
  });
  medicationFindFirst.mockResolvedValue({ name: "Ramipril" });
  dispatchLocalisedMock.mockResolvedValue(undefined);
});

describe("delegatedIntakeMessageKey", () => {
  it("maps a marking to its own body and a snooze to nothing", () => {
    expect(delegatedIntakeMessageKey("taken")).toBe(
      "notifications.sharedRecordIntake.bodyTaken",
    );
    expect(delegatedIntakeMessageKey("skipped")).toBe(
      "notifications.sharedRecordIntake.bodySkipped",
    );
    expect(delegatedIntakeMessageKey("snoozed")).toBeNull();
  });
});

describe("notifyDelegatedIntake", () => {
  it("notifies the owner, naming the acting person and the medication", async () => {
    await notifyDelegatedIntake({
      ownerId: OWNER,
      actorId: DELEGATE,
      medicationId: MEDICATION,
      status: "taken",
    });

    expect(dispatchLocalisedMock).toHaveBeenCalledTimes(1);
    expect(dispatchLocalisedMock).toHaveBeenCalledWith({
      userId: OWNER,
      eventType: "SHARED_RECORD_INTAKE",
      titleKey: "notifications.sharedRecordIntake.title",
      messageKey: "notifications.sharedRecordIntake.bodyTaken",
      params: { name: "Wren", medication: "Ramipril" },
      metadata: { medicationId: MEDICATION },
    });
  });

  it("carries the skipped body for a skipped dose", async () => {
    await notifyDelegatedIntake({
      ownerId: OWNER,
      actorId: DELEGATE,
      medicationId: MEDICATION,
      status: "skipped",
    });

    expect(dispatchLocalisedMock.mock.calls[0][0]).toMatchObject({
      messageKey: "notifications.sharedRecordIntake.bodySkipped",
    });
  });

  it("falls back to the username when the acting account set no display name", async () => {
    userFindUnique.mockResolvedValue({ username: "wren", displayName: null });

    await notifyDelegatedIntake({
      ownerId: OWNER,
      actorId: DELEGATE,
      medicationId: MEDICATION,
      status: "taken",
    });

    expect(dispatchLocalisedMock.mock.calls[0][0].params).toMatchObject({
      name: "wren",
    });
  });

  it("fires nothing when the owner marks their own dose", async () => {
    await notifyDelegatedIntake({
      ownerId: OWNER,
      actorId: OWNER,
      medicationId: MEDICATION,
      status: "taken",
    });

    expect(dispatchLocalisedMock).not.toHaveBeenCalled();
    // Not even a lookup: the refusal is the first thing the helper does.
    expect(userFindUnique).not.toHaveBeenCalled();
    expect(medicationFindFirst).not.toHaveBeenCalled();
  });

  it("fires nothing for a snooze", async () => {
    await notifyDelegatedIntake({
      ownerId: OWNER,
      actorId: DELEGATE,
      medicationId: MEDICATION,
      status: "snoozed",
    });

    expect(dispatchLocalisedMock).not.toHaveBeenCalled();
  });

  it("reads the medication scoped to the owner", async () => {
    await notifyDelegatedIntake({
      ownerId: OWNER,
      actorId: DELEGATE,
      medicationId: MEDICATION,
      status: "taken",
    });

    expect(medicationFindFirst).toHaveBeenCalledWith({
      where: { id: MEDICATION, userId: OWNER },
      select: { name: true },
    });
  });

  it("stays silent, with a warning, when the medication is not the owner's", async () => {
    medicationFindFirst.mockResolvedValue(null);

    await notifyDelegatedIntake({
      ownerId: OWNER,
      actorId: DELEGATE,
      medicationId: MEDICATION,
      status: "taken",
    });

    expect(dispatchLocalisedMock).not.toHaveBeenCalled();
    expect(addWarningMock).toHaveBeenCalledWith(
      expect.stringContaining("medication=missing"),
    );
  });

  it("swallows a dispatch failure so the write that produced it survives", async () => {
    dispatchLocalisedMock.mockRejectedValue(new Error("telegram is down"));

    await expect(
      notifyDelegatedIntake({
        ownerId: OWNER,
        actorId: DELEGATE,
        medicationId: MEDICATION,
        status: "taken",
      }),
    ).resolves.toBeUndefined();

    expect(addWarningMock).toHaveBeenCalledWith(
      expect.stringContaining("telegram is down"),
    );
  });
});
