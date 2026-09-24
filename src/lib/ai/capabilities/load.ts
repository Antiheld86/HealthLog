/**
 * The AI capability loader: gathers the resolver's inputs for one record.
 *
 * One read per input, all of them in parallel, all of them memoised per
 * request, and most of them shared with reads the request makes anyway:
 *
 *   - operator switches: the `AppSettings` singleton (`loadAssistantSwitches`);
 *   - the record's module map and the operator's module availability: the same
 *     memoised reads the account payload and every module gate use;
 *   - provider presence: the record's credential row and the operator's
 *     provider columns (`probeProviderChain`), presence only;
 *   - consent: the kinds of the record's active receipts, one indexed read.
 *
 * Any failure resolves to `null`, which the resolver turns into
 * `check_failed` for every capability. Failing closed is safe because no data
 * depends on a capability; failing open would switch AI work on during a
 * database blip.
 */
import { prisma } from "@/lib/db";
import { loadAssistantSwitches } from "@/lib/feature-flags";
import { getEvent } from "@/lib/logging/context";
import {
  getOperatorModuleAvailability,
  resolveModuleMap,
} from "@/lib/modules/gate";
import { probeProviderChain } from "@/lib/ai/provider";
import { memoizePerRequest } from "@/lib/request-cache";
import { buildModuleDisclosure } from "@/lib/sharing/module-disclosure";
import {
  mayEnqueueProviderWork,
  type ProviderWorkAuthority,
} from "@/lib/sharing/provider-work-authority";
import type { ShareDomain } from "@/lib/sharing/scope";

import {
  resolveAiBlock,
  type AiCapabilityInputs,
  type AiRecordKind,
} from "./resolve";
import type { AiCapabilities } from "./types";

/** Whose record, seen by whom, through which grant. */
export interface AiCapabilityScope {
  /** The record the capability is resolved for. */
  recordId: string;
  /** The provider-work authority for that record; `null` admits nothing. */
  authority: ProviderWorkAuthority | null;
  /**
   * The sections the active grant opens, `null` for the whole record (one's
   * own record, an unscoped grant, a background job). Masks module access
   * exactly as the account payload masks `moduleAccess`.
   */
  sections: readonly ShareDomain[] | null;
  recordKind: AiRecordKind;
}

/** The kinds of the record's active consent receipts. */
function loadActiveConsentKinds(recordId: string): Promise<Set<string>> {
  return memoizePerRequest(`ai-consent-kinds:${recordId}`, async () => {
    const rows = await prisma.consentReceipt.findMany({
      where: { userId: recordId, revokedAt: null },
      select: { kind: true },
    });
    return new Set(rows.map((row) => row.kind));
  });
}

function scopeKey(scope: AiCapabilityScope): string {
  return [
    scope.recordId,
    scope.authority?.origin ?? "none",
    scope.sections === null ? "*" : [...scope.sections].sort().join(","),
    scope.recordKind,
  ].join(":");
}

/**
 * Load the resolver's inputs for one scope, or `null` when any of them could
 * not be read.
 */
export function loadAiCapabilityInputs(
  scope: AiCapabilityScope,
): Promise<AiCapabilityInputs | null> {
  return memoizePerRequest(
    `ai-capability-inputs:${scopeKey(scope)}`,
    async () => {
      try {
        const [switches, modules, availability, provider, activeConsentKinds] =
          await Promise.all([
            loadAssistantSwitches(),
            resolveModuleMap(scope.recordId),
            getOperatorModuleAvailability(),
            probeProviderChain(scope.recordId, scope.authority),
            loadActiveConsentKinds(scope.recordId),
          ]);
        if (switches === null) return null;
        const { moduleAccess } = buildModuleDisclosure(
          modules,
          availability,
          scope.sections,
        );
        return {
          switches,
          moduleAccess,
          providerWorkAdmitted: mayEnqueueProviderWork(scope.authority),
          provider,
          activeConsentKinds,
          recordKind: scope.recordKind,
        };
      } catch {
        getEvent()?.addWarning(
          "Failed to load AI capability inputs; every AI capability is off for this request",
        );
        return null;
      }
    },
  );
}

/** The whole `ai` block for one scope. */
export async function loadAiCapabilities(
  scope: AiCapabilityScope,
): Promise<AiCapabilities> {
  return resolveAiBlock(await loadAiCapabilityInputs(scope));
}
