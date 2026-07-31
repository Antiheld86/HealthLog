/**
 * The server-cache registry must be shared across module instances.
 *
 * Next's App Router bundles a module that is imported from both a Server
 * Component and a route handler once PER LAYER. Both copies run in the same
 * process, but each gets its own module scope — so a registry held in plain
 * module state becomes two registries. Measured on a production build: the
 * dashboard RSC read its own copy while an intake / measurement write, which
 * runs in a route handler, evicted the other one. The home page then kept
 * serving the pre-write snapshot for the rest of the TTL.
 *
 * `globalThis` is the only scope both layers share, so the registry is parked
 * there under a `Symbol.for` slot. These tests pin that down from both sides:
 * the exported object IS the one on the global, and a second evaluation of the
 * module adopts the existing registry instead of building a fresh one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { caches } from "../server-cache";

const CACHES_GLOBAL_SLOT = Symbol.for("healthlog.serverCaches");

type GlobalWithCaches = typeof globalThis & {
  [CACHES_GLOBAL_SLOT]?: unknown;
};

describe("server cache registry is pinned to globalThis", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports the very object parked on the global slot", () => {
    const parked = (globalThis as GlobalWithCaches)[CACHES_GLOBAL_SLOT];
    expect(parked).toBeDefined();
    expect(caches).toBe(parked);
  });

  it("hands a second module evaluation the same registry", async () => {
    // `vi.resetModules()` makes the next import evaluate the module file
    // again, which is what a second bundler layer does in production.
    const reimported = await import("../server-cache");
    expect(reimported.caches).toBe(caches);
  });

  it("lets a write through one module instance reach the other", async () => {
    const reimported = await import("../server-cache");
    caches.analytics.__resetForTests();

    caches.analytics.set("pin-guard|probe", { seen: true });

    expect(reimported.caches.analytics.get("pin-guard|probe")).toEqual({
      seen: true,
    });

    reimported.caches.analytics.deleteByPrefix("pin-guard|");

    expect(caches.analytics.get("pin-guard|probe")).toBeNull();
  });
});
