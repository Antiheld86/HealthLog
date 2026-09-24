/**
 * The published wording for an AI capability refusal, shared by every
 * operation that asks `requireAiCapability`.
 *
 * One envelope, three statuses: 403 for the operator, record, module, opt-out
 * and consent reasons; 422 for a missing provider (unless the route keeps a
 * typed code of its own); 503 when the capability could not be resolved. The
 * mapping from reason to `meta.errorCode` is written once on `ErrorEnvelope`
 * (`meta.reason`); these strings name the capability and point there.
 */
import {
  AI_CAPABILITIES,
  type AiCapabilityKey,
} from "@/lib/ai/capabilities/types";

import { errorEnvelope } from "./shared";

/** The 403 sentence for one capability. */
export function aiRefusal403Description(key: AiCapabilityKey): string {
  const operatorSwitch = AI_CAPABILITIES[key].operatorSwitch;
  return `The \`${key}\` AI capability is unavailable for this record. \`meta.capability\` = \`${key}\` and \`meta.reason\` says which layer refused: the operator's switch (\`assistant.disabled.${operatorSwitch}\`, or \`assistant.disabled.enabled\` for the master switch), an owning module or the person's own AI opt-out (\`module.disabled\` with \`meta.module\`), a delegate inside somebody else's record (\`ai.record.notPermitted\`), or a missing consent receipt (\`consent.ai.required\`). Nothing was generated, read from a stored model answer, or enqueued.`;
}

/** The 422 a capability answers when no provider can serve it. */
export function aiNoProviderResponse(key: AiCapabilityKey) {
  return {
    description: `No configured AI provider can serve the \`${key}\` capability: \`meta.errorCode\` = \`ai.provider.none\`, \`meta.reason\` = \`no_provider\`.`,
    content: { "application/json": { schema: errorEnvelope } },
  };
}

/** The 503 every capability answers when its inputs could not be read. */
export const aiCheckFailedResponse = {
  description:
    "The AI capability could not be resolved (its inputs could not be read) and the answer failed closed: `meta.errorCode` = `ai.unavailable`, `meta.reason` = `check_failed`. Retry later; no data depends on it.",
  content: { "application/json": { schema: errorEnvelope } },
};
