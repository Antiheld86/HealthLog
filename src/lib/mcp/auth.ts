/**
 * MCP auth context.
 *
 * Resolves a pasted `hlk_<hex>` Bearer token to a session-narrowed identity for
 * the MCP transports. Authentication is delegated to the canonical
 * `resolveBearerToken` (`@/lib/auth/bearer`) — the SAME validation the HTTP edge
 * runs — so revoked / expired / scope semantics are identical across both wires
 * (REQ-T1, REQ-SEC-5).
 *
 * Security properties:
 *   - The id is narrowed to one `userId`; tools and resources feed it straight
 *     into the Prisma `where`, never accepting a caller-supplied user id.
 *   - The session is bound to `<user_id>:<token_id>` (REQ-SEC-11), never to a
 *     cookie session — the MCP wire carries no cookie.
 *   - Admin is unreachable by construction: `requireAdmin()` is cookie-only and
 *     this path never mints a cookie session, so no MCP context can elevate
 *     (REQ-SEC-7 / ADR-005). The guard test pins it.
 */
import { resolveBearerToken } from "@/lib/auth/bearer";
import { sessionBinding, tokenAllowsRead, tokenAllowsWrite } from "./scopes";

export interface McpAuthContext {
  /** The single user this session acts as. Feeds every Prisma `where`. */
  userId: string;
  /** The presented `ApiToken` id (the token half of the binding). */
  tokenId: string;
  /** The token's granted scopes. */
  scopes: string[];
  /** `<user_id>:<token_id>` — the session binding (REQ-SEC-11). */
  binding: string;
  /** Whether this session may read (requires `health:read` or wildcard). */
  canRead: boolean;
  /** Whether this session may write (requires `health:write`; gates the live write tools). */
  canWrite: boolean;
}

/**
 * Resolve a raw Bearer token into an `McpAuthContext`, or throw on an invalid /
 * revoked / expired token.
 *
 * This is the ONE deliberate `any-valid-token` posture in the tree: the `/mcp`
 * transport authenticates here and authorises downstream — audience binding
 * plus `tokenAllowsWrite` gate the write tools, so a scope check at this line
 * would be the wrong layer. A structural test asserts this call site stays the
 * only one, because every other wire must fail closed.
 */
export async function resolveMcpAuthContext(
  rawToken: string,
): Promise<McpAuthContext> {
  const trimmed = rawToken.trim();
  if (!trimmed) {
    throw new Error("Missing MCP Bearer token");
  }

  const { user, tokenId, permissions } = await resolveBearerToken(trimmed, {
    kind: "any-valid-token",
  });

  return {
    userId: user.id,
    tokenId,
    scopes: permissions,
    binding: sessionBinding(user.id, tokenId),
    canRead: tokenAllowsRead(permissions),
    canWrite: tokenAllowsWrite(permissions),
  };
}
