/**
 * HealthLog MCP server — barrel.
 *
 * A read-only-by-default Model Context Protocol surface that exposes
 * HealthLog's existing server-authoritative read paths over the MCP wire, so a
 * user can query their own health data from any MCP-capable assistant. The tool
 * / resource layer under this directory is transport-agnostic; transports
 * attach to `createMcpServer(ctx)`.
 *
 * The barrel carries only what the remote `/mcp` transport route needs. The
 * tool, resource, prompt and write registries are imported from their concrete
 * module by `./server` and by their own tests — mirroring them here produced
 * lines nothing imported.
 */
export { createMcpServer } from "./server";
export { resolveMcpAuthContext } from "./auth";
export { SCOPE_HEALTH_READ } from "./scopes";
