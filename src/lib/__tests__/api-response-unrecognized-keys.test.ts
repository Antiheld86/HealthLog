/**
 * The user-visible half of a strict schema.
 *
 * A 422 that says only "Validation failed" costs the caller a debugging
 * session it should not have to run: it knows the body was refused and
 * not which field did it. Zod puts the offending names in `issue.keys`
 * and leaves `issue.path` empty, so a sanitiser that reads `path` alone
 * emits `{ path: "", code: "unrecognized_keys" }` and names nothing.
 *
 * The other half is that a key name is caller-controlled input. Zod's
 * own message echoes it verbatim and unbounded, and that message reaches
 * the client, the wide event, and — through the `stripValuesFromMessage`
 * call sites — the audit ledger. So the name is bounded and character-
 * restricted before it is rendered, and the message is rebuilt from the
 * sanitised names rather than passed through.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";

import { returnAllZodIssues, sanitiseZodIssues } from "../api-response";

const schema = z
  .object({
    measuredAt: z.string(),
    value: z.number(),
  })
  .strict();

function issuesFor(body: Record<string, unknown>) {
  const parsed = schema.safeParse(body);
  if (parsed.success) throw new Error("expected the parse to fail");
  return parsed.error;
}

describe("sanitiseZodIssues — unrecognized_keys", () => {
  it("names the offending key in both the message and a structured field", () => {
    const error = issuesFor({
      measuredAt: "2026-01-01",
      value: 80,
      measuredAtt: "2026-01-01",
    });

    const [issue] = sanitiseZodIssues(error.issues);
    expect(issue.code).toBe("unrecognized_keys");
    expect(issue.keys).toEqual(["measuredAtt"]);
    expect(issue.message).toBe('Unrecognized key: "measuredAtt"');
  });

  it("names every offending key when a body carries several", () => {
    const error = issuesFor({
      measuredAt: "2026-01-01",
      value: 80,
      measuredAtt: "x",
      unitt: "kg",
    });

    const [issue] = sanitiseZodIssues(error.issues);
    expect(issue.keys).toEqual(["measuredAtt", "unitt"]);
    expect(issue.message).toBe('Unrecognized keys: "measuredAtt", "unitt"');
  });

  it("does not echo a hostile key name back verbatim", () => {
    const error = issuesFor({
      measuredAt: "2026-01-01",
      value: 80,
      "<img src=x onerror=alert(1)>": 1,
    });

    const [issue] = sanitiseZodIssues(error.issues);
    expect(issue.keys?.[0]).not.toContain("<");
    expect(issue.keys?.[0]).not.toContain(">");
    expect(issue.message).not.toContain("<img");
    // The shape still survives, so the caller can still recognise its
    // own key — only the characters that could be read as markup go.
    expect(issue.keys?.[0]).toBe("_img_src_x_onerror_alert_1__");
  });

  it("bounds the length of a single key name", () => {
    const error = issuesFor({
      measuredAt: "2026-01-01",
      value: 80,
      [`over${"x".repeat(500)}`]: 1,
    });

    const [issue] = sanitiseZodIssues(error.issues);
    expect(issue.keys?.[0]).toHaveLength(64);
    expect(issue.message.length).toBeLessThan(120);
  });

  it("bounds how many key names one issue reports", () => {
    const body: Record<string, unknown> = {
      measuredAt: "2026-01-01",
      value: 80,
    };
    for (let i = 0; i < 40; i += 1) body[`extra${i}`] = i;

    const [issue] = sanitiseZodIssues(issuesFor(body).issues);
    expect(issue.keys).toHaveLength(10);
  });

  it("keeps the key names under stripValuesFromMessage", () => {
    // The opt-in exists to keep user-typed VALUES out of the audit
    // ledger. A key name is structure, not a value, so dropping it too
    // would leave an operator with a row that says a body was refused
    // and nothing about why.
    const error = issuesFor({
      measuredAt: "2026-01-01",
      value: 80,
      measuredAtt: "x",
    });

    const [issue] = sanitiseZodIssues(error.issues, {
      stripValuesFromMessage: true,
    });
    expect(issue).toEqual({
      path: "",
      code: "unrecognized_keys",
      keys: ["measuredAtt"],
    });
    expect(issue).not.toHaveProperty("message");
  });

  it("leaves every other issue code untouched", () => {
    const parsed = schema.safeParse({ measuredAt: "2026-01-01" });
    if (parsed.success) throw new Error("expected the parse to fail");

    const [issue] = sanitiseZodIssues(parsed.error.issues);
    expect(issue.code).toBe("invalid_type");
    expect(issue.path).toBe("value");
    expect(issue).not.toHaveProperty("keys");
  });

  it("reports the nested object's own path when the strict object is nested", () => {
    const nested = z
      .object({ prefs: z.object({ enabled: z.boolean() }).strict() })
      .strict();
    const parsed = nested.safeParse({ prefs: { enabled: true, enabledd: 1 } });
    if (parsed.success) throw new Error("expected the parse to fail");

    const [issue] = sanitiseZodIssues(parsed.error.issues);
    expect(issue.path).toBe("prefs");
    expect(issue.keys).toEqual(["enabledd"]);
  });
});

describe("returnAllZodIssues — unrecognized_keys over the wire", () => {
  it("answers 422 and names the key in the response envelope", async () => {
    const error = issuesFor({
      measuredAt: "2026-01-01",
      value: 80,
      measuredAtt: "x",
    });

    const response = returnAllZodIssues(error);
    expect(response.status).toBe(422);

    const body = (await response.json()) as {
      data: null;
      error: string;
      details: {
        issues: Array<{
          path: string;
          code: string;
          message: string;
          keys?: string[];
        }>;
      };
    };
    expect(body.data).toBeNull();
    expect(body.error).toBe("Validation failed");
    expect(body.details.issues).toEqual([
      {
        path: "",
        code: "unrecognized_keys",
        message: 'Unrecognized key: "measuredAtt"',
        keys: ["measuredAtt"],
      },
    ]);
  });
});
