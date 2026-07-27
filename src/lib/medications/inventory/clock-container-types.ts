/**
 * The one owner of "which container kinds start a degradation clock when
 * they are first opened".
 *
 * The state machine decides the transition and the settings client decides
 * which helper text to put beside the opening date. Both need the same
 * list, but the state machine types itself against the generated Prisma
 * client, which a browser bundle cannot carry — so the client kept its own
 * copy of the two literals with a comment promising they matched. Nothing
 * held the promise, and a release spent fixing a fact that drifted is a bad
 * place to keep a second one.
 *
 * So the list lives here: string literals and a pure predicate, no imports,
 * safe on either side of the boundary. `state-machine.ts` re-exports it
 * under the Prisma enum (`satisfies`), which turns a renamed or dropped
 * container kind into a compile error rather than a member that silently
 * stops matching. The per-kind reasoning stays in the state machine's
 * docblock, where the transition it drives is.
 */

export const IN_USE_CLOCK_CONTAINER_TYPES = ["PEN", "AMPOULE"] as const;

/**
 * Does opening this container start the in-use window? Takes a loose
 * `string` so the client can ask about a container kind it read off the
 * wire without narrowing first; an unrecognised kind answers `false`,
 * which is the honest side (no deadline nobody entered).
 */
export function startsInUseClock(containerType: string): boolean {
  return (IN_USE_CLOCK_CONTAINER_TYPES as readonly string[]).includes(
    containerType,
  );
}
