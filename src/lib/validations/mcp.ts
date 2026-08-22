import { z } from "zod/v4";

/**
 * Body of `POST /api/mcp/tokens` — mint a connector Bearer for the manual /
 * stdio path.
 *
 * `scope` is a closed two-value choice, not a permission list: `read` maps to
 * `["health:read"]` and `read_write` adds `health:write`. The route builds the
 * `permissions` array from that choice field by field, so no request shape can
 * coerce this endpoint into minting a wildcard or any other grant.
 */
export const createMcpTokenSchema = z.object({
  name: z.string().min(1, "Name required").max(100),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  scope: z.enum(["read", "read_write"]).optional().default("read"),
});

export type CreateMcpTokenInput = z.infer<typeof createMcpTokenSchema>;
