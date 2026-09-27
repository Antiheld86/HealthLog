/**
 * The optional `---FOLLOWUPS---` block in the reply: the model may propose
 * a chip's kind and domain from the catalog, nothing else. The block is
 * stripped from the prose; a malformed block is dropped silently.
 *
 * Not built yet: the prose passes through unchanged, with no proposals.
 */
import type { CoachFollowUpKind, CoachStepDomain } from "@/lib/ai/coach/types";

export function parseFollowUpsSentinel(prose: string): {
  prose: string;
  proposals: Array<{ kind: CoachFollowUpKind; domain: CoachStepDomain }>;
} {
  return { prose, proposals: [] };
}
