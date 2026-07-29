import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  nextStatusPollInterval,
  STATUS_POLL_MAX_ATTEMPTS,
} from "../use-insight-status";

/**
 * v1.8.4 — the preparing poll must stop after a bounded number of
 * attempts. A provider can be configured yet have generation fail
 * persistently; without a ceiling the status card polls an open page
 * forever (battery / network waste). `nextStatusPollInterval` is the
 * shared decision both the hook and the inline medication-compliance
 * query route through, so locking its contract covers both sites.
 */
describe("nextStatusPollInterval — v1.8.4 poll ceiling", () => {
  it("does not poll a terminal payload (preparing absent/false)", () => {
    expect(nextStatusPollInterval(undefined, 1)).toBe(false);
    expect(nextStatusPollInterval(false, 1)).toBe(false);
    // A terminal `no-provider` / settled payload never carries preparing,
    // so it stops immediately regardless of attempt count.
    expect(nextStatusPollInterval(false, 0)).toBe(false);
    // A settled payload with neither preparing nor revalidating is terminal.
    expect(nextStatusPollInterval(false, 0, false)).toBe(false);
    expect(nextStatusPollInterval(undefined, 0, undefined)).toBe(false);
  });

  it("keeps polling while preparing and below the cap", () => {
    expect(nextStatusPollInterval(true, 0)).toBeTypeOf("number");
    expect(nextStatusPollInterval(true, 1)).toBeTypeOf("number");
    expect(
      nextStatusPollInterval(true, STATUS_POLL_MAX_ATTEMPTS - 1),
    ).toBeTypeOf("number");
  });

  it("stops polling once the attempt cap is reached", () => {
    expect(nextStatusPollInterval(true, STATUS_POLL_MAX_ATTEMPTS)).toBe(false);
    expect(nextStatusPollInterval(true, STATUS_POLL_MAX_ATTEMPTS + 5)).toBe(
      false,
    );
  });

  it("returns a positive interval while it polls", () => {
    const interval = nextStatusPollInterval(true, 0);
    expect(interval).not.toBe(false);
    expect(interval as number).toBeGreaterThan(0);
  });

  // v1.9.0 — stale-while-revalidate: a terminal payload that serves last-good
  // text sets `revalidating` so the open card keeps polling until the
  // freshly-warmed assessment lands, without a remount.
  it("keeps polling on revalidating even when not preparing", () => {
    expect(nextStatusPollInterval(false, 0, true)).toBeTypeOf("number");
    expect(nextStatusPollInterval(undefined, 1, true)).toBeTypeOf("number");
    expect(
      nextStatusPollInterval(false, STATUS_POLL_MAX_ATTEMPTS - 1, true),
    ).toBeTypeOf("number");
  });

  it("honours the same attempt cap for revalidating", () => {
    expect(nextStatusPollInterval(false, STATUS_POLL_MAX_ATTEMPTS, true)).toBe(
      false,
    );
    expect(
      nextStatusPollInterval(false, STATUS_POLL_MAX_ATTEMPTS + 5, true),
    ).toBe(false);
  });

  it("exposes poll exhaustion as a terminal state instead of leaving preparing true forever", () => {
    const source = readFileSync(
      join(process.cwd(), "src", "hooks", "use-insight-status.ts"),
      "utf8",
    );

    // Stopping the timer is only half of the contract. Once the ceiling is
    // reached, callers must be able to distinguish an exhausted attempt from
    // an actively preparing response and must not keep painting the preparing
    // skeleton forever.
    expect(source).toContain("pollExhausted");
    expect(source).toMatch(/preparing:\s*false/);
  });
});
