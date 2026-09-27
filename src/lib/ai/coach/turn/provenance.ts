/**
 * The provenance envelope a Coach reply is persisted and streamed with:
 * what the snapshot covered, plus what this turn added (key values, cards,
 * the tool trace, the grounded figures, the withheld-figure count).
 */
import { annotate } from "@/lib/logging/context";
import { PROMPT_VERSION } from "@/lib/ai/prompts/insight-generator";
import type { CoachProvenance, CoachSuggestion } from "@/lib/ai/coach/types";
import type { CoachSuggestedAction } from "@/lib/ai/coach/suggest-action";
import type { CoachToolTrace } from "@/lib/ai/coach/tools";

import type { GuardedReply } from "./reply-guards";

export function buildTurnProvenance(args: {
  snapshotProvenance: CoachProvenance;
  reply: GuardedReply;
  suggestion: CoachSuggestion | null;
  action: CoachSuggestedAction | null;
  toolTrace: CoachToolTrace[];
}): CoachProvenance {
  const { snapshotProvenance, reply, toolTrace } = args;
  const surfacedSuggestion = args.suggestion;
  const surfacedAction = args.action;
  const sentinel = reply.keyValuesSentinel;
  const outboundBlocked = reply.outboundBlocked;
  const { groundedFigures, unverifiedStripped } = reply;

  const enrichedProvenance: CoachProvenance = {
    ...snapshotProvenance,
    ...(surfacedAction ? { suggestedAction: surfacedAction } : {}),
    // v1.18.10 (HIGH-2) — a blocked turn carries the fallback prose, so the
    // key-values from the discarded reply must not ride along as provenance.
    ...(!outboundBlocked && sentinel.keyValues.length > 0
      ? { keyValues: sentinel.keyValues }
      : {}),
    ...(surfacedSuggestion ? { suggestion: surfacedSuggestion } : {}),
    // v1.20.0 (F1) — persist the retrieval-tool trace (which tools ran +
    // whether each found data) so a reload can show "what I looked at" and the
    // audit can replay grounding. Metadata only.
    ...(toolTrace.length > 0
      ? {
          toolCalls: toolTrace.map((t) => ({
            name: t.name,
            present: t.present,
          })),
        }
      : {}),
    // v1.32.9 (Coach Guard II / G2) — persist THIS turn's tool figures so a
    // later turn's Grounding Ledger can recall them (D3-safe: tool trace, not
    // prose). Dropped on a blocked turn (its figures rode the discarded reply).
    ...(!outboundBlocked && groundedFigures.length > 0
      ? { groundedFigures }
      : {}),
    // v1.32.14 — the count of figures the grounding guard withheld this turn,
    // so the quiet "some figures couldn't be checked" notice renders under the
    // bubble and survives a conversation reload. Count only, no values. Omitted
    // when nothing was withheld.
    ...(unverifiedStripped > 0
      ? { unverifiedFigures: unverifiedStripped }
      : {}),
  };
  if (sentinel.malformed) {
    // Graceful degrade: log so ops can spot a provider whose
    // sentinel format has drifted, but pass the prose through
    // unchanged. v1.4.23 H1 — split the annotation:
    //   - parse_partial: at least one row parsed AND at least one
    //     row failed (mixed-format drift on a single reply)
    //   - parse_failed: the whole block was unusable
    // Both annotations carry the per-line `reasons` array so an ops
    // dashboard can attribute the failure cause without re-running
    // the parser.
    const reasons = sentinel.malformedEntries.map((entry) => entry.reason);
    const annotationName =
      sentinel.keyValues.length > 0 && sentinel.malformedEntries.length > 0
        ? "coach.keyvalues.parse_partial"
        : "coach.keyvalues.parse_failed";
    annotate({
      action: { name: annotationName },
      meta: {
        kept: sentinel.keyValues.length,
        malformedCount: sentinel.malformedEntries.length,
        reasons,
        promptVersion: PROMPT_VERSION,
      },
    });
  }
  return enrichedProvenance;
}
