/**
 * `verifyMfaFactor` is the one place a TOTP code is accepted as proof of a
 * second factor — login completion, step-up minting, MFA disable and the
 * passkey-enrollment re-proof all call it. A secret that was never confirmed
 * is a pending enrollment, not a factor: whoever holds a session can create
 * one, so a code from it proves only that the caller started enrollment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { user: { updateMany: vi.fn() } },
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: vi.fn(() => "SECRET"),
}));
vi.mock("@/lib/auth/mfa/totp", () => ({
  verifyTotp: vi.fn(() => ({ valid: true, replay: false, step: 100 })),
}));
vi.mock("@/lib/auth/mfa/recovery-codes", () => ({
  verifyAndConsumeRecoveryCode: vi.fn(async () => true),
}));

import { verifyMfaFactor } from "../verify-factor";
import { verifyTotp } from "@/lib/auth/mfa/totp";
import { verifyAndConsumeRecoveryCode } from "@/lib/auth/mfa/recovery-codes";
import { prisma } from "@/lib/db";

const baseUser = {
  id: "u1",
  totpSecretEncrypted: "enc",
  totpLastStep: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 1 } as never);
});

describe("verifyMfaFactor", () => {
  it("accepts a valid code against a confirmed secret and burns the step", async () => {
    const res = await verifyMfaFactor(
      { ...baseUser, totpConfirmedAt: new Date() },
      "totp",
      "123456",
    );
    expect(res).toEqual({ ok: true, replay: false });
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
  });

  it("refuses a valid code against a pending (unconfirmed) secret", async () => {
    const res = await verifyMfaFactor(
      { ...baseUser, totpConfirmedAt: null },
      "totp",
      "123456",
    );
    expect(res).toEqual({ ok: false, replay: false });
    // The code is never even evaluated, and no step is burned.
    expect(verifyTotp).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("refuses when no secret is stored at all", async () => {
    const res = await verifyMfaFactor(
      { ...baseUser, totpSecretEncrypted: null, totpConfirmedAt: new Date() },
      "totp",
      "123456",
    );
    expect(res.ok).toBe(false);
  });

  it("refuses a recovery code while no second factor is confirmed", async () => {
    const res = await verifyMfaFactor(
      { ...baseUser, totpConfirmedAt: null },
      "recovery",
      "abcd-efgh",
    );
    expect(res.ok).toBe(false);
    expect(verifyAndConsumeRecoveryCode).not.toHaveBeenCalled();
  });

  it("accepts a recovery code once the factor is confirmed", async () => {
    const res = await verifyMfaFactor(
      { ...baseUser, totpConfirmedAt: new Date() },
      "recovery",
      "abcd-efgh",
    );
    expect(res.ok).toBe(true);
  });
});
