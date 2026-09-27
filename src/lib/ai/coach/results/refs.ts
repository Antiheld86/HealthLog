/**
 * `result:rN` references in the reply prose. The model marks the tables its
 * answer relies on; the marks are stripped before the prose reaches the
 * client, and a referenced table is shown expanded under the reply.
 *
 * Not built yet: the prose passes through unchanged and nothing counts as
 * referenced.
 */
export function stripResultRefs(prose: string): {
  prose: string;
  referenced: string[];
} {
  return { prose, referenced: [] };
}
