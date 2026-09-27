/**
 * The optional `---FOLLOWUPS---` block in the reply: the model may propose
 * a chip's kind and domain from the catalog, nothing else.
 *
 *   ---FOLLOWUPS---
 *   previous_period: bp
 *   as_chart: weight
 *   ---END---
 *
 * The block is always stripped from the prose. What survives is a list of
 * `{ kind, domain }` pairs, each checked against the closed catalogs; any
 * line that does not parse is skipped, and a block that is malformed as a
 * whole (no closing marker, over the byte cap) is dropped silently. Whether
 * a proposal becomes a chip is decided later, against what the turn read
 * (`derive.ts`); the model never writes a label.
 */
import { annotate } from "@/lib/logging/context";
import type { CoachFollowUpKind, CoachStepDomain } from "@/lib/ai/coach/types";
import { coachStepDomainSchema } from "@/lib/ai/coach/stream-events";

import { PROPOSABLE_FOLLOW_UP_KINDS, isFollowUpKind } from "./catalog";

const OPEN_SENTINEL = "---FOLLOWUPS---";
const CLOSE_SENTINEL = "---END---";
/** Block body cap in bytes, after the opening marker. */
export const FOLLOW_UPS_BYTE_CAP = 256;
/** At most this many proposals are read. */
const MAX_PROPOSALS = 3;

export interface FollowUpProposal {
  kind: CoachFollowUpKind;
  domain: CoachStepDomain;
}

function normalise(raw: string): string {
  return raw
    .trim()
    .replace(/^[-*•\s]+/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim()
    .toLowerCase();
}

function parseLine(line: string): FollowUpProposal | null {
  const colon = line.indexOf(":");
  if (colon < 1) return null;
  const kind = normalise(line.slice(0, colon));
  const domain = normalise(line.slice(colon + 1));
  if (!isFollowUpKind(kind) || !PROPOSABLE_FOLLOW_UP_KINDS.has(kind)) {
    return null;
  }
  const parsedDomain = coachStepDomainSchema.safeParse(domain);
  if (!parsedDomain.success) return null;
  return { kind, domain: parsedDomain.data };
}

export function parseFollowUpsSentinel(prose: string): {
  prose: string;
  proposals: FollowUpProposal[];
} {
  const open = prose.indexOf(OPEN_SENTINEL);
  if (open === -1) return { prose, proposals: [] };
  const before = prose.slice(0, open);
  const afterOpen = prose.slice(open + OPEN_SENTINEL.length);
  const close = afterOpen.indexOf(CLOSE_SENTINEL);
  const dropped = (reason: string, stripped: string) => {
    annotate({
      action: { name: "coach.followUp.proposal_dropped" },
      meta: { reason },
    });
    return { prose: stripped, proposals: [] };
  };
  if (close === -1) {
    // No closing marker: the rest of the reply is the block. The raw marker
    // must never reach the person, so the whole tail goes.
    return dropped("no_end_marker", before.trimEnd());
  }
  const body = afterOpen.slice(0, close);
  const after = afterOpen.slice(close + CLOSE_SENTINEL.length).trim();
  const stripped = `${before.trimEnd()}${after ? `\n\n${after}` : ""}`;
  if (Buffer.byteLength(body, "utf8") > FOLLOW_UPS_BYTE_CAP) {
    return dropped("byte_overflow", stripped);
  }
  const proposals: FollowUpProposal[] = [];
  const seen = new Set<string>();
  for (const line of body.split(/\r?\n/)) {
    const proposal = parseLine(line);
    if (!proposal) continue;
    const key = `${proposal.kind}:${proposal.domain}`;
    if (seen.has(key)) continue;
    seen.add(key);
    proposals.push(proposal);
    if (proposals.length === MAX_PROPOSALS) break;
  }
  return { prose: stripped, proposals };
}
