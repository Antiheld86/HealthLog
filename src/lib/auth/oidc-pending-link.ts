/**
 * Linking a single sign-on identity to an account that already exists here.
 *
 * The SSO callback used to bind a verified IdP email to the local account with
 * the same address on the spot. The local address is NOT verified — anyone can
 * register with any address, and an account holder can type any address into
 * their profile — so whoever set that address first owned the account the
 * other person's SSO login landed in: they kept the password, and the SSO user
 * filled their health record into an account the other person could read.
 *
 * So the callback no longer links. It records what it WOULD link in a sealed,
 * short-lived, HttpOnly cookie and sends the browser to the sign-in page, and
 * the link is made only when that same browser then signs in to that same
 * account with the account's own credential — password (plus its second
 * factor, if it has one) or passkey. The IdP proved who the person is; the
 * local sign-in proves the account is theirs. Neither alone links anything.
 *
 * The cookie is AES-256-GCM sealed with the at-rest key (`encrypt`), so it can
 * be neither read nor forged, and it carries its own expiry. It is scoped to
 * `/api/auth`, the only place that reads it.
 */
import type { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { decrypt, encrypt } from "@/lib/crypto";
import { auditLog } from "@/lib/auth/audit";
import { annotate } from "@/lib/logging/context";
import { shouldEmitSecureCookie } from "@/lib/auth/secure-cookie";

export const OIDC_LINK_COOKIE = "hl_oidc_link";
export const OIDC_LINK_COOKIE_PATH = "/api/auth";
export const OIDC_LINK_TTL_MS = 10 * 60 * 1000;

export interface PendingOidcLink {
  userId: string;
  issuer: string;
  sub: string;
}

/** Attach the sealed pending link to a callback redirect. */
export function setPendingLinkCookie(
  response: NextResponse,
  link: PendingOidcLink,
): void {
  const sealed = encrypt(
    JSON.stringify({
      u: link.userId,
      i: link.issuer,
      s: link.sub,
      e: Date.now() + OIDC_LINK_TTL_MS,
    }),
  );
  response.cookies.set(OIDC_LINK_COOKIE, sealed, {
    httpOnly: true,
    secure: shouldEmitSecureCookie(),
    // Lax, not Strict: the browser arrives here from the IdP's redirect and
    // must carry it on the sign-in that follows. A cross-site POST cannot
    // carry it, and every reader is a JSON POST besides.
    sameSite: "lax",
    maxAge: Math.floor(OIDC_LINK_TTL_MS / 1000),
    path: OIDC_LINK_COOKIE_PATH,
  });
}

/** The pending link this browser carries, or null when absent, forged or expired. */
export async function readPendingLink(): Promise<PendingOidcLink | null> {
  let raw: string | undefined;
  try {
    raw = (await cookies()).get(OIDC_LINK_COOKIE)?.value;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(decrypt(raw)) as Record<string, unknown>;
    if (
      typeof parsed.u !== "string" ||
      typeof parsed.i !== "string" ||
      typeof parsed.s !== "string" ||
      typeof parsed.e !== "number" ||
      parsed.e <= Date.now()
    ) {
      return null;
    }
    return { userId: parsed.u, issuer: parsed.i, sub: parsed.s };
  } catch {
    return null;
  }
}

async function clearPendingLinkCookie(): Promise<void> {
  try {
    (await cookies()).set(OIDC_LINK_COOKIE, "", {
      httpOnly: true,
      secure: shouldEmitSecureCookie(),
      sameSite: "lax",
      maxAge: 0,
      path: OIDC_LINK_COOKIE_PATH,
    });
  } catch {
    // Outside a request scope there is no cookie to clear.
  }
}

/**
 * Called once a browser sign-in has proved the account's OWN credential.
 * Binds the pending SSO identity when the cookie names this very account and
 * the account is still unlinked. Never throws into the sign-in: a link that
 * cannot be made leaves the login intact and the account as it was.
 */
export async function completePendingOidcLink(
  userId: string,
  ipAddress: string | null,
): Promise<boolean> {
  const link = await readPendingLink();
  if (!link) return false;
  await clearPendingLinkCookie();
  if (link.userId !== userId) {
    annotate({ meta: { oidc_link: "other_account" } });
    return false;
  }
  try {
    const linked = await prisma.user.updateMany({
      where: { id: userId, oidcIssuer: null, oidcSub: null },
      data: { oidcIssuer: link.issuer, oidcSub: link.sub },
    });
    if (linked.count !== 1) {
      annotate({ meta: { oidc_link: "already_linked" } });
      return false;
    }
  } catch {
    // The (issuer, sub) pair became bound to another account in between.
    annotate({ meta: { oidc_link: "identity_taken" } });
    return false;
  }
  await auditLog("auth.oidc.linked", {
    userId,
    ipAddress,
    details: { confirmedBy: "local_sign_in" },
  });
  annotate({ action: { name: "auth.oidc.linked" } });
  return true;
}
