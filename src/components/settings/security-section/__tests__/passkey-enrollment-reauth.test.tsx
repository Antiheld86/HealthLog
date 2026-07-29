/**
 * SEC-05 / SEC-08 — Add-passkey reauthentication UX contract.
 *
 * This repository intentionally keeps component tests SSR/source-oriented
 * rather than installing a browser DOM harness. The ordering assertions below
 * are security assertions: the existing-factor step must finish before the
 * first registration challenge is requested, so cancellation or failure
 * cannot leave an enrollable server challenge behind.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(__dirname, "../passkey-list-section.tsx"),
  "utf8",
);

function firstIndex(...needles: RegExp[]): number {
  const indexes = needles
    .map((needle) => source.search(needle))
    .filter((index) => index >= 0);
  return indexes.length === 0 ? -1 : Math.min(...indexes);
}

describe("<PasskeyListSection> enrollment reauthentication", () => {
  it("offers every supported existing factor without a bypass", () => {
    expect(source).toMatch(/["']password["']/);
    expect(source).toMatch(/["']passkey["']/);
    expect(source).toMatch(/["']totp["']/);
    expect(source).toMatch(/["']webauthn["']/);

    expect(source).not.toMatch(/skipReauth|bypassReauth|allowBearer/i);
    expect(source).not.toContain("x-step-up");
    expect(source).not.toContain("Authorization");
  });

  it("finishes fresh-factor proof before requesting registration options", () => {
    const proof = firstIndex(/reauth/i, /existingFactor/, /freshFactor/);
    const options = source.indexOf('"/api/auth/passkey/register-options"');

    expect(proof).toBeGreaterThanOrEqual(0);
    expect(options).toBeGreaterThan(proof);
  });

  it("keeps one cookie-bound ceremony from proof through registration verify", () => {
    const options = source.indexOf('"/api/auth/passkey/register-options"');
    const browserRegistration = source.indexOf("startRegistration", options);
    const verify = source.indexOf(
      '"/api/auth/passkey/register-verify"',
      browserRegistration,
    );

    expect(options).toBeGreaterThanOrEqual(0);
    expect(browserRegistration).toBeGreaterThan(options);
    expect(verify).toBeGreaterThan(browserRegistration);
    expect(source).toMatch(/challengeId[\s\S]*credential/);
  });
});
