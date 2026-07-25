/**
 * v1.11.0 — clinician share-token resolver (Epic C, C3 — the security core).
 *
 * The ONE entry that turns a raw `hls_` share token into a scoped read context.
 * It is deliberately NOT an authentication primitive:
 *
 *   - It returns a {@link ShareContext} that carries ONLY the owner `userId`
 *     (plus the frozen scope). It is NOT an `AuthContext`/session and can never
 *     stand in for one.
 *   - It never calls `getSession` / `authenticateBearer` and never sets a
 *     cookie. A share token can authenticate exactly one surface — the public
 *     clinician view (`/c/[token]`) and, when enabled, its scoped FHIR face —
 *     and nothing else.
 *   - The token arrives ONLY via the `X-HealthLog-Share` request header. It is
 *     never read from `Authorization: Bearer`; presenting it on a normal authed
 *     route does nothing (that route's `requireAuth` ignores this header).
 *
 * Resolution is blunt on failure: an unknown / revoked / expired / malformed
 * token resolves to `null`, and the caller answers a flat 404 so a probe cannot
 * distinguish "no such link" from "revoked" from "expired" — share-link ids are
 * unguessable and enumeration buys nothing.
 *
 * On a successful resolve the access counters (`accessCount`, `lastAccessAt`)
 * are bumped fire-and-forget; a counter write never blocks or fails the read.
 */
import { hashToken } from "@/lib/auth/hmac";
import { prisma } from "@/lib/db";

/** The `hls_<48 hex>` shape the lifecycle route mints (192-bit body). */
export const SHARE_TOKEN_PATTERN = /^hls_[0-9a-f]{48}$/;

/**
 * The scoped read context a resolved share token yields. It is intentionally a
 * distinct, minimal type — NOT an `AuthContext` — so it cannot be passed where
 * a session is expected. It carries only what the data aggregator needs to
 * scope a read to the owner, plus the frozen sharing scope the view honours.
 */
export interface ShareContext {
  /** The share-link row id (for audit / annotate; never user-facing). */
  shareLinkId: string;
  /** The OWNER whose data this link exposes — the only identity it carries. */
  ownerUserId: string;
  /** Owner-set label (e.g. a clinic note). Plaintext, bounded. */
  label: string;
  /** Frozen reporting-window start (absolute ISO instant). */
  rangeStart: Date;
  /** Window end; `null` = rolling ("up to now"). */
  rangeEnd: Date | null;
  /** Frozen section toggles (the `DoctorReportPrefs` JSON shape). */
  sectionsJson: unknown;
  /**
   * v1.28.16 — authoritative documents-only flag, frozen at create. When true
   * the view loader serves ONLY documents and never aggregates a health report,
   * regardless of `sectionsJson`. Legacy links minted before the column read
   * `false` here and fall back to the derived all-sections-off check.
   */
  documentOnly: boolean;
  /** Absolute expiry instant. */
  expiresAt: Date;
}

/**
 * Resolve a raw `hls_` token to a {@link ShareContext}, or `null` when the
 * token is malformed, unknown, revoked, or expired.
 *
 * This is the single trust boundary for the share surface. It never reads or
 * writes a session and never mints a cookie; it only proves "this raw token
 * hashes to a live, in-window share link" and returns the owner scope.
 */
export async function resolveShareToken(
  rawToken: string | null | undefined,
): Promise<ShareContext | null> {
  if (!rawToken || !SHARE_TOKEN_PATTERN.test(rawToken)) return null;

  // Hash with the same HMAC scheme the lifecycle route stored — never compare
  // plaintext. A non-matching hash simply finds no row.
  const tokenHash = hashToken(rawToken);

  const row = await prisma.clinicianShareLink.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      userId: true,
      label: true,
      rangeStart: true,
      rangeEnd: true,
      sectionsJson: true,
      documentOnly: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (!row) return null;
  // Revoked and expired both collapse to the same blunt null → 404.
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;

  // Fire-and-forget access bump — a counter write must never block or fail the
  // read. (`void` the promise; swallow any error.)
  void prisma.clinicianShareLink
    .update({
      where: { id: row.id },
      data: { accessCount: { increment: 1 }, lastAccessAt: new Date() },
    })
    .catch(() => {
      /* counter is best-effort; never surface a write failure to the reader */
    });

  return {
    shareLinkId: row.id,
    ownerUserId: row.userId,
    label: row.label,
    rangeStart: row.rangeStart,
    rangeEnd: row.rangeEnd,
    sectionsJson: row.sectionsJson,
    documentOnly: row.documentOnly,
    expiresAt: row.expiresAt,
  };
}

/**
 * v1.18.7 — the live-gate state for a raw token, WITHOUT bumping access
 * counters. Used by the public page (decide gate vs render) and the unlock
 * route (verify a passphrase). It deliberately resolves a malformed / unknown /
 * revoked / expired token to `null` — the same blunt nothing the view returns —
 * so the unlock surface leaks no more than the page does. It carries the stored
 * `passphraseHash` and the `tokenHash` (for cookie scoping + rate-limit keying)
 * but never the owner scope; the full read still flows through
 * {@link resolveShareToken}.
 */
export interface ShareGateState {
  tokenHash: string;
  /** `null` for a legacy link minted before the passphrase gate. */
  passphraseHash: string | null;
}

export async function resolveShareGateState(
  rawToken: string | null | undefined,
): Promise<ShareGateState | null> {
  if (!rawToken || !SHARE_TOKEN_PATTERN.test(rawToken)) return null;
  const tokenHash = hashToken(rawToken);
  const row = await prisma.clinicianShareLink.findUnique({
    where: { tokenHash },
    select: { passphraseHash: true, revokedAt: true, expiresAt: true },
  });
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  return { tokenHash, passphraseHash: row.passphraseHash };
}
