/**
 * v1.11.2 — SSRF DNS-rebinding pin inventory.
 *
 * Source-text guard (same approach as the queue-registration + coach-gate
 * inventory tests): the outbound `safeFetch` sites whose host is user- or
 * operator-controlled MUST pass `requirePublicHost: true`, which wires both
 * the input-time `isPublicUrl` check and the connect-time DNS-rebinding pin.
 * A future edit that drops the pin (re-opening the SSRF surface) fails here
 * instead of shipping silently.
 *
 * The LOCAL AI client is the deliberate exception: it stays CONDITIONAL
 * (`requirePublicHost: !allowPrivate`) so an operator can opt into LAN hosts
 * via `ALLOW_LOCAL_AI_PRIVATE_HOSTS`. v1.18.7 (SECURITY LOW) — that flag is
 * now a host ALLOWLIST (`true` = any private host; a comma-separated list =
 * only those), resolved by `isLocalAiHostAllowed`. We assert the client keeps
 * the conditional shape AND derives `allowPrivate` from the allowlist helper
 * (not a raw `=== "true"` binary), never an unconditional `true` (which would
 * break LAN local models) and never absent (which would re-open the default).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("SSRF requirePublicHost pin inventory", () => {
  it("openai-client pins the BYO base-URL outbound unconditionally", () => {
    expect(read("ai/openai-client.ts")).toMatch(/requirePublicHost:\s*true/);
  });

  it("anthropic-client pins the BYO base-URL outbound unconditionally", () => {
    expect(read("ai/anthropic-client.ts")).toMatch(/requirePublicHost:\s*true/);
  });

  it("geo lookup pins the operator IP_GEO_LOOKUP_URL outbound", () => {
    expect(read("geo.ts")).toMatch(/requirePublicHost:\s*true/);
  });

  // v1.11.2 product-lead M2 (optional) — lock the PRE-EXISTING user/operator
  // webhook pins too, so the full inventory is CI-guarded and a future edit
  // that drops one of these reds here rather than shipping silently.
  it("ntfy sender pins the user/operator-supplied server outbound", () => {
    expect(read("notifications/senders/ntfy.ts")).toMatch(
      /requirePublicHost:\s*true/,
    );
  });

  it("local AI client keeps the pin CONDITIONAL (LAN escape hatch)", () => {
    const src = read("ai/local-client.ts");
    // Must carry the conditional form …
    expect(src).toMatch(/requirePublicHost:\s*!?\s*allowPrivate/);
    // … and must NOT be hardened to an unconditional true (that would break
    // a deliberately-private LAN local model).
    expect(src).not.toMatch(/requirePublicHost:\s*true/);
    // … and `allowPrivate` must come from the host-allowlist helper, not a
    // raw binary `=== "true"` (v1.18.7 — the flag became an allowlist).
    expect(src).toMatch(/allowPrivate\s*=\s*isLocalAiHostAllowed\(/);
    expect(src).not.toMatch(/ALLOW_LOCAL_AI_PRIVATE_HOSTS\s*===\s*"true"/);
  });
});
