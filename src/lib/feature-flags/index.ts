import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { memoizePerRequest } from "@/lib/request-cache";

import type { AiOperatorSwitchSet } from "@/lib/ai/capabilities/types";

/**
 * The operator's assistant switches: input one of the AI capability resolver
 * (`src/lib/ai/capabilities/`), and nothing more.
 *
 * `AppSettings.assistant*Enabled` holds a master and four sub-switches. The
 * master always wins: every sub-switch reads false when it is off, before the
 * set leaves this module, so no reader composes `master && sub`.
 *
 * What a switch decides is AI work and AI text, never data. Whether a given
 * capability is available for a given record is the resolver's answer, which
 * also weighs modules, provider-work authority, provider presence and consent;
 * a route that serves or calls a model asks the resolver, not this file.
 */

/** The resolved switch set, master applied. */
export type AssistantFlagSet = AiOperatorSwitchSet;

/** Every switch on: the column defaults, and what a fresh install reads. */
export const ASSISTANT_FLAGS_DEFAULT: AssistantFlagSet = Object.freeze({
  enabled: true,
  coach: true,
  briefing: true,
  insightStatus: true,
  documentAi: true,
});

/** Every switch off: the answer when the switches could not be read. */
const ASSISTANT_FLAGS_OFF: AssistantFlagSet = Object.freeze({
  enabled: false,
  coach: false,
  briefing: false,
  insightStatus: false,
  documentAi: false,
});

/**
 * Load the switches, or `null` when they could not be read.
 *
 * A missing row reads as the column defaults (every switch on), which is what
 * an instance that never saved its settings has. A read ERROR is different: it
 * is `null`, and the capability resolver turns that into `check_failed` for
 * every capability. Failing closed is safe now that no data depends on a
 * switch; failing open meant a database blip switched every AI egress on.
 *
 * Memoised per request, so a page that fires several gated reads at once reads
 * the singleton row once.
 */
export function loadAssistantSwitches(): Promise<AssistantFlagSet | null> {
  return memoizePerRequest("assistant-flags", async () => {
    try {
      const settings = await prisma.appSettings.findUnique({
        where: { id: "singleton" },
        select: {
          assistantEnabled: true,
          assistantCoachEnabled: true,
          assistantBriefingEnabled: true,
          assistantInsightStatusEnabled: true,
          assistantDocumentAiEnabled: true,
        },
      });
      return resolveAssistantFlags({
        enabled: settings?.assistantEnabled ?? true,
        coach: settings?.assistantCoachEnabled ?? true,
        briefing: settings?.assistantBriefingEnabled ?? true,
        insightStatus: settings?.assistantInsightStatusEnabled ?? true,
        documentAi: settings?.assistantDocumentAiEnabled ?? true,
      });
    } catch {
      getEvent()?.addWarning(
        "Failed to load assistant switches; every AI capability is off for this request",
      );
      return null;
    }
  });
}

/**
 * The switch set, failing closed: every switch reads off when the row could
 * not be read. For callers that need a plain set rather than the distinction
 * between "off" and "unknown".
 */
export async function getAssistantFlags(): Promise<AssistantFlagSet> {
  return (await loadAssistantSwitches()) ?? ASSISTANT_FLAGS_OFF;
}

/**
 * Pure resolver: given the raw column values, return the operator-effective
 * set. Exposed for unit tests and for the admin handlers that echo the
 * resolved set after a write.
 */
export function resolveAssistantFlags(raw: AssistantFlagSet): AssistantFlagSet {
  if (!raw.enabled) return { ...ASSISTANT_FLAGS_OFF };
  return { ...raw };
}
