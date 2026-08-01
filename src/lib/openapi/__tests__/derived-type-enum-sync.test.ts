/**
 * The `type` query parameter on `GET /api/insights/derived` sub-targets the
 * single measurement type a baseline metric works over. Two engines define
 * one: `VITALS_BASELINE` over a vital, `SAME_TIME_BASELINE` over a cumulative
 * day metric. For most of a year the published enum carried the vitals alone,
 * so a spec-conformant client could not send the four same-time types at all
 * (iOS #75).
 *
 * This guard asserts the published parameter enumerates exactly the union of
 * the two registry sets, read out of the assembled OpenAPI document rather
 * than out of the schema module — the same object the generator writes to
 * `docs/api/openapi.yaml`, so a value that reaches the registry but not the
 * contract fails here.
 */
import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "../registry";
import {
  VITALS_BASELINE_TYPES,
  SAME_TIME_BASELINE_TYPES,
} from "@/lib/insights/derived/registry";

/** Pull the `type` query parameter's enum out of the assembled document. */
function publishedTypeEnum(): string[] {
  const doc = buildOpenApiDocument() as {
    paths?: Record<
      string,
      { get?: { parameters?: unknown[]; requestParams?: unknown } }
    >;
  };
  const operation = doc.paths?.["/api/insights/derived"]?.get;
  expect(
    operation,
    "GET /api/insights/derived is missing from the document",
  ).toBeDefined();

  const parameters = (operation?.parameters ?? []) as Array<{
    name?: string;
    in?: string;
    schema?: { enum?: string[] };
  }>;
  const typeParam = parameters.find(
    (p) => p.name === "type" && p.in === "query",
  );
  expect(typeParam, "the `type` query parameter is missing").toBeDefined();

  const values = typeParam?.schema?.enum;
  expect(Array.isArray(values), "`type` is not published as an enum").toBe(
    true,
  );
  return values as string[];
}

describe("derived `type` parameter stays in sync with the registry", () => {
  it("publishes exactly the union of the two baseline type sets", () => {
    const expected = [
      ...VITALS_BASELINE_TYPES,
      ...SAME_TIME_BASELINE_TYPES,
    ].map(String);

    expect([...publishedTypeEnum()].sort()).toEqual([...expected].sort());
  });

  it("publishes every same-time baseline type", () => {
    // Named separately: this is the half that was missing, and a regression
    // here is the one a client feels immediately (a 422-shaped dead end on
    // a value the server accepts).
    const published = publishedTypeEnum();
    for (const type of SAME_TIME_BASELINE_TYPES) {
      expect(published).toContain(String(type));
    }
  });
});
