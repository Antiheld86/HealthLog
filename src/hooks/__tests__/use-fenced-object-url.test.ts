/**
 * Reaching a fenced route from the DOM without a headerless request.
 *
 * Two properties, both of which go wrong quietly:
 *
 *   * the bytes travel through the app transport, so the request carries the
 *     record-session assertion. A plain `fetch` here would reintroduce the
 *     exact class `record-fence-headerless-transport-guard.test.ts` exists to
 *     catch, and nothing visible would change until somebody entered a shared
 *     record;
 *   * every object URL is revoked. Getting that wrong leaks a decrypted health
 *     document into the tab for as long as the tab lives, and the UI never
 *     shows it. The hard case is a response that lands after the caller has
 *     moved on — a fast scroll through the vault timeline changes the path far
 *     more often than the network answers.
 *
 * The unit suite runs in `node` with no DOM, so the React hook cannot be
 * rendered here. That is why the lifecycle rule lives in
 * `createFencedBlobLoader` rather than inside the effect: an untested
 * revocation rule is exactly the kind that is wrong.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createFencedBlobLoader } from "@/hooks/use-fenced-object-url";
import {
  __resetRecordFenceForTests,
  adoptRecordFenceState,
} from "@/lib/api/record-fence";

const created: string[] = [];
const revoked: string[] = [];
let counter = 0;

/** A deferred blob response, so a load can be left in flight deliberately. */
function pendingResponse() {
  let settle!: () => void;
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    settle,
    fetch: vi.fn(async () => {
      await gate;
      return new Response(new Blob(["bytes"]));
    }),
  };
}

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  counter = 0;
  __resetRecordFenceForTests();
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => {
      const url = `blob:mock/${counter++}`;
      created.push(url);
      return url;
    }),
    revokeObjectURL: vi.fn((url: string) => {
      revoked.push(url);
    }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetRecordFenceForTests();
});

describe("createFencedBlobLoader", () => {
  it("carries the record-session assertion on the request", async () => {
    adoptRecordFenceState({ epoch: 4, scope: "owner-1" });
    const fetchMock = vi.fn(async () => new Response(new Blob(["bytes"])));
    vi.stubGlobal("fetch", fetchMock);

    await createFencedBlobLoader().load(
      "/api/documents/inbound/doc-1/thumbnail",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = new Headers(init.headers);
    // The whole point: a browser-issued `<img src>` cannot send these, which is
    // why the bytes come through the transport instead.
    expect(headers.get("x-healthlog-record-epoch")).toBe("4");
    expect(headers.get("x-healthlog-record-scope")).toBe("owner-1");
  });

  it("hands back an object URL once the blob lands", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["bytes"]))),
    );

    const result = await createFencedBlobLoader().load("/api/x/y");

    expect(result).toEqual({ kind: "loaded", url: "blob:mock/0" });
    expect(created).toEqual(["blob:mock/0"]);
    expect(revoked).toEqual([]);
  });

  it("revokes the live URL on dispose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["bytes"]))),
    );

    const loader = createFencedBlobLoader();
    await loader.load("/api/x/y");
    loader.dispose();

    expect(revoked).toEqual(["blob:mock/0"]);
  });

  it("revokes a response that lands AFTER dispose instead of storing it", async () => {
    // The leak that has no visible symptom: the component unmounted, nothing
    // will ever render this, and without the check it stays alive for the life
    // of the tab.
    const { settle, fetch } = pendingResponse();
    vi.stubGlobal("fetch", fetch);

    const loader = createFencedBlobLoader();
    const inFlight = loader.load("/api/x/y");
    loader.dispose();
    settle();

    expect(await inFlight).toEqual({ kind: "superseded" });
    expect(created).toEqual(["blob:mock/0"]);
    expect(revoked).toEqual(["blob:mock/0"]);
  });

  it("revokes a response superseded by a newer load", async () => {
    const first = pendingResponse();
    vi.stubGlobal("fetch", first.fetch);

    const loader = createFencedBlobLoader();
    const stale = loader.load("/api/x/1");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["newer"]))),
    );
    const fresh = await loader.load("/api/x/2");
    first.settle();

    expect(await stale).toEqual({ kind: "superseded" });
    expect(fresh).toEqual({ kind: "loaded", url: "blob:mock/0" });
    // The superseded one was revoked; the live one was not.
    expect(revoked).toEqual(["blob:mock/1"]);
    expect(created).toEqual(["blob:mock/0", "blob:mock/1"]);
  });

  it("revokes the previous URL when the same loader loads again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["bytes"]))),
    );

    const loader = createFencedBlobLoader();
    await loader.load("/api/x/1");
    await loader.load("/api/x/2");

    expect(created).toEqual(["blob:mock/0", "blob:mock/1"]);
    expect(revoked).toEqual(["blob:mock/0"]);
  });

  it("reports a refusal as failed rather than leaving the caller loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("no", { status: 403 })),
    );

    const result = await createFencedBlobLoader().load("/api/x/y");

    expect(result).toEqual({ kind: "failed" });
    // Nothing was created, so nothing needs revoking.
    expect(created).toEqual([]);
    expect(revoked).toEqual([]);
  });

  it("reports a transport-level throw as failed too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );

    expect(await createFencedBlobLoader().load("/api/x/y")).toEqual({
      kind: "failed",
    });
  });
});
