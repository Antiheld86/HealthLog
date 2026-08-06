/**
 * v1.36.0 — the account dimension of the query cache.
 *
 * Every cached read in this app is about one health record. Nothing in the key
 * factory says which one, because until now there was only ever one: the
 * signed-in account's. Once a browser can act on somebody else's record, a key
 * like `["dashboard","snapshot"]` names two different answers, and a cache that
 * cannot tell them apart will hand the second reader the first one's data.
 * That is this repository's known cache-poison class, on health data, across
 * two people.
 *
 * The fix is one line at the root rather than a dimension threaded through
 * twenty-three key modules: a `queryKeyHashFn` on the QueryClient. The hash is
 * what the cache stores entries under and what `getQueryData` looks them up by,
 * so folding the record id into it partitions every entry in the app at once.
 * Key ARRAYS are untouched, which matters more than it looks: prefix
 * invalidation (`invalidateQueries({ queryKey: ["measurements"] })`) and the
 * module-scope dependent-key bundles in `./index.ts` both match on the array,
 * were computed at import time before any record was known, and keep working
 * unchanged. Prefixing the arrays instead would have silently broken every one
 * of those bundles.
 *
 * ## Why this is defence in depth and not the primary control
 *
 * Switching records is a full page reload (design §2), so the in-memory cache
 * is empty on the other side of it and this hash can only matter if that ever
 * stops being true. The primary control for the layers that DO survive a
 * reload — the IndexedDB snapshot and the service worker's data cache — is the
 * wipe the switch performs before reloading, in `switchRecord()`. Both are
 * cheap; only one of them is the reason the feature is safe.
 *
 * ## Why the mirror is in localStorage
 *
 * The scope has to be known synchronously at boot, before `/api/auth/me`
 * answers, because the persister decides whether to restore from disk in the
 * first effect after mount. A switch is a property of the SESSION — it is
 * carried on the session row, not per tab — so every tab of the browser is
 * switched at once, which is what localStorage models and sessionStorage does
 * not.
 *
 * A mirror can go stale, and the honest question is what a stale one costs.
 * Nothing, because the disk layers are wiped on every switch in both
 * directions: a mirror claiming a record the session has left points the
 * persister at a store that was emptied when it left, and a mirror claiming
 * "own" while the session is inside a record points it at a store that was
 * emptied on the way in and never written to since (the persister refuses to
 * write while switched — see `isPersistableKey`'s caller). Either way the
 * worst case is an empty restore and a skeleton, never another person's data.
 * `fetchMe` re-stamps the mirror from the server's resolved answer on every
 * boot, so the staleness window is one round trip.
 */
import type { QueryKey } from "@tanstack/react-query";

export const RECORD_SCOPE_STORAGE_KEY = "healthlog-record-scope";
const REFUSED_RECORD_SCOPE = "__healthlog_refused_record__";

/**
 * The in-process copy. Seeded from storage on first read so the hash function
 * — which runs on every single query — never touches localStorage.
 */
let scope: string | null = null;
let seeded = false;
const scopeListeners = new Set<() => void>();

function notifyScopeListeners(): void {
  for (const listener of scopeListeners) listener();
}

function readMirror(): string | null {
  try {
    const raw = localStorage.getItem(RECORD_SCOPE_STORAGE_KEY);
    return raw === null || raw.length === 0 ? null : raw;
  } catch {
    // Private mode, disabled storage, or SSR. "Own record" is the safe
    // reading: it is what every browser reported before this feature existed.
    return null;
  }
}

/**
 * The record this browser is currently reading, or null when it is reading its
 * own.
 *
 * Server-side this stays null for the life of the process: the mirror is only
 * ever seeded from browser storage, and `setRecordScope` is called from client
 * code alone. That matters more than it looks — the value is a module-level
 * variable, so a server that could write it would be sharing one scope across
 * every request it serves.
 */
export function getRecordScope(): string | null {
  if (!seeded) {
    scope = typeof window === "undefined" ? null : readMirror();
    seeded = true;
  }
  return scope;
}

/**
 * Point the cache at a record, or (with `null`) back at the caller's own.
 *
 * Called from exactly two places: the switch flow, before it reloads the page,
 * and `fetchMe`, which corrects the mirror from the server's resolved
 * `accountAccess.active` on every account read. The second is what keeps a
 * mirror written by a switch that the server has since ended from surviving
 * past one round trip.
 */
export function setRecordScope(accountId: string | null): void {
  scope = accountId;
  seeded = true;
  if (typeof window === "undefined") return;
  try {
    if (accountId === null) {
      localStorage.removeItem(RECORD_SCOPE_STORAGE_KEY);
    } else {
      localStorage.setItem(RECORD_SCOPE_STORAGE_KEY, accountId);
    }
  } catch {
    /* storage unavailable — the in-process copy still partitions this tab */
  }
  notifyScopeListeners();
}

/**
 * React bridge for consumers that must stop work as soon as another tab moves
 * the session to a different record. `storage` never fires in the tab that
 * wrote the mirror, so local writes notify directly above; other tabs adopt
 * the new value before notifying their subscribers.
 */
export function subscribeToRecordScope(listener: () => void): () => void {
  scopeListeners.add(listener);
  if (typeof window === "undefined") {
    return () => scopeListeners.delete(listener);
  }
  const onStorage = (event: StorageEvent) => {
    if (event.key !== RECORD_SCOPE_STORAGE_KEY) return;
    scope =
      event.newValue === null || event.newValue.length === 0
        ? null
        : event.newValue;
    seeded = true;
    notifyScopeListeners();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    scopeListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * Keep a malformed active-record response out of the caller's own cache slot.
 *
 * No record id from an invalid payload is trusted, but `null` would make
 * record-scoped reads share the caller's own cache identity. This sentinel is
 * a cache partition only; the shell refuses the presentation until the caller
 * leaves the server-side switch.
 */
export function setRefusedRecordScope(): void {
  setRecordScope(REFUSED_RECORD_SCOPE);
}

/** True while this browser is reading somebody else's record. */
export function isReadingSharedRecord(): boolean {
  return getRecordScope() !== null;
}

/**
 * The QueryClient's key hash function.
 *
 * Identical to TanStack's own `hashKey` when the browser is in its own record
 * — a `JSON.stringify` with sorted object keys — so nothing about the app's
 * cache changes for the overwhelming majority of sessions. Inside a shared
 * record every entry lands under a distinct hash, which is what makes an
 * inherited entry unreachable rather than merely stale.
 */
export function recordScopedQueryKeyHashFn(queryKey: QueryKey): string {
  const key = JSON.stringify(queryKey, (_, val) =>
    isPlainObject(val)
      ? Object.keys(val)
          .sort()
          .reduce<Record<string, unknown>>((result, k) => {
            result[k] = (val as Record<string, unknown>)[k];
            return result;
          }, {})
      : val,
  );
  // `/api/auth/me` identifies the caller, never the record they are reading.
  // Its query begins before `fetchMe` can resolve or refuse the record scope,
  // so it must remain reachable across that transition.
  if (queryKey[0] === "auth") return key;
  const record = getRecordScope();
  return record === null ? key : `record:${record}|${key}`;
}

/** TanStack's own predicate, copied rather than imported — it is not exported. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== "[object Object]") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

/** @internal — lets a test start from a known state. */
export const __resetRecordScopeForTests = (): void => {
  scope = null;
  seeded = false;
};
