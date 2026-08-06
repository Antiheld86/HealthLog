import { describe, expect, it } from "vitest";
import { isRecordPreloadReady } from "@/components/providers";
import {
  __resetRecordScopeForTests,
  setRecordScope,
  setRefusedRecordScope,
} from "@/lib/query-keys/record-scope";

describe("isRecordPreloadReady", () => {
  it("waits for the account response before warming record reads", () => {
    __resetRecordScopeForTests();

    expect(
      isRecordPreloadReady({ isLoading: true, accountAccessStatus: "valid" }),
    ).toBe(false);
    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: undefined,
      }),
    ).toBe(false);
  });

  it("accepts only a resolved own-record response with an own-record scope", () => {
    __resetRecordScopeForTests();
    setRecordScope(null);

    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "valid",
        activeAccountId: null,
      }),
    ).toBe(true);

    setRecordScope("shared-record");
    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "valid",
        activeAccountId: null,
      }),
    ).toBe(false);
  });

  it("accepts a shared-record response only after its exact scope is mirrored", () => {
    __resetRecordScopeForTests();
    setRecordScope("shared-record");

    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "valid",
        activeAccountId: "shared-record",
      }),
    ).toBe(true);

    setRecordScope(null);
    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "valid",
        activeAccountId: "shared-record",
      }),
    ).toBe(false);
  });

  it("never opens a preload window for an explicitly refused record", () => {
    __resetRecordScopeForTests();
    setRefusedRecordScope();

    expect(
      isRecordPreloadReady({
        isLoading: false,
        accountAccessStatus: "invalid",
        activeAccountId: null,
      }),
    ).toBe(false);
  });
});
