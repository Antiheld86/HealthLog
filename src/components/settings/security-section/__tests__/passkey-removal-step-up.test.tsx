/**
 * The removal's refusal has to say something true, in the person's language.
 *
 * `DELETE /api/auth/passkeys/{id}` is step-up gated now, and the server answers
 * 401 with `meta.errorCode: auth.stepup.required` and the prose "Recent
 * second-factor verification required". Rendering that prose would have been
 * wrong twice over: it is English regardless of the operator's locale, and for
 * the passkey-only account this card mostly serves there is no second factor —
 * the credential to re-prove is the passkey itself.
 *
 * So the card maps the refusal to its own sentence. Pinned here:
 *   1. a step-up refusal renders the card's sentence, not the server's prose,
 *   2. the mfa_not_enrolled arm maps too — both codes mean "the gate stopped
 *      you", and handling only the first falls through to raw English,
 *   3. an ordinary failure still shows its own message rather than being
 *      swallowed by the step-up sentence,
 *   4. the sentence resolves in more than one locale,
 *   5. the sentence names the recovery the web actually has. The mint endpoint
 *      is Bearer-only by design, so there is no in-page re-proof dialog for a
 *      cookie session; signing in again is the recovery, and a passkey login
 *      stamps `mfaVerifiedAt`. If that ever changes, this assertion is the
 *      reminder that the copy has to change with it.
 *
 * Mutation check: return `err.message` from the removal's `onError` and cases 1,
 * 2 and 4 go red; narrow `describeStepUp` to the exact `auth.stepup.required`
 * code and case 2 goes red; drop the fallback arm and case 3 goes red.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ApiError } from "@/lib/api/api-fetch";
import { describeStepUp } from "../security-keys-card";
import en from "@/../messages/en.json";
import de from "@/../messages/de.json";

const STEP_UP_SENTENCE = en.settings.passkeyStepUpRequired;

function refusal(errorCode: string): ApiError {
  return new ApiError("Recent second-factor verification required", 401, {
    errorCode,
  });
}

describe("passkey removal — the step-up refusal a person sees", () => {
  it("replaces the server's prose on a step-up refusal", () => {
    const shown = describeStepUp(
      refusal("auth.stepup.required"),
      "fallback",
      STEP_UP_SENTENCE,
    );

    expect(shown).toBe(STEP_UP_SENTENCE);
    expect(shown).not.toContain("second-factor verification required");
  });

  it("maps the not-enrolled arm too", () => {
    expect(
      describeStepUp(
        refusal("auth.stepup.mfa_not_enrolled"),
        "fallback",
        STEP_UP_SENTENCE,
      ),
    ).toBe(STEP_UP_SENTENCE);
  });

  it("leaves an ordinary refusal saying its own thing", () => {
    const lastMethod = new ApiError(
      "Cannot delete — at least one authentication method must remain",
      400,
    );

    expect(describeStepUp(lastMethod, "fallback", STEP_UP_SENTENCE)).toContain(
      "at least one authentication method",
    );
  });

  it("carries the sentence in every locale the app offers", () => {
    // The EN↔DE pair is the smoke test; `i18n-locale-integrity.test.ts` holds
    // the other four to the same guarantee.
    expect(de.settings.passkeyStepUpRequired).toBeTruthy();
    expect(de.settings.passkeyStepUpRequired).not.toBe(
      en.settings.passkeyStepUpRequired,
    );
  });

  it("names the recovery the web actually has", () => {
    // Not "verify to continue": there is no in-page re-proof for a cookie
    // session, because the elevation mint is Bearer-only by design. Signing in
    // again is the recovery, and a passkey login stamps the session.
    expect(STEP_UP_SENTENCE.toLowerCase()).toContain("sign in again");
  });

  it("routes the removal through the mapper rather than the raw message", () => {
    const source = readFileSync(
      resolve(__dirname, "../passkey-list-section.tsx"),
      "utf8",
    );
    // Bounded by the next top-level declaration rather than by the first
    // `});`, which lands inside `mutationFn` and would slice the handler away.
    const start = source.indexOf("const remove = useMutation");
    const end = source.indexOf("const DEVICE_TYPE_LABELS", start);
    expect(start, "the removal mutation was renamed").toBeGreaterThan(-1);
    expect(end, "the slice's end anchor is gone").toBeGreaterThan(start);
    const body = source.slice(start, end);

    expect(body).toContain("describeStepUp");
    expect(body).toContain("settings.passkeyStepUpRequired");
  });
});
