/**
 * Background work started inside a test must not outlive it.
 *
 * Several paths in this codebase start a promise, return without awaiting it,
 * and log on the detached handle so the failure is not swallowed. Vitest
 * replaces `globalThis.console` with a sink that forwards every write to the
 * main thread as an `onUserConsoleLog` RPC call, awaits the calls in flight
 * when it tears a test file down, and then REJECTS whatever was started after
 * that point. A detached write that lands in that window fails the whole run
 * with `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was
 * pending` — blamed on the file the worker was tearing down, which is not the
 * test that started the work and need not contain a console call of its own.
 *
 * Both suite setups therefore await `settleBackgroundTasks()` after every
 * test, and that only works while the detached paths keep registering what
 * they start.
 *
 * These are tripwires, not proofs. The sweep below matches a detached
 * `.catch()` / `.then()` whose handler writes to the console — the shape that
 * actually produced the failure. A background path that logs some other way,
 * or that logs from a callee rather than from the handler, is invisible to it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { walkSourceFiles } from "./helpers/source-files";
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import {
  pendingBackgroundTaskCount,
  settleBackgroundTasks,
  trackBackgroundTask,
} from "@/lib/logging/background-tasks";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/**
 * Detached console writers that deliberately stay unregistered.
 *
 * `cli/mcp-stdio.ts` is a process entrypoint: its `main().catch(...)` is the
 * top-level failure handler and there is no test that runs it, so there is
 * nothing for a registry to hold. `jobs/boss-instance.ts` awaits its handle —
 * the matcher sees the `console` call in the following lines, not a detached
 * promise.
 */
const UNREGISTERED_BY_DESIGN = new Set([
  "cli/mcp-stdio.ts",
  "lib/jobs/boss-instance.ts",
]);

/** Every non-test source file under `src/`, minus the generated Prisma client. */
function sourceFiles(): string[] {
  return walkSourceFiles(SRC, { floor: 3000 })
    .filter((rel) => !rel.startsWith("generated/"))
    .filter((rel) => !rel.includes("__tests__"))
    .filter((rel) => !rel.endsWith(".test.ts") && !rel.endsWith(".test.tsx"));
}

/** Lines starting a `.catch()` / `.then()` whose handler writes to the console. */
function consoleWritingHandlers(): { file: string; line: number }[] {
  const found: { file: string; line: number }[] = [];
  for (const rel of sourceFiles()) {
    const lines = readFileSync(join(SRC, rel), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!/\.(catch|then)\(/.test(line)) return;
      const handler = lines.slice(index, index + 8).join("\n");
      if (!/console\.(log|warn|error|info|debug|trace)\(/.test(handler)) return;
      found.push({ file: rel, line: index + 1 });
    });
  }
  return found;
}

describe("background-task settle contract", () => {
  it("registers an in-flight task and drains it on settle", async () => {
    let release: () => void = () => {};
    const task = new Promise<void>((resolve) => {
      release = resolve;
    });

    trackBackgroundTask(task);
    expect(pendingBackgroundTaskCount()).toBe(1);

    let settled = false;
    const settling = settleBackgroundTasks().then(() => {
      settled = true;
    });

    // Settle must not resolve ahead of the task it is waiting on — that is the
    // whole reason the registry exists.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    release();
    await settling;
    expect(settled).toBe(true);
    // And nothing is retained once the task is done.
    expect(pendingBackgroundTaskCount()).toBe(0);
  });

  it("registers what fireAndForget starts", async () => {
    let release: () => void = () => {};
    fireAndForget(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
      { action: "guard.background.registered" },
    );
    expect(pendingBackgroundTaskCount()).toBe(1);

    release();
    await settleBackgroundTasks();
    expect(pendingBackgroundTaskCount()).toBe(0);
  });

  it("also awaits work a settling task starts itself", async () => {
    let innerDone = false;

    fireAndForget(
      Promise.resolve().then(() => {
        fireAndForget(
          new Promise<void>((resolve) =>
            setTimeout(() => {
              innerDone = true;
              resolve();
            }, 10),
          ),
          { action: "guard.background.cascade.inner" },
        );
      }),
      { action: "guard.background.cascade.outer" },
    );

    await settleBackgroundTasks();
    expect(innerDone).toBe(true);
    expect(pendingBackgroundTaskCount()).toBe(0);
  });

  it("keeps every detached console writer registered", () => {
    const sites = consoleWritingHandlers();

    // An empty sweep must not read as a pass: if the matcher stops finding the
    // shape it is the matcher that broke, not the tree that got clean. Pinned
    // below the five sites that exist today, so removing one legitimately does
    // not trip a guard that is about the sweep being alive, not about freezing
    // a count.
    expect(sites.length).toBeGreaterThanOrEqual(3);

    const unregistered = sites.filter(({ file, line }) => {
      if (UNREGISTERED_BY_DESIGN.has(file)) return false;
      const lines = readFileSync(join(SRC, file), "utf8").split("\n");
      // The registration wraps the handle, so it opens on one of the few lines
      // above the `.catch(` / `.then(` the sweep matched.
      const preamble = lines.slice(Math.max(0, line - 5), line).join("\n");
      return !/trackBackgroundTask\(/.test(preamble);
    });

    expect(
      unregistered.map(({ file, line }) => `src/${file}:${line}`),
      "a detached promise logs to the console without registering — wrap the " +
        "handled handle in trackBackgroundTask() so the suite can await it",
    ).toEqual([]);
  });

  it("keeps the settle hook wired into both suite setups", () => {
    for (const setup of [
      "vitest.setup.ts",
      join("tests", "integration", "environment-setup.ts"),
    ]) {
      const source = readFileSync(join(ROOT, setup), "utf8");
      expect(
        source.includes("settleBackgroundTasks"),
        `${setup} no longer awaits background tasks after each test`,
      ).toBe(true);
    }
  });
});
