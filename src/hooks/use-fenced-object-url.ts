"use client";

import { useEffect, useState } from "react";

import { apiFetchRaw } from "@/lib/api/api-fetch";

/**
 * v1.37.0 — reach a record-fenced route from the DOM without a headerless
 * request.
 *
 * `<img src>`, `<iframe src>` and `<a href download>` are issued by the browser
 * itself. They never pass through `src/lib/api/api-fetch.ts`, so they carry no
 * record-session assertion — and once a session has entered or left a shared
 * record the fence refuses an unasserted request with 403
 * `sharing.access.denied`, permanently, because nothing about those three will
 * ever start sending a header. The visible symptom is a thumbnail that stops
 * rendering for good after somebody visits a shared record.
 *
 * So the bytes are fetched through the app transport, which attaches the
 * assertion and validates the echo, and the DOM is handed an object URL
 * instead. The shape is not new here: `document-ai-transport.ts` already
 * reaches `/api/documents/inbound/{id}/original` this way to build a `File` for
 * in-browser OCR. `src/__tests__/record-fence-headerless-transport-guard.test.ts`
 * is what keeps a future `src="/api/…"` from reintroducing the class.
 *
 * ## Why the loader is separate from the hook
 *
 * Revocation is the part worth being careful about: getting it wrong leaks a
 * decrypted health document into the tab's memory for as long as the tab lives,
 * and nothing in the UI ever shows it. The unit suite runs in `node` with no
 * DOM and no testing-library, so a hook cannot be rendered here — and an
 * untested revocation rule is exactly the kind that is wrong. The rule
 * therefore lives in {@link createFencedBlobLoader}, which is a plain object
 * with `load` and `dispose`, fully exercised in
 * `src/hooks/__tests__/use-fenced-object-url.test.ts`. The hook below is the
 * thin React lifecycle shell over it.
 */
export interface FencedObjectUrl {
  /** The object URL, or null while loading, disabled, or failed. */
  url: string | null;
  /** The fetch finished and did not produce bytes. Render the fallback. */
  failed: boolean;
}

/** What one load produced. */
export type FencedBlobResult =
  { kind: "loaded"; url: string } | { kind: "failed" } | { kind: "superseded" };

/**
 * A one-slot object-URL holder.
 *
 * Holds at most one live URL. Loading again revokes the previous one; a
 * response that lands after `dispose()` or after a newer `load()` is revoked
 * immediately rather than stored, which is the case a fast scroll through the
 * vault timeline produces constantly — the path changes far more often than the
 * network answers.
 */
export function createFencedBlobLoader() {
  let current: string | null = null;
  let generation = 0;
  let disposed = false;

  const release = () => {
    if (current !== null) {
      URL.revokeObjectURL(current);
      current = null;
    }
  };

  return {
    async load(path: string): Promise<FencedBlobResult> {
      const mine = ++generation;
      release();
      let url: string | null = null;
      try {
        const res = await apiFetchRaw(path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
      } catch {
        // Every failure reads the same to the caller — refused, offline, gone,
        // or a context mismatch the transport discarded. The caller renders its
        // fallback either way, and the fence's own reconciliation handles the
        // one case that is recoverable.
        return disposed || mine !== generation
          ? { kind: "superseded" }
          : { kind: "failed" };
      }
      if (disposed || mine !== generation) {
        // Nobody is going to render this. Revoke it here or it lives as long
        // as the tab does.
        URL.revokeObjectURL(url);
        return { kind: "superseded" };
      }
      current = url;
      return { kind: "loaded", url };
    },
    dispose() {
      disposed = true;
      generation += 1;
      release();
    },
  };
}

export function useFencedObjectUrl(path: string | null): FencedObjectUrl {
  // The resolved path is stored ALONGSIDE the result, and the return value is
  // derived by comparing it against the current one. That is what keeps this
  // free of a synchronous `setState` inside the effect: while the path has just
  // changed and the effect has not run yet, the answer is "loading" because the
  // stored result belongs to a different path — not because something reset it.
  // Without that, a fast scroll through the vault timeline would paint one
  // card's thumbnail on the next card for a frame.
  const [resolved, setResolved] = useState<{
    path: string | null;
    url: string | null;
    failed: boolean;
  }>({ path: null, url: null, failed: false });

  useEffect(() => {
    if (path === null) return;
    const loader = createFencedBlobLoader();
    void loader.load(path).then((result) => {
      if (result.kind === "superseded") return;
      setResolved({
        path,
        url: result.kind === "loaded" ? result.url : null,
        failed: result.kind === "failed",
      });
    });
    return () => loader.dispose();
  }, [path]);

  if (path === null || resolved.path !== path) {
    return { url: null, failed: false };
  }
  return { url: resolved.url, failed: resolved.failed };
}
