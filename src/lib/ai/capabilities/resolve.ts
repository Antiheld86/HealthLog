/**
 * The AI capability resolver: pure, total, no I/O.
 *
 * Every layer that can say no to AI work is an input here, and each can only
 * subtract. The answer per capability is one of `available` or the OUTERMOST
 * reason that applies (precedence in {@link AI_UNAVAILABLE_REASONS}), because
 * that is the layer the reader would have to change first. Nothing in this
 * file reads a database, a clock, a request or an environment variable; the
 * loader (`./load.ts`) gathers the inputs and this decides.
 *
 * Deliberately NOT an input: budgets and rate limits. They move minute to
 * minute, and a cached payload that published them would be wrong by the time
 * a client acted on it. They stay a per-call refusal with their own codes.
 */
import { documentProviderRank } from "@/lib/documents/provider-rank";
import type { ModuleKey } from "@/lib/modules/registry";
import type { ModuleAccessState } from "@/lib/sharing/module-disclosure";

import {
  AI_CAPABILITIES,
  AI_CAPABILITY_KEYS,
  AI_OPT_OUT_MODULES,
  AI_UNAVAILABLE_REASONS,
  ON_DEVICE_ALLOWED_REASONS,
  type AiCapabilities,
  type AiCapabilityDefinition,
  type AiCapabilityKey,
  type AiCapabilityState,
  type AiOperatorSwitchSet,
  type AiProviderManagedBy,
  type AiProviderState,
  type AiUnavailableReason,
} from "./types";

/** One configured provider in the chain, presence only. */
export interface ProviderEntryPresence {
  /** The chain tag: `openai`, `anthropic`, `local`, `admin-openai`, … */
  providerType: string;
  /** Whether the entry's model can read an image. */
  vision: boolean;
}

/**
 * What the provider chain for a record looks like, without building a client,
 * refreshing a token or touching the network. Already narrowed by the
 * provider-work authority: a delegate's chain is empty, a guardian's is the
 * operator's key alone.
 */
export interface ProviderPresence {
  /** Usable entries in chain order, the central Codex and legacy fallback included. */
  entries: readonly ProviderEntryPresence[];
  /** The person's in-browser OCR opt-in, which lets a text-only provider read a document. */
  localOcrEnabled: boolean;
  managedBy: AiProviderManagedBy | null;
}

/** Whose record this is, as far as configuring a provider for it goes. */
export type AiRecordKind = "self" | "shared" | "managed";

export interface AiCapabilityInputs {
  /** Operator switches, master already applied. */
  switches: AiOperatorSwitchSet;
  /** Per-module access for the record, as `moduleAccess` publishes it. */
  moduleAccess: Readonly<Record<ModuleKey, ModuleAccessState>>;
  /** Whether provider work is admitted for this record at all. */
  providerWorkAdmitted: boolean;
  provider: ProviderPresence;
  /** Kinds of the record's active (non-revoked) consent receipts. */
  activeConsentKinds: ReadonlySet<string>;
  recordKind: AiRecordKind;
}

/** Provider tags that egress through a credential the operator holds. */
const OPERATOR_HELD_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  "admin-openai",
  "admin-codex",
]);

/** The one provider tag that keeps its input on the machine. */
const LOCAL_PROVIDER_TYPE = "local";

const REASON_RANK: ReadonlyMap<AiUnavailableReason, number> = new Map(
  AI_UNAVAILABLE_REASONS.map((reason, index) => [reason, index]),
);

function outermost(
  reasons: readonly (AiUnavailableReason | null)[],
): AiUnavailableReason | null {
  let best: AiUnavailableReason | null = null;
  for (const reason of reasons) {
    if (reason === null) continue;
    if (best === null || REASON_RANK.get(reason)! < REASON_RANK.get(best)!) {
      best = reason;
    }
  }
  return best;
}

function innermost(
  reasons: readonly AiUnavailableReason[],
): AiUnavailableReason | null {
  let best: AiUnavailableReason | null = null;
  for (const reason of reasons) {
    if (best === null || REASON_RANK.get(reason)! > REASON_RANK.get(best)!) {
      best = reason;
    }
  }
  return best;
}

function moduleReason(
  key: ModuleKey,
  access: ModuleAccessState,
): AiUnavailableReason | null {
  switch (access) {
    case "enabled":
      return null;
    // The operator's instance-wide availability is an operator decision.
    case "unavailable":
      return "operator_disabled";
    // The edge of the active grant: the record's configuration, as far as
    // this session may see it.
    case "not_granted":
      return "module_disabled";
    case "disabled":
      return AI_OPT_OUT_MODULES.has(key) ? "user_disabled" : "module_disabled";
  }
}

/**
 * The module layer for one capability. `all` needs every owning module and
 * reports the outermost reason among those that are off. `any` needs one: it
 * is available as soon as one path is, and otherwise reports the INNERMOST
 * reason, because moving that one layer is enough to open the capability.
 */
function modulesReason(
  def: AiCapabilityDefinition,
  moduleAccess: Readonly<Record<ModuleKey, ModuleAccessState>>,
): AiUnavailableReason | null {
  const { mode, keys } = def.modules;
  if (keys.length === 0) return null;
  const reasons = keys.map((key) =>
    moduleReason(key, moduleAccess[key] ?? "unavailable"),
  );
  if (mode === "all") return outermost(reasons);
  if (reasons.some((reason) => reason === null)) return null;
  return innermost(reasons as AiUnavailableReason[]);
}

/** The entries in the order this capability would pick from. */
function orderedEntries(
  def: AiCapabilityDefinition,
  entries: readonly ProviderEntryPresence[],
): readonly ProviderEntryPresence[] {
  if (def.providerOrder === "chain") return entries;
  // A stable sort keeps the person's own order within a rank.
  return [...entries].sort(
    (a, b) =>
      documentProviderRank(a.providerType) -
      documentProviderRank(b.providerType),
  );
}

/**
 * The single provider a document read would use, or null when none can. The
 * first vision-capable entry wins; failing that, a text-only provider reads the
 * text the person's in-browser OCR produced, if they turned that on.
 */
function documentPick(
  def: AiCapabilityDefinition,
  provider: ProviderPresence,
): ProviderEntryPresence | null {
  const ordered = orderedEntries(def, provider.entries);
  const vision = ordered.find((entry) => entry.vision);
  if (vision) return vision;
  if (provider.localOcrEnabled && ordered.length > 0) return ordered[0]!;
  return null;
}

function providerReason(
  def: AiCapabilityDefinition,
  provider: ProviderPresence,
): AiUnavailableReason | null {
  if (def.modality === "document") {
    return documentPick(def, provider) === null ? "no_provider" : null;
  }
  return provider.entries.length === 0 ? "no_provider" : null;
}

/** Does serving this capability need a consent receipt? */
function consentNeeded(
  def: AiCapabilityDefinition,
  provider: ProviderPresence,
): boolean {
  if (def.consent.rule === "self-snapshot") {
    // A cascade may fall through to any entry, so one operator-held entry
    // anywhere in the chain is enough to need the receipt.
    return provider.entries.some((entry) =>
      OPERATOR_HELD_PROVIDER_TYPES.has(entry.providerType),
    );
  }
  if (def.modality === "document") {
    // Document reads call the one picked provider, no cascade.
    const pick = documentPick(def, provider);
    return pick !== null && pick.providerType !== LOCAL_PROVIDER_TYPE;
  }
  // Text under the document rule cascades like a snapshot does, so any entry
  // that leaves the machine needs the receipt.
  return provider.entries.some(
    (entry) => entry.providerType !== LOCAL_PROVIDER_TYPE,
  );
}

function consentReason(
  def: AiCapabilityDefinition,
  provider: ProviderPresence,
  activeKinds: ReadonlySet<string>,
): AiUnavailableReason | null {
  if (!consentNeeded(def, provider)) return null;
  return def.consent.kinds.some((kind) => activeKinds.has(kind))
    ? null
    : "consent_required";
}

function stateFor(reason: AiUnavailableReason | null): AiCapabilityState {
  if (reason === null) {
    return { available: true, reason: null, onDeviceAllowed: true };
  }
  return {
    available: false,
    reason,
    onDeviceAllowed: ON_DEVICE_ALLOWED_REASONS.has(reason),
  };
}

/** Resolve one capability. `null` inputs mean the loader failed. */
export function resolveAiCapability(
  key: AiCapabilityKey,
  inputs: AiCapabilityInputs | null,
): AiCapabilityState {
  if (inputs === null) return stateFor("check_failed");
  const def = AI_CAPABILITIES[key];
  const { switches } = inputs;
  return stateFor(
    outermost([
      !switches.enabled || !switches[def.operatorSwitch]
        ? "operator_disabled"
        : null,
      inputs.providerWorkAdmitted ? null : "not_permitted_for_record",
      modulesReason(def, inputs.moduleAccess),
      providerReason(def, inputs.provider),
      consentReason(def, inputs.provider, inputs.activeConsentKinds),
    ]),
  );
}

/** Resolve every capability. `null` inputs resolve all to `check_failed`. */
export function resolveAiCapabilities(
  inputs: AiCapabilityInputs | null,
): Record<AiCapabilityKey, AiCapabilityState> {
  const out = {} as Record<AiCapabilityKey, AiCapabilityState>;
  for (const key of AI_CAPABILITY_KEYS) {
    out[key] = resolveAiCapability(key, inputs);
  }
  return out;
}

/** The account-level provider block. */
export function resolveAiProviderState(
  inputs: AiCapabilityInputs | null,
): AiProviderState {
  if (inputs === null) {
    return { configured: false, managedBy: null, canConfigure: false };
  }
  return {
    configured: inputs.provider.entries.length > 0,
    managedBy: inputs.provider.managedBy,
    canConfigure: inputs.recordKind === "self" && inputs.switches.enabled,
  };
}

/** The whole `ai` block. */
export function resolveAiBlock(
  inputs: AiCapabilityInputs | null,
): AiCapabilities {
  return {
    capabilities: resolveAiCapabilities(inputs),
    provider: resolveAiProviderState(inputs),
  };
}
