import { describe, it, expect } from "vitest";

import {
  tokenAllowsRead,
  tokenAllowsWrite,
  SCOPE_HEALTH_READ,
  SCOPE_HEALTH_WRITE,
  SCOPE_WILDCARD,
} from "../scopes";

describe("tokenAllowsRead", () => {
  it.each([
    ["health:read", [SCOPE_HEALTH_READ]],
    ["wildcard", [SCOPE_WILDCARD]],
    ["read plus write", [SCOPE_HEALTH_READ, SCOPE_HEALTH_WRITE]],
  ])("admits an explicit %s grant", (_label, permissions) => {
    expect(tokenAllowsRead(permissions)).toBe(true);
  });

  it.each([
    ["write-only", [SCOPE_HEALTH_WRITE]],
    ["medication ingest", ["medication:ingest"]],
    ["notifications", ["notifications:send"]],
    ["FHIR", ["fhir:read"]],
    ["unrelated", ["profile:read"]],
    ["empty", []],
  ])("refuses a %s scope set", (_label, permissions) => {
    expect(tokenAllowsRead(permissions)).toBe(false);
  });
});

describe("tokenAllowsWrite", () => {
  it("is false for a read-only token", () => {
    expect(tokenAllowsWrite([SCOPE_HEALTH_READ])).toBe(false);
  });
  it("is true for a read+write token", () => {
    expect(tokenAllowsWrite([SCOPE_HEALTH_READ, SCOPE_HEALTH_WRITE])).toBe(
      true,
    );
  });
  it("is true for the wildcard token", () => {
    expect(tokenAllowsWrite([SCOPE_WILDCARD])).toBe(true);
  });
  it("is false for an empty scope set", () => {
    expect(tokenAllowsWrite([])).toBe(false);
  });
});
