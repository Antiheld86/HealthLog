/**
 * The refusals the extraction group answers with: reading a stored document,
 * scanning a lab report, and turning typed medication text into a schedule.
 *
 * Three capabilities under one operator switch ("Reading documents",
 * `documentAi`), one consent rule (any provider that leaves the machine needs
 * an `ai_extraction` or `ai_full` receipt), and one envelope. Written once so
 * the vault, the labs scan and the medication extractor describe the same
 * refusal in the same words.
 */
import type { AiCapabilityKey } from "@/lib/ai/capabilities/types";

import { errorEnvelope } from "./shared";

const MODULE_BY_CAPABILITY: Partial<Record<AiCapabilityKey, string>> = {
  documentAi: "inboundDocuments",
  labsOcr: "labs",
};

/**
 * The 403 sentence for one extraction capability (plus any capability the
 * route also answers under, such as `coach` for a fenced Coach turn).
 */
export function aiExtractionRefusalDescription(
  capability: AiCapabilityKey,
  ...alsoUnder: AiCapabilityKey[]
): string {
  const owningModule = MODULE_BY_CAPABILITY[capability];
  const also =
    alsoUnder.length === 0
      ? ""
      : ` The route also answers under ${alsoUnder.map((key) => `\`${key}\``).join(", ")}, with the same envelope and that capability's own codes (\`assistant.disabled.coach\`, \`module.disabled\` with \`meta.module = "coach"\` when the Coach is off for the record).`;
  return (
    `AI refusal: the \`${capability}\` capability is unavailable for this record. The envelope carries \`meta.errorCode\`, \`meta.capability\` and \`meta.reason\` (one of \`AiUnavailableReason\`). ` +
    "`assistant.disabled.documentAi` — the operator turned off reading documents, or every AI feature (the master switch). " +
    (owningModule
      ? `\`module.disabled\` with \`meta.module = "${owningModule}"\` — the module is off for this record. `
      : "") +
    "`ai.record.notPermitted` — AI work is not admitted inside this record (a delegate acting in somebody else's record). " +
    "`consent.ai.required` — the provider this request would reach leaves the machine and the record holds no active `ai_extraction` or `ai_full` receipt; only a self-hosted model is exempt. The question is answered for the provider actually picked, so it can differ from the published capability when a text-mode read takes a different provider than a vision read would." +
    also
  );
}

/** The 503 an extraction route answers when the capability could not be resolved. */
export const AI_EXTRACTION_UNAVAILABLE_DESCRIPTION =
  "`ai.unavailable` — the inputs behind the AI capability could not be read, and the answer failed closed. Nothing was sent. Retry later.";

type AiExtractionRefusals = {
  "403": {
    description: string;
    content: { "application/json": { schema: typeof errorEnvelope } };
  };
  "503": {
    description: string;
    content: { "application/json": { schema: typeof errorEnvelope } };
  };
};

// Memoised so identical responses are one object: the YAML emitter aliases by
// identity, and a fresh object per operation would print the paragraph again.
const cache = new Map<string, AiExtractionRefusals>();

/** `{ "403", "503" }` for an extraction route. Spread before `stdResponses`. */
export function aiExtractionRefusals(
  capability: AiCapabilityKey,
  ...alsoUnder: AiCapabilityKey[]
): AiExtractionRefusals {
  const key = [capability, ...alsoUnder].join(",");
  const cached = cache.get(key);
  if (cached) return cached;
  const refusals: AiExtractionRefusals = {
    "403": {
      description: aiExtractionRefusalDescription(capability, ...alsoUnder),
      content: { "application/json": { schema: errorEnvelope } },
    },
    "503": {
      description: AI_EXTRACTION_UNAVAILABLE_DESCRIPTION,
      content: { "application/json": { schema: errorEnvelope } },
    },
  };
  cache.set(key, refusals);
  return refusals;
}
