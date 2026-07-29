/**
 * MCP scope model.
 *
 * The MCP wire reuses the existing `hlk_<hex>` Bearer tokens as its auth
 * substrate (no parallel identity system). Two scope handles frame the
 * least-privilege contract:
 *
 *   - `health:read`  — read the user's own health data. The default MCP posture.
 *   - `health:write` — mutate (log a measurement / intake / mood). Required by
 *     the write tools, which ARE registered and live (see `write-tools.ts`).
 *
 * Read tools impose no scope requirement of their own: every underlying read
 * path is already an unscoped authenticated route, so a narrow-scope token works
 * and a wildcard token is never required (REQ-SEC-5). The "read-only by default"
 * posture (REQ-SEC-1 / ADR-003) is preserved by the scope gate, not by omitting
 * the write surface: write tools are registered but only reachable when the
 * presented token carries `health:write` (or the wildcard), enforced through
 * `tokenAllowsWrite` — a token without it sees the read surface alone.
 */

/** Wildcard scope — grants every capability the token model can express. */
export const SCOPE_WILDCARD = "*";

/** Read the authenticated user's own health data over MCP. */
export const SCOPE_HEALTH_READ = "health:read";

/** Mutate the authenticated user's data over MCP (gates the live write tools). */
export const SCOPE_HEALTH_WRITE = "health:write";

/**
 * Whether a token's scopes admit the read surface. Reads require the explicit
 * `health:read` grant or the wildcard; write and unrelated grants never imply
 * read access.
 */
export function tokenAllowsRead(permissions: readonly string[]): boolean {
  return (
    permissions.includes(SCOPE_WILDCARD) ||
    permissions.includes(SCOPE_HEALTH_READ)
  );
}

/**
 * Whether a token's scopes admit the write surface. A token must carry the
 * explicit `health:write` scope (or the wildcard). Used to decide whether write
 * tools are registered for a session.
 */
export function tokenAllowsWrite(permissions: readonly string[]): boolean {
  return (
    permissions.includes(SCOPE_WILDCARD) ||
    permissions.includes(SCOPE_HEALTH_WRITE)
  );
}

/**
 * The `<user_id>:<token_id>` binding (REQ-SEC-11). Identifies a session by the
 * user AND the specific token presented — never the user alone — so audit,
 * annotation, and (later phases) rate-limit buckets are keyed to the credential
 * actually in use.
 */
export function sessionBinding(userId: string, tokenId: string): string {
  return `${userId}:${tokenId}`;
}
