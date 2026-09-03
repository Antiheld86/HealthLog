/**
 * Unit-test setup.
 *
 * Seed the client-side locale cache with every message bundle. In
 * production only EN ships statically; the active locale arrives as an
 * RSC prop from the root layout and other locales load via dynamic
 * import on switch (see `src/lib/i18n/load-locale.ts`). Tests mount
 * `I18nProvider` standalone — often with `renderToStaticMarkup`, which
 * is synchronous and cannot await a dynamic import — so the cache is
 * primed up front and `t()` resolves every locale on the first render,
 * exactly like the server-handoff path does in the app.
 */
import { afterEach } from "vitest";
import { settleBackgroundTasks } from "@/lib/logging/background-tasks";
import { primeMessages } from "@/lib/i18n/load-locale";
import deMessages from "./messages/de.json";
import enMessages from "./messages/en.json";
import esMessages from "./messages/es.json";
import frMessages from "./messages/fr.json";
import itMessages from "./messages/it.json";
import plMessages from "./messages/pl.json";
import koMessages from "./messages/ko.json";

primeMessages("de", deMessages);
primeMessages("en", enMessages);
primeMessages("es", esMessages);
primeMessages("fr", frMessages);
primeMessages("it", itMessages);
primeMessages("pl", plMessages);
primeMessages("ko", koMessages);

/**
 * Leave no background work in flight when a test ends.
 *
 * Several paths start a promise, return without awaiting it, and log on the
 * detached handle so the failure is not swallowed. Vitest forwards every
 * console write to the main thread as an `onUserConsoleLog` RPC call and
 * rejects whatever is still pending on that channel while it tears a test file
 * down, so a write that lands in that window fails the whole run with
 * `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending`
 * — blamed on the file the worker was tearing down, which is not the test that
 * started the work and need not log anything of its own. Awaiting the
 * registered tasks here removes the precondition instead of muting the
 * console, which would have thrown away a real signal and left the
 * non-determinism in place. See `src/lib/logging/background-tasks.ts`.
 */
afterEach(async () => {
  await settleBackgroundTasks();
});
