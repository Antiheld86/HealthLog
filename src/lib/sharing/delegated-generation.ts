import { getEvent } from "@/lib/logging/context";

/**
 * v1.37.0 — whether this request may spend the record owner's provider budget.
 *
 * MANAGE opens the generated surfaces: a manager opens a metric page and reads
 * the assessment that is already there. What it must not open is the hop
 * behind that read. Nine of the ten generated reads enqueue a generation job
 * on a cache miss (`resolveReadOnlyStatusMiss`) and the narrative enqueues one
 * whenever the row is stale, so on a delegated request the sequence is: the
 * manager navigates, the owner's health data leaves the box under the owner's
 * consent receipt, against the owner's provider, on the owner's budget, and
 * the owner sees a bill line for something they did not do. The manager sees a
 * card. Nothing on the wire says the two are the same event.
 *
 * So the read stays and the enqueue goes, on exactly one condition: somebody
 * else is holding the request and the record has an owner who could have
 * pressed the button themselves. A managed profile has nobody in that
 * position — its guardian IS the person who decides what it generates — so the
 * suppression does not apply there, and the guardian surfaces that trigger
 * generation deliberately are its own list.
 *
 * Read from the request context rather than from an argument, the same
 * reasoning `actingActorFor` states in `src/lib/auth/audit.ts`: the fact is
 * settled once, in the resolver, where the owner row is in hand — and threading
 * it through ten generator modules would be a second answer to "who is asking",
 * with the routes that forgot to pass it being the ones nobody reviewed. A
 * caller with no request context (every worker, every cron pass) reads false
 * and generates as it always did, which is the correct answer for work nobody
 * navigated into.
 */
export function delegatedGenerationSuppressed(): boolean {
  return getEvent()?.getAuth()?.delegated_generation === "suppressed";
}
