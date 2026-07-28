/**
 * MCP Phase 3 (M2) — mcp-token-cleanup queue registration guard.
 *
 * Source-text-grep guard like the other queue-wiring checks: assert the queue
 * is in `allQueues`, scheduled, and wired to a `createAndWork` handler. An
 * unregistered queue silently never drains (the recurring v1.4.37 dead-queue
 * bug), which would leave expired MCP connector access tokens growing unbounded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-maintenance.ts",
);
const workerSource =
  readFileSync(REGISTRAR_PATH, "utf8") +
  readFileSync(
    join(__dirname, "..", "reminder", "cleanup-handlers.ts"),
    "utf8",
  );

describe("reminder-worker — mcp-token-cleanup wiring", () => {
  it("imports the cleanup handler from the cleanup-handlers module", () => {
    expect(workerSource).toMatch(/\bhandleMcpTokenCleanup\b/);
    expect(workerSource).toMatch(/\bMcpTokenCleanupPayload\b/);
  });

  it("registers the mcp-token-cleanup queue in the allQueues loop", () => {
    const allQueuesMatch = workerSource.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bMCP_TOKEN_CLEANUP_QUEUE\b/);
  });

  it("schedules the mcp-token-cleanup cron", () => {
    expect(workerSource).toMatch(
      /\[MCP_TOKEN_CLEANUP_QUEUE,\s*MCP_TOKEN_CLEANUP_CRON,\s*cronIsTheRetry\]/,
    );
  });

  it("registers a createAndWork handler for the queue", () => {
    expect(workerSource).toMatch(
      /createAndWork[\s\S]{0,200}MCP_TOKEN_CLEANUP_QUEUE[\s\S]{0,200}handleMcpTokenCleanup/,
    );
  });

  it("prunes MCP tokens inside the handler", () => {
    expect(workerSource).toMatch(
      /handleMcpTokenCleanup[\s\S]{0,400}cleanupExpiredMcpTokens/,
    );
  });
});
