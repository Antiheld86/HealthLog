import { describe, expect, it } from "vitest";

import {
  codeForUpstreamStatus,
  testFailureDetail,
  testFailureSentence,
} from "@/lib/notifications/test-delivery-failure";

describe("codeForUpstreamStatus", () => {
  it.each([
    [400, "upstream_rejected"],
    [401, "credentials_rejected"],
    [403, "credentials_rejected"],
    [404, "endpoint_not_found"],
    [405, "upstream_rejected"],
    [409, "upstream_rejected"],
    [410, "endpoint_not_found"],
    [413, "upstream_rejected"],
    [415, "upstream_rejected"],
    [422, "upstream_rejected"],
    [429, "rate_limited"],
    [500, "upstream_error"],
    [502, "upstream_error"],
    [301, "redirected"],
    [308, "redirected"],
  ])("%i → %s", (status, code) => {
    expect(codeForUpstreamStatus(status)).toBe(code);
  });
});

describe("testFailureDetail", () => {
  it("prefers the HTTP status over any transport code", () => {
    expect(
      testFailureDetail({
        ok: false,
        statusCode: 400,
        failureCode: "timeout",
        upstreamBody: "bad",
      }),
    ).toEqual({
      errorCode: "upstream_rejected",
      upstreamStatus: 400,
      upstreamBody: "bad",
    });
  });

  it("uses the sender's code when there is no status", () => {
    expect(
      testFailureDetail({
        ok: false,
        failureCode: "upstream_rejected",
        smtpCode: 550,
      }),
    ).toEqual({ errorCode: "upstream_rejected", smtpCode: 550 });
  });

  it("names nothing for an unnamed failure", () => {
    expect(testFailureDetail({ ok: false, reason: "x" })).toEqual({});
  });
});

describe("testFailureSentence", () => {
  it("states the status, and falls back to a plain sentence for an unlisted code", () => {
    expect(
      testFailureSentence("The webhook", {
        errorCode: "upstream_rejected",
        upstreamStatus: 400,
      }),
    ).toBe("The webhook answered HTTP 400.");
    expect(
      testFailureSentence("The webhook", { errorCode: "something_new" }),
    ).toBe("The webhook test failed.");
  });
});
