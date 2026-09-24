/**
 * The refusal an AI action answers with when its capability is unavailable.
 *
 * Kept apart from the gates so `apiHandler` can render the envelope without
 * importing the loader and the provider resolution behind it. The mapping
 * keeps every code a shipped client already branches on; see
 * `./gate.ts` for the table.
 */
import { MODULE_DISABLED_ERROR_CODE } from "@/lib/modules/gate";
import type { ModuleKey } from "@/lib/modules/registry";

import {
  AI_CAPABILITIES,
  AI_PROVIDER_NONE_ERROR_CODE,
  AI_RECORD_NOT_PERMITTED_ERROR_CODE,
  AI_UNAVAILABLE_ERROR_CODE,
  type AiCapabilityKey,
  type AiUnavailableReason,
} from "./types";

/** How a route refuses `no_provider` when it already has a typed code. */
export interface NoProviderRefusal {
  errorCode: string;
  status?: number;
}

/** The consent code, shared with `ConsentRequiredError`. */
const CONSENT_REQUIRED_CODE = "consent.ai.required";

/** What the envelope carries in `meta`. */
export interface AiRefusalMeta {
  errorCode: string;
  capability: AiCapabilityKey;
  reason: AiUnavailableReason;
  module?: ModuleKey;
}

/** The HTTP shape of one refusal. Pure; exported for the envelope test. */
export function aiRefusal(
  capability: AiCapabilityKey,
  reason: AiUnavailableReason,
  module: ModuleKey | null = null,
  noProvider?: NoProviderRefusal,
): { status: number; meta: AiRefusalMeta } {
  const base = { capability, reason };
  switch (reason) {
    case "operator_disabled":
      return module === null
        ? {
            status: 403,
            meta: {
              ...base,
              errorCode: `assistant.disabled.${AI_CAPABILITIES[capability].operatorSwitch}`,
            },
          }
        : {
            status: 403,
            meta: { ...base, errorCode: MODULE_DISABLED_ERROR_CODE, module },
          };
    case "not_permitted_for_record":
      return {
        status: 403,
        meta: { ...base, errorCode: AI_RECORD_NOT_PERMITTED_ERROR_CODE },
      };
    case "module_disabled":
    case "user_disabled":
      return {
        status: 403,
        meta: {
          ...base,
          errorCode: MODULE_DISABLED_ERROR_CODE,
          ...(module === null ? {} : { module }),
        },
      };
    case "no_provider":
      return {
        status: noProvider?.status ?? 422,
        meta: {
          ...base,
          errorCode: noProvider?.errorCode ?? AI_PROVIDER_NONE_ERROR_CODE,
        },
      };
    case "consent_required":
      return {
        status: 403,
        meta: { ...base, errorCode: CONSENT_REQUIRED_CODE },
      };
    case "check_failed":
      return {
        status: 503,
        meta: { ...base, errorCode: AI_UNAVAILABLE_ERROR_CODE },
      };
  }
}

const REFUSAL_MESSAGE: Record<AiUnavailableReason, string> = {
  check_failed: "AI is unavailable right now",
  operator_disabled: "This AI feature is turned off on this server",
  not_permitted_for_record: "AI work is not available for this record",
  module_disabled: "This AI feature's module is turned off for this record",
  user_disabled: "This AI feature is turned off in your settings",
  no_provider: "No AI provider is set up for this feature",
  consent_required: "AI consent is required for this feature",
};

/**
 * Thrown by `requireAiCapability`; `apiHandler` renders it as
 * `{ data: null, error, meta }` with its status.
 */
export class AiUnavailableError extends Error {
  readonly capability: AiCapabilityKey;
  readonly reason: AiUnavailableReason;
  readonly status: number;
  readonly meta: AiRefusalMeta;

  constructor(
    capability: AiCapabilityKey,
    reason: AiUnavailableReason,
    module: ModuleKey | null = null,
    noProvider?: NoProviderRefusal,
  ) {
    super(REFUSAL_MESSAGE[reason]);
    this.name = "AiUnavailableError";
    this.capability = capability;
    this.reason = reason;
    const refusal = aiRefusal(capability, reason, module, noProvider);
    this.status = refusal.status;
    this.meta = refusal.meta;
  }
}
