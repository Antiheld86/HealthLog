"use client";

import {
  RECORD_SCOPE_STORAGE_KEY,
  setRecordScope,
} from "@/lib/query-keys/record-scope";

/**
 * A browser-wide hold around a server-side record-session switch.
 *
 * The session stamp is shared by every tab, but React Query and `/api/auth/me`
 * are tab-local. A peer with a five-minute fresh `/me` cache can otherwise
 * keep owner chrome mounted after another tab changes the server session. The
 * switcher therefore publishes `blocking` before its POST. Recipients clear
 * their local reads and render only the hydration gate. A committed scope then
 * moves every tab to `resolving`; only a fresh `/me` whose active record
 * exactly matches the committed scope releases the hold.
 *
 * This is a browser-side coordination point, not a distributed-security
 * fence: BroadcastChannel and storage delivery cannot pre-empt a request that
 * a suspended peer already sent. The server remains authoritative for every
 * such request. After a tab processes the hold, this protocol removes local
 * results and prevents its protected shell from issuing new reads until `/me`
 * resolves the scope.
 */
export type RecordSessionPhase = "ready" | "blocking" | "resolving";

export interface RecordSessionTransition {
  id: string | null;
  phase: RecordSessionPhase;
  /** Undefined only for a recovery reload whose server outcome is unknown. */
  expectedScope: string | null | undefined;
}

interface WireTransition {
  id: string;
  phase: Exclude<RecordSessionPhase, "ready"> | "ready";
  expectedScope?: string | null;
  at: number;
}

const STORAGE_KEY = "healthlog-record-session-transition";
const CHANNEL_NAME = "healthlog-record-session-transition";
const TRANSITION_MAX_AGE_MS = 30_000;
const READY: RecordSessionTransition = {
  id: null,
  phase: "ready",
  expectedScope: undefined,
};

let transition = READY;
let seeded = false;
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let storageListenerAttached = false;

function notify(): void {
  for (const listener of listeners) listener();
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseWire(value: string | null): WireTransition | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Partial<WireTransition>;
    if (
      typeof parsed.id !== "string" ||
      (parsed.phase !== "blocking" &&
        parsed.phase !== "resolving" &&
        parsed.phase !== "ready") ||
      typeof parsed.at !== "number" ||
      Date.now() - parsed.at > TRANSITION_MAX_AGE_MS
    ) {
      return null;
    }
    if (
      parsed.expectedScope !== undefined &&
      parsed.expectedScope !== null &&
      typeof parsed.expectedScope !== "string"
    ) {
      return null;
    }
    return parsed as WireTransition;
  } catch {
    return null;
  }
}

function toSnapshot(next: WireTransition): RecordSessionTransition {
  return {
    id: next.id,
    // A new tab cannot know whether an inherited blocking POST is still in
    // flight. It resolves `/me` rather than leaving the browser wedged if the
    // initiating tab crashed between its POST and terminal message.
    phase: next.phase === "blocking" && !seeded ? "resolving" : next.phase,
    expectedScope: next.expectedScope,
  };
}

function applyWire(next: WireTransition): void {
  if (
    transition.id === next.id &&
    transition.phase === next.phase &&
    transition.expectedScope === next.expectedScope
  ) {
    return;
  }
  transition = toSnapshot(next);
  seeded = true;
  notify();
}

function writeWire(next: WireTransition): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable — BroadcastChannel can still notify peers */
  }
}

function postWire(next: WireTransition): void {
  try {
    channel?.postMessage(next);
  } catch {
    /* a closed channel is only an optimisation loss; storage remains */
  }
}

function publish(next: WireTransition): void {
  applyWire(next);
  writeWire(next);
  postWire(next);
}

function ensureTransport(): void {
  if (typeof window === "undefined") return;
  if (!storageListenerAttached) {
    window.addEventListener("storage", (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) {
        const next = parseWire(event.newValue);
        if (next) applyWire(next);
        return;
      }
      // A scope write without a transition marker is an external/legacy
      // switch. Fail closed and force `/me` to reconcile it before any stale
      // shell can issue a new record read.
      if (event.key === RECORD_SCOPE_STORAGE_KEY) {
        const expectedScope =
          event.newValue === null || event.newValue.length === 0
            ? null
            : event.newValue;
        // A current protocol transition already names this scope. The scope
        // mirror is its second storage write, not a separate legacy switch.
        if (
          transition.phase !== "ready" &&
          transition.expectedScope === expectedScope
        ) {
          return;
        }
        publish({
          id: makeId(),
          phase: "resolving",
          expectedScope,
          at: Date.now(),
        });
      }
    });
    storageListenerAttached = true;
  }
  if (channel === null && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (value === null || typeof value !== "object") return;
      const next = parseWire(JSON.stringify(value));
      if (next) applyWire(next);
    };
  }
}

function seed(): void {
  if (seeded) return;
  if (typeof window === "undefined") {
    seeded = true;
    return;
  }
  const next = parseWire(localStorage.getItem(STORAGE_KEY));
  if (next) {
    transition = toSnapshot(next);
  }
  seeded = true;
}

export function getRecordSessionTransition(): RecordSessionTransition {
  seed();
  return transition;
}

export function subscribeToRecordSessionTransition(
  listener: () => void,
): () => void {
  seed();
  ensureTransport();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Publish the safe hold before issuing `POST /api/account/switch`. */
export function beginRecordSessionTransition(
  expectedScope: string | null,
): string {
  seed();
  ensureTransport();
  const id = makeId();
  publish({ id, phase: "blocking", expectedScope, at: Date.now() });
  return id;
}

/** Record the server-confirmed scope, while every tab still waits for `/me`. */
export function commitRecordSessionTransition(
  id: string,
  expectedScope: string | null,
): void {
  if (transition.id !== id) return;
  publish({ id, phase: "resolving", expectedScope, at: Date.now() });
  // The terminal transition marker is deliberately published before the
  // scope mirror. A peer that receives the two storage events separately is
  // already held when it learns the new record hash.
  setRecordScope(expectedScope);
}

/**
 * A switch response was lost after the request was made. Keep all tabs held
 * and let `/me` decide which record the server actually kept.
 */
export function resolveUnknownRecordSessionTransition(id: string): void {
  if (transition.id !== id) return;
  publish({ id, phase: "resolving", at: Date.now() });
}

/**
 * v1.37.0 — hold every tab because a response contradicted the record context
 * this browser is on, with no transition of our own to attach it to.
 *
 * The switch paths above always hold FIRST and get an id back. This one starts
 * from the other end: a 409 from the record-session fence, or a 2xx whose
 * echoed context disagrees with the adopted one, means the server has moved and
 * nobody told us. There is no prior id because this browser did not begin the
 * transition — another tab did, or the referential action behind an account
 * deletion did, or an operator did.
 *
 * A narrow export rather than a second store: `resolving` already means exactly
 * "held, outcome unknown, `/me` decides", and `expectedScope` is deliberately
 * left unset so `settleRecordSessionTransition` releases on whatever the server
 * turns out to say rather than on a scope this browser guessed.
 */
export function holdForRecordSessionReconcile(): void {
  seed();
  ensureTransport();
  if (transition.phase === "resolving") return;
  publish({ id: makeId(), phase: "resolving", at: Date.now() });
}

/** Release only the `/me` response that confirms the committed record. */
export function settleRecordSessionTransition(
  resolvedScope: string | null,
): void {
  if (transition.phase !== "resolving") return;
  if (
    transition.expectedScope !== undefined &&
    transition.expectedScope !== resolvedScope
  ) {
    return;
  }
  const id = transition.id ?? makeId();
  publish({ id, phase: "ready", at: Date.now() });
}

/**
 * Release the browser hold after a server response has explicitly refused its
 * access block. The caller has already installed the refused scope sentinel,
 * so returning to `ready` can only render the access-refusal door; it never
 * restores a prior record scope.
 */
export function settleRefusedRecordSessionTransition(): void {
  if (transition.phase !== "resolving") return;
  const id = transition.id ?? makeId();
  publish({ id, phase: "ready", at: Date.now() });
}

/** @internal — deterministic transition state for unit tests. */
export function __resetRecordSessionTransitionForTests(): void {
  transition = READY;
  seeded = false;
  listeners.clear();
  channel?.close();
  channel = null;
}
