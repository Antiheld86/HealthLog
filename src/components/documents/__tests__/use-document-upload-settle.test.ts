/**
 * The upload manager's settle decision (§3.2 + the fresh-upload flash).
 *
 * Watched red: with `settleDecision` returning `flashId: null` on the
 * non-duplicate branch (the pre-v1.37.19 behaviour — only the duplicate
 * path flashed the row), the fresh-upload case below fails. A fresh upload
 * used to give no feedback beyond its queue row disappearing.
 */
import { describe, expect, it } from "vitest";

import { settleDecision } from "../use-document-upload";
import type { UploadResult } from "../vault-utils";

function success(duplicate: boolean): UploadResult {
  return {
    ok: true,
    duplicate,
    document: { id: "doc-1" },
  } as unknown as UploadResult;
}

describe("settleDecision", () => {
  it("flashes the NEW row on a fresh upload (no toast)", () => {
    expect(settleDecision(success(false))).toEqual({
      removeFromQueue: true,
      toastDuplicate: false,
      flashId: "doc-1",
    });
  });

  it("flashes the EXISTING row and toasts on a duplicate", () => {
    expect(settleDecision(success(true))).toEqual({
      removeFromQueue: true,
      toastDuplicate: true,
      flashId: "doc-1",
    });
  });

  it("keeps a failed upload in the queue with no flash", () => {
    expect(
      settleDecision({ ok: false, reason: "generic" } as UploadResult),
    ).toEqual({ removeFromQueue: false, toastDuplicate: false, flashId: null });
  });
});
