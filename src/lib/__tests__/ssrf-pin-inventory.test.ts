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
 * The LOCAL AI client and (since v1.37.30) the openai-client's gateway and
 * admin-key tags are the deliberate exceptions: an operator can grant a LAN
 * endpoint. Since v1.39.3 the grant is an exact origin (`AI_PRIVATE_ORIGINS`,
 * or the legacy host list) and the call is dialled through the pinned
 * operator-approved dispatcher, never unpinned; the whole policy comes from
 * `aiEgressPolicyFor`. We assert every AI dial site spreads that policy, and
 * that neither an unconditional `false` (no pin) nor a local
 * `isLocalAiHostAllowed` decision (a grant with no pin) reappears there.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("SSRF requirePublicHost pin inventory", () => {
  // v1.37.30 — openai-client is no longer a blanket pin: the gateway and
  // admin-key tags carry a person-typed base URL and route through the
  // operator allowlist helper, with `true` as the ternary floor for every
  // other tag (codex). We assert the exact conditional shape so a future
  // edit can neither drop the floor nor widen the condition silently.
  it("openai-client routes person-typed base URLs through the allowlist with a pinned floor", () => {
    const src = read("ai/openai-client.ts");
    expect(src).toMatch(
      /this\.isGateway \|\| this\.type === "admin-key"\s*\?\s*aiEgressPolicyFor\(url,\s*\{\s*operatorTrusted:\s*this\.config\.operatorTrusted,?\s*\}\)\s*:\s*\{\s*requirePublicHost:\s*true as const\s*\}/,
    );
    expect(src).not.toMatch(/requirePublicHost:\s*false/);
  });

  it("anthropic-client pins the BYO base-URL outbound unconditionally", () => {
    expect(read("ai/anthropic-client.ts")).toMatch(/requirePublicHost:\s*true/);
  });

  it("geo lookup pins the operator IP_GEO_LOOKUP_URL outbound", () => {
    expect(read("geo.ts")).toMatch(/requirePublicHost:\s*true/);
  });

  it("Nightscout routes exact operator-approved private origins through the private pin", () => {
    const src = read("nightscout/client.ts");
    expect(src).toMatch(
      /operatorApprovedPrivateOrigin:\s*policy\.canonicalOrigin/,
    );
    expect(src).toMatch(/requirePublicHost:\s*!policy\.privateOriginApproved/);
    expect(src).not.toMatch(
      /operatorApprovedPrivateOrigin:\s*opts\.allowPrivateHost/,
    );
  });

  // v1.11.2 locked the ntfy pin as an unconditional `true`. Since #947 both
  // user-supplied notification targets carry the same conditional shape as
  // Nightscout: the public pin unless the operator listed the exact origin
  // in NOTIFICATION_PRIVATE_ORIGINS, in which case the operator-approved pin
  // takes over. Neither a bare `true` (the grant would be dead) nor a bare
  // `false` (the pin would be gone) may reappear.
  it.each([
    ["webhook", "notifications/senders/webhook.ts"],
    ["ntfy", "notifications/senders/ntfy.ts"],
  ])(
    "%s sender routes an exact operator-approved private origin through the private pin",
    (_channel, rel) => {
      const src = read(rel);
      expect(src).toMatch(
        /requirePublicHost:\s*!policy\.privateOriginApproved/,
      );
      expect(src).toMatch(
        /operatorApprovedPrivateOrigin:\s*policy\.canonicalOrigin/,
      );
      expect(src).not.toMatch(/requirePublicHost:\s*(?:true|false)\b/);
      // The verdict must come from the shared policy, never a local check.
      expect(src).toMatch(/evaluateNotificationTarget\(/);
    },
  );

  it("local AI client dials every call through the shared egress policy", () => {
    const src = read("ai/local-client.ts");
    // Both the buffered and the streaming call derive the policy …
    expect([
      ...src.matchAll(
        /const egress = aiEgressPolicyFor\(url,\s*\{\s*operatorTrusted:\s*this\.config\.operatorTrusted,?\s*\}\)/g,
      ),
    ]).toHaveLength(2);
    // … and spread it into safeFetch …
    expect([...src.matchAll(/\.\.\.egress,/g)]).toHaveLength(2);
    // … with no local decision beside it: no hard-coded pin value (true
    // would break a granted LAN model, false would drop the pin) and no
    // grant check that could skip the operator-approved dispatcher.
    expect(src).not.toMatch(/requirePublicHost:\s*(?:true|false|!)/);
    expect(src).not.toMatch(/isLocalAiHostAllowed\(/);
  });
});
