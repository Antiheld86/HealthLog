import { describe, expect, it } from "vitest";

import { coachPaths } from "../routes/coach";

describe("anamnesis fact mutation OpenAPI contracts", () => {
  it("documents the DELETE revision token, success metadata, and public errors", () => {
    const operation = coachPaths["/api/anamnesis/facts/{id}"]?.delete;

    expect(operation).toBeDefined();
    expect(operation).toMatchObject({
      summary: "Remove a current anamnesis fact",
      parameters: [
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Metadata for the revision whose interval was closed.",
        },
        "401": expect.any(Object),
        "404": expect.any(Object),
        "409": expect.any(Object),
      },
    });
  });

  it("documents POST's existing-current conflict", () => {
    const operation = coachPaths["/api/anamnesis/facts"]?.post;

    expect(operation?.responses).toMatchObject({
      "201": expect.any(Object),
      "409": {
        description: expect.stringContaining("anamnesis.fact.currentExists"),
      },
    });
  });

  it("documents PATCH's missing-target and revision-race responses", () => {
    const operation = coachPaths["/api/anamnesis/facts/{id}"]?.patch;

    expect(operation?.responses).toMatchObject({
      "200": expect.any(Object),
      "404": expect.any(Object),
      "409": {
        description: expect.stringContaining("anamnesis.fact.conflict"),
      },
    });
  });
});
