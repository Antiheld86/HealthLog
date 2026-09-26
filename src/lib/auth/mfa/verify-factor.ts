/**
 * Verify a presented second factor (TOTP or recovery code) for a user, with
 * the side effects that make each factor single-use:
 *
 * - **TOTP:** decrypt the stored secret (fail-closed), validate with ±1 drift
 *   and monotonic replay rejection, and on success **persist the accepted
 *   time-step** so the same code cannot be replayed within its 30-second life.
 * - **Recovery code:** Argon2id-verify against the unused set and burn the
 *   matched row.
 *
 * Used by the login-completion route (`/api/auth/mfa/verify`), the Bearer
 * step-up mint, the step-up-gated MFA-disable route and the credential
 * re-proof in `existing-factor-proof.ts`, so the factor semantics are
 * identical wherever a current factor must be proven.
 *
 * **Only a CONFIRMED secret is a factor.** `/me/mfa/totp/setup` writes a
 * pending secret for anyone holding the session, so a code from a secret
 * whose `totpConfirmedAt` is still null proves only that the caller started
 * an enrollment — never that they hold a factor the account owner set up.
 * Accepting it would let a stolen session mint its own "second factor" and
 * spend it on every gate this function guards. Recovery codes follow the same
 * rule: they exist only for a confirmed factor, and are refused otherwise.
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { verifyTotp } from "@/lib/auth/mfa/totp";
import { verifyAndConsumeRecoveryCode } from "@/lib/auth/mfa/recovery-codes";

export type MfaMethod = "totp" | "recovery";

export interface FactorUser {
  id: string;
  totpSecretEncrypted: string | null;
  totpLastStep: bigint | null;
  /** Null while the secret is a pending enrollment — not yet a factor. */
  totpConfirmedAt: Date | null;
}

export interface FactorResult {
  ok: boolean;
  /** TOTP only: the code matched the secret but its step was already used. */
  replay: boolean;
}

export async function verifyMfaFactor(
  user: FactorUser,
  method: MfaMethod,
  code: string,
): Promise<FactorResult> {
  // A pending secret is not a factor, and recovery codes only ever belong to a
  // confirmed one. Refuse both before any code is evaluated or step burned.
  if (!user.totpConfirmedAt) return { ok: false, replay: false };

  if (method === "recovery") {
    const ok = await verifyAndConsumeRecoveryCode(user.id, code);
    return { ok, replay: false };
  }

  // TOTP.
  if (!user.totpSecretEncrypted) return { ok: false, replay: false };
  const secret = decrypt(user.totpSecretEncrypted);
  const result = verifyTotp(
    secret,
    code,
    user.totpLastStep === null ? null : Number(user.totpLastStep),
  );
  if (!result.valid) {
    return { ok: false, replay: result.replay };
  }

  // Burn the step: persist it as the new floor so a replay of this exact
  // code (still inside its 30-second window) is rejected. The guarded WHERE
  // (`totpLastStep` unchanged) makes two concurrent accepts of the same step
  // race-safe — only the first transitions the counter.
  const advanced = await prisma.user.updateMany({
    where: {
      id: user.id,
      OR: [
        { totpLastStep: null },
        { totpLastStep: { lt: BigInt(result.step as number) } },
      ],
    },
    data: { totpLastStep: BigInt(result.step as number) },
  });
  if (advanced.count !== 1) {
    // Another request already consumed this (or a newer) step — treat as a
    // replay rather than a fresh accept.
    return { ok: false, replay: true };
  }
  return { ok: true, replay: false };
}
