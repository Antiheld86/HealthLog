/**
 * The error classes live in ONE leaf module — the cycle stays broken.
 *
 * `api-handler.ts` imports the record-session fence, and the fence throws
 * `RecordSessionChangedError` / `SharingAccessDeniedError`. When those
 * classes lived inside api-handler the two modules imported each other and
 * the loop worked only by evaluation-order luck. This guard pins the split:
 *
 *   1. identity — the class an importer gets from `api-handler` IS the class
 *      the fence throws (from `api-errors`), so `instanceof` across the two
 *      import paths can never diverge;
 *   2. structure — the fence carries no VALUE import from api-handler
 *      (a type-only import is erased and allowed), and the leaf imports
 *      nothing but the fence contract.
 *
 * Watched red: re-declaring `HttpError` inside api-handler (the pre-split
 * shape) fails the identity leg; adding a value import of api-handler back
 * into the fence fails the structural leg.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import * as apiErrors from "@/lib/api-errors";
import {
  HttpError,
  RecordSessionChangedError,
  SharingAccessDeniedError,
  SharingAuthError,
  SharingNotPermittedError,
  StepUpRequiredError,
} from "@/lib/api-handler";

const SRC = join(__dirname, "..");

describe("api-errors leaf module", () => {
  it("api-handler re-exports the identical class objects", () => {
    expect(HttpError).toBe(apiErrors.HttpError);
    expect(SharingAuthError).toBe(apiErrors.SharingAuthError);
    expect(SharingAccessDeniedError).toBe(apiErrors.SharingAccessDeniedError);
    expect(SharingNotPermittedError).toBe(apiErrors.SharingNotPermittedError);
    expect(RecordSessionChangedError).toBe(apiErrors.RecordSessionChangedError);
    expect(StepUpRequiredError).toBe(apiErrors.StepUpRequiredError);
  });

  it("the record-session fence carries no value import from api-handler", () => {
    const source = readFileSync(
      join(SRC, "lib/sharing/record-session-fence.ts"),
      "utf8",
    );
    const imports = source.match(/^import[^;]+from "@\/lib\/api-handler";/gms);
    for (const statement of imports ?? []) {
      expect(
        statement.startsWith("import type"),
        `record-session-fence.ts imports a VALUE from api-handler — that is the cycle the api-errors leaf removed:\n${statement}`,
      ).toBe(true);
    }
  });

  it("the leaf imports nothing but the fence contract", () => {
    const source = readFileSync(join(SRC, "lib/api-errors.ts"), "utf8");
    const imports = source.match(/^import[^;]+;/gms) ?? [];
    // Self-check: the walker found the one expected import.
    expect(imports.length).toBeGreaterThan(0);
    for (const statement of imports) {
      expect(
        statement.includes("record-session-fence-contract"),
        `api-errors.ts must stay a leaf; unexpected import:\n${statement}`,
      ).toBe(true);
    }
  });
});
