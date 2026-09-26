/**
 * TOTP and security-key enrollment ask for a fresh proof when the server says
 * so (401 `auth.reproof.required`), and retry the SAME enrollment call with it.
 *
 * Source-oriented like the passkey reauth test next door: the repository keeps
 * component tests free of a browser DOM harness. The behavioural half — that
 * the server refuses without the proof — is pinned against Postgres in
 * `tests/integration/credential-enrollment-proof.test.ts`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-fetch";
import { isReproofRequired } from "../existing-factor-reauth-dialog";

const read = (file: string) =>
  readFileSync(resolve(__dirname, "..", file), "utf8");

describe("isReproofRequired", () => {
  it("recognises only the re-proof refusal", () => {
    expect(
      isReproofRequired(
        new ApiError("x", 401, { errorCode: "auth.reproof.required" }),
      ),
    ).toBe(true);
    expect(
      isReproofRequired(
        new ApiError("x", 401, { errorCode: "auth.reproof.failed" }),
      ),
    ).toBe(false);
    expect(
      isReproofRequired(
        new ApiError("x", 401, { errorCode: "auth.stepup.required" }),
      ),
    ).toBe(false);
    expect(isReproofRequired(new Error("x"))).toBe(false);
  });
});

describe.each([
  ["totp-card.tsx", '"/api/auth/me/mfa/totp/setup"', "beginSetup"],
  [
    "security-keys-card.tsx",
    '"/api/auth/me/mfa/webauthn/register/options"',
    "add",
  ],
])("%s", (file, endpoint, mutation) => {
  const source = read(file);

  it("sends the collected proof on the enrollment call itself", () => {
    expect(source).toContain(endpoint);
    expect(source).toMatch(
      new RegExp(`${endpoint.replace(/[/.]/g, "\\$&")},\\s*proof\\)`),
    );
  });

  it("opens the re-proof dialog on the server's cue and retries with the proof", () => {
    expect(source).toContain("isReproofRequired(err)");
    expect(source).toContain("setReauthOpen(true)");
    expect(source).toContain(`onProof={(proof) => ${mutation}.mutate(proof)}`);
  });
});
