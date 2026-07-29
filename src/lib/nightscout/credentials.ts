/**
 * Per-user Nightscout connection credentials (v1.17.0).
 *
 * Unlike WHOOP / Fitbit (OAuth, with a dedicated `*Connection` row), Nightscout
 * is a URL + token the user pastes once. Both are stored encrypted on `User`
 * (`nightscoutUrlEncrypted` / `nightscoutTokenEncrypted`) via the fail-closed
 * `*Encrypted` convention; the private-host opt-in is the plaintext boolean
 * `nightscoutAllowPrivateHost`. This helper is the single read+decrypt path the
 * sync + status + connect surfaces share.
 */
import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

export interface NightscoutCredentials {
  baseUrl: string;
  token: string;
  /** @deprecated Compatibility/display metadata; never egress authority. */
  allowPrivateHost: boolean;
}

/**
 * Fetch and decrypt the user's Nightscout connection. Returns null when the
 * URL is not configured (a token-less, fully-public instance still stores a
 * URL, so the URL is the configured-marker, not the token).
 */
export async function getUserNightscoutCredentials(
  userId: string,
): Promise<NightscoutCredentials | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      nightscoutUrlEncrypted: true,
      nightscoutTokenEncrypted: true,
      nightscoutAllowPrivateHost: true,
    },
  });

  if (!user?.nightscoutUrlEncrypted) return null;

  return {
    baseUrl: decrypt(user.nightscoutUrlEncrypted),
    token: user.nightscoutTokenEncrypted
      ? decrypt(user.nightscoutTokenEncrypted)
      : "",
    allowPrivateHost: user.nightscoutAllowPrivateHost,
  };
}
