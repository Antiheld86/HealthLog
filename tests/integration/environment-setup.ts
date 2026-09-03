import { afterEach, inject } from "vitest";

declare module "vitest" {
  export interface ProvidedContext {
    integrationDatabaseUrl: string;
  }
}

process.env.DATABASE_URL = inject("integrationDatabaseUrl");
process.env.ENCRYPTION_KEY =
  "0000000000000000000000000000000000000000000000000000000000000000";
delete process.env.ENCRYPTION_KEYS;
delete process.env.ENCRYPTION_ACTIVE_KEY_ID;
process.env.API_TOKEN_HMAC_KEY = "integration-test-hmac-key-32-bytes-minimum";
process.env.SESSION_SECRET = "integration-test-session-secret-32-bytes";

/**
 * Leave no background work in flight when an integration test ends — the same
 * contract the unit setup keeps, for the same reason: detached background work
 * logs on its own handle, and a console write that reaches vitest after the
 * worker has begun closing its RPC channel fails the run with
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`.
 * This suite has its own config and its own setup file, so the unit hook does
 * not cover it.
 *
 * The import is deferred: this file's whole job is to bridge DATABASE_URL into
 * the worker BEFORE any application module reads it at import time, and a
 * static import here would pull part of the application tree in first.
 */
afterEach(async () => {
  const { settleBackgroundTasks } =
    await import("@/lib/logging/background-tasks");
  await settleBackgroundTasks();
});
