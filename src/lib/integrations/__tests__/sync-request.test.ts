/**
 * The manual-sync trigger body tells its three cases apart.
 *
 * Before this helper, all four provider sync routes shared one `try { … }
 * catch { /* no body provided -> default incremental sync *\/ }` block, and the
 * comment was true for only one of the three ways to reach it. A body that was
 * present and unparseable, and a body carrying `"fullSync": "true"` as a
 * string, both came out as `fullSync = false` with a 200 — so a client that
 * asked for full history and got the type wrong was told the incremental run it
 * never requested had succeeded.
 *
 * The absent-body case is load-bearing in the other direction: it is the
 * documented shape and the tests below pin it, so tightening the wrong two
 * cases cannot take it with them.
 */
import { describe, it, expect } from "vitest";

import { readSyncTriggerBody } from "../sync-request";

function req(body?: BodyInit, contentType = "application/json"): Request {
  return new Request("http://localhost/api/whoop/sync", {
    method: "POST",
    headers: { "Content-Type": contentType },
    ...(body === undefined ? {} : { body }),
  });
}

async function envelope(res: Response) {
  return (await res.json()) as {
    data: null;
    error: string;
    details?: { issues?: unknown[] };
  };
}

describe("readSyncTriggerBody", () => {
  it("reads an absent body as an incremental run", async () => {
    const out = await readSyncTriggerBody(req());
    expect(out.error).toBeUndefined();
    expect(out.fullSync).toBe(false);
  });

  it("reads a whitespace-only body as an incremental run", async () => {
    const out = await readSyncTriggerBody(req("\n"));
    expect(out.error).toBeUndefined();
    expect(out.fullSync).toBe(false);
  });

  it("reads an empty object as an incremental run", async () => {
    const out = await readSyncTriggerBody(req("{}"));
    expect(out.error).toBeUndefined();
    expect(out.fullSync).toBe(false);
  });

  it("honours an explicit fullSync: true", async () => {
    const out = await readSyncTriggerBody(
      req(JSON.stringify({ fullSync: true })),
    );
    expect(out.error).toBeUndefined();
    expect(out.fullSync).toBe(true);
  });

  it("honours an explicit fullSync: false", async () => {
    const out = await readSyncTriggerBody(
      req(JSON.stringify({ fullSync: false })),
    );
    expect(out.error).toBeUndefined();
    expect(out.fullSync).toBe(false);
  });

  it("ignores unknown keys rather than refusing them", async () => {
    const out = await readSyncTriggerBody(
      req(JSON.stringify({ fullSync: true, since: "2026-01-01" })),
    );
    expect(out.error).toBeUndefined();
    expect(out.fullSync).toBe(true);
  });

  it("refuses a present-but-unparseable body with 400", async () => {
    const out = await readSyncTriggerBody(req("{ fullSync: true"));
    expect(out.fullSync).toBeUndefined();
    expect(out.error?.status).toBe(400);
    expect((await envelope(out.error!)).error).toBe("Invalid JSON body");
  });

  /**
   * The case the old catch-all hid: a string where a boolean belongs used to
   * read as "the user asked for an incremental sync", and the 200 said so.
   */
  it("refuses a string fullSync with 422 rather than reading it as false", async () => {
    const out = await readSyncTriggerBody(
      req(JSON.stringify({ fullSync: "true" })),
    );
    expect(out.fullSync).toBeUndefined();
    expect(out.error?.status).toBe(422);
    const body = await envelope(out.error!);
    expect(body.error).toBe("Validation failed");
    expect(body.details?.issues?.length).toBeGreaterThan(0);
  });

  it("refuses a JSON scalar body with 422", async () => {
    const out = await readSyncTriggerBody(req("null"));
    expect(out.fullSync).toBeUndefined();
    expect(out.error?.status).toBe(422);
  });

  it("refuses a body over the 64 KiB cap with 413", async () => {
    const out = await readSyncTriggerBody(
      req(JSON.stringify({ fullSync: true, pad: "x".repeat(70 * 1024) })),
    );
    expect(out.fullSync).toBeUndefined();
    expect(out.error?.status).toBe(413);
  });
});
