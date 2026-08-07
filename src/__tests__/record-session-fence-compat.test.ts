/**
 * FENCE-AC-10 — the only recovery a pre-fence browser tab has, frozen.
 *
 * A tab open at deploy time that is inside or after a shared-record context
 * sends no fence header, so the server refuses it with 403
 * `sharing.access.denied`. That is not an arbitrary choice of code: it is the
 * one code the CURRENTLY DEPLOYED bundle already acts on. `SharedRecordGrantLossBridge`
 * is mounted globally, subscribes to the whole query cache, and on the first
 * errored query carrying that code leaves the record and performs a full
 * document navigation — which serves the fence-aware bundle. One reload,
 * self-healing, no new code in a bundle nobody can edit any more.
 *
 * Every link in that chain is load-bearing and every one of them looks
 * removable to somebody tidying up. So each is asserted here, with a non-zero
 * match first, and the reason written down.
 *
 * The fourth leg is the opposite assertion and matters as much: the 409
 * `sharing.session.changed` must NOT be in the set the grant-loss bridge fires
 * on. That code means "reconcile, do not leave"; routing it into a bridge that
 * hard-navigates out of the record would turn a one-frame hold into an
 * eviction, and would let one confused tab yank every other tab of the same
 * browser out of a record nobody revoked.
 *
 * Break it by adding `sharing.session.changed` to the bridge's predicate.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

function read(rel: string): string {
  return readFileSync(join(SRC, rel), "utf8");
}

const SWITCH_HOOK = read("hooks/use-account-switch.ts");
const PROVIDERS = read("components/providers.tsx");
const GRANT_LOSS_BRIDGE = read(
  "components/layout/shared-record-grant-loss-bridge.tsx",
);
const FENCE_BRIDGE = read("components/layout/record-session-fence-bridge.tsx");

describe("FENCE-AC-10 a pre-fence tab can still recover", () => {
  it("FENCE-AC-10 still keys the grant-loss predicate on sharing.access.denied", () => {
    // Non-zero proof first: an emptied file would satisfy a bare `toContain`
    // check on nothing.
    expect(SWITCH_HOOK.length).toBeGreaterThan(1000);
    expect(SWITCH_HOOK).toMatch(
      /SHARING_ACCESS_DENIED\s*=\s*"sharing\.access\.denied"/,
    );
    expect(SWITCH_HOOK).toMatch(
      /export function isSharingAccessDenied[\s\S]{0,200}SHARING_ACCESS_DENIED/,
    );
  });

  it("FENCE-AC-10 still mounts the grant-loss bridge globally", () => {
    expect(PROVIDERS).toContain("SharedRecordGrantLossBridge");
    expect(PROVIDERS).toMatch(/<SharedRecordGrantLossBridge\s*\/>/);
    // And the bridge still subscribes rather than asking call sites.
    expect(GRANT_LOSS_BRIDGE).toContain("subscribeToGrantLoss");
    expect(SWITCH_HOOK).toMatch(
      /subscribeToGrantLoss[\s\S]{0,600}isSharingAccessDenied\(event\.query\.state\.error\)/,
    );
  });

  it("FENCE-AC-10 still leaves the record with a full document navigation", () => {
    // `router.push` would not do: a soft navigation keeps the in-memory cache,
    // every React tree holding a rendered value, and — critically here — the
    // PRE-FENCE JavaScript bundle. The reload is what serves the new one.
    expect(SWITCH_HOOK).toMatch(
      /async function landOnRecord[\s\S]{0,400}window\.location\.assign\(destination\)/,
    );
    expect(SWITCH_HOOK).toMatch(
      /useLeaveSharedRecordOnGrantLoss[\s\S]{0,700}await landOnRecord\(\)/,
    );
  });

  it("FENCE-AC-10 does NOT route the 409 into the grant-loss bridge", () => {
    // The predicate the bridge fires on.
    const predicate = /subscribeToGrantLoss\(([\s\S]*?)\n\}/.exec(SWITCH_HOOK);
    expect(predicate).not.toBeNull();
    const body = predicate![1];
    expect(body.length).toBeGreaterThan(50);
    expect(body).toContain("isSharingAccessDenied");
    expect(body).not.toContain("isRecordSessionChanged");
    expect(body).not.toContain("sharing.session.changed");
    // The grant-loss bridge component itself must not learn about it either.
    expect(GRANT_LOSS_BRIDGE).not.toContain("sharing.session.changed");
    expect(GRANT_LOSS_BRIDGE).not.toContain("isRecordSessionChanged");
  });

  it("FENCE-AC-10 routes the 409 into a reconciling bridge instead", () => {
    // The positive control for the leg above: without it, "the 409 is not in
    // the grant-loss bridge" would pass for a release that dropped the 409
    // handling altogether.
    expect(PROVIDERS).toMatch(/<RecordSessionFenceBridge\s*\/>/);
    expect(FENCE_BRIDGE).toContain("isRecordSessionChanged");
    expect(FENCE_BRIDGE).toContain("holdForRecordSessionReconcile");
    expect(FENCE_BRIDGE).toContain("onRecordFenceMismatch");
    // It reconciles; it does not leave.
    expect(FENCE_BRIDGE).not.toContain("landOnRecord");
    expect(FENCE_BRIDGE).not.toContain("window.location.assign");
  });

  it("FENCE-AC-10 keeps the two codes distinct at the source", () => {
    expect(SWITCH_HOOK).toMatch(
      /SHARING_SESSION_CHANGED\s*=\s*"sharing\.session\.changed"/,
    );
    expect(SWITCH_HOOK).toMatch(
      /export function isRecordSessionChanged[\s\S]{0,200}SHARING_SESSION_CHANGED/,
    );
  });
});

describe("FENCE-AC-10 the browser adopts a context from exactly two responses", () => {
  it("FENCE-AC-10 has exactly two callers of adoptRecordFenceState", () => {
    // A third adoption path would be a third source of truth about which
    // record this browser is on — and it would arrive on the very responses
    // whose context is in doubt. The 409 body therefore carries an error code
    // and nothing else, by construction.
    const CONSUMERS = [
      // `GET /api/auth/me`, the bootstrap.
      "hooks/use-auth.ts",
      // `POST /api/account/switch`, the only other canonical resolver.
      "hooks/use-account-switch.ts",
    ];

    const callers = CONSUMERS.filter((rel) =>
      /adoptRecordFenceState\(/.test(read(rel)),
    );
    expect(callers).toEqual(CONSUMERS);

    // And no third file calls it. The declaring module is allowed to name it.
    for (const rel of [
      "components/layout/record-session-fence-bridge.tsx",
      "components/layout/shared-record-grant-loss-bridge.tsx",
      "lib/api/api-fetch.ts",
    ]) {
      expect(read(rel)).not.toContain("adoptRecordFenceState");
    }
  });

  it("FENCE-AC-10 adopts before it releases a hold", () => {
    // A hold released onto an unadopted context puts the shell back on screen
    // while every subsequent request still asserts `bootstrap`.
    const src = read("hooks/use-auth.ts");
    const adopt = src.indexOf("adoptRecordFenceState(data.recordSession)");
    const settle = src.indexOf("settleRecordSessionTransition(");
    const scope = src.indexOf("setRecordScope(");
    expect(adopt).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(-1);
    expect(adopt).toBeLessThan(scope);
    expect(adopt).toBeLessThan(settle);
  });

  it("FENCE-AC-10 names the epoch on every switch", () => {
    // A fence-aware client never omits `expectedEpoch`; the server's
    // unconditional arm is reachable only by a bundle that predates the fence.
    expect(SWITCH_HOOK).toMatch(
      /apiPost<SwitchResponse>\([\s\S]{0,200}expectedEpoch:/,
    );
  });
});

describe("FENCE-AC-10 the transport attaches the assertion, not the call sites", () => {
  it("FENCE-AC-10 wraps all three fetch entries", () => {
    const src = read("lib/api/api-fetch.ts");
    const wraps = [...src.matchAll(/withRecordFenceHeaders\(/g)];
    const validates = [...src.matchAll(/validateResponseContext\(/g)];
    // Three entries: `apiFetch`, `apiFetchEnvelope`, `apiFetchRaw`. The raw one
    // matters most — ~25 call sites including the Coach SSE stream, several of
    // which are record traffic.
    expect(wraps.length).toBe(3);
    expect(validates.length).toBe(3);
    expect(src).toMatch(
      /export async function apiFetchRaw[\s\S]{0,900}withRecordFenceHeaders\(init\)/,
    );
  });

  it("FENCE-AC-10 imports the header names from the client-safe contract only", () => {
    // Importing the server fence or the acting carrier would pull `next/headers`
    // or Prisma into the browser bundle: clean typecheck, failed `pnpm build`.
    const src = read("lib/api/record-fence.ts");
    expect(src).toContain('from "@/lib/sharing/record-session-fence-contract"');
    expect(src).not.toContain('from "@/lib/sharing/record-session-fence"');
    expect(src).not.toContain('from "@/lib/auth/acting-carrier"');
    expect(src).not.toContain('from "@/lib/api-handler"');
    expect(src).not.toContain('from "@/lib/db"');
  });
});
