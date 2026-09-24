"use client";

import { useAuth } from "@/hooks/use-auth";
import { useQueryClientMounted } from "@/hooks/_internal/use-query-client-safe";
import type {
  AiCapabilityKey,
  AiCapabilityState,
  AiProviderState,
} from "@/lib/ai/capabilities/types";

/**
 * The web reader for the `ai` block on `GET /api/auth/me`.
 *
 * The server resolves every AI capability for the record this browser is
 * inside, from every layer that can say no, and publishes the answer with the
 * reason. This hook hands that answer to a surface and adds exactly one rule
 * of its own: until the answer is known, a capability is unavailable. While
 * `/me` is loading, when no query client is mounted (an isolated
 * presentational render), or when the payload carries no well-formed block,
 * the hook answers `check_failed`, so no AI surface paints and no model
 * request fires on first render only to be refused. Failing open was how AI
 * chrome used to flash and fire refusals before the switch set arrived.
 *
 * Never recompute a capability here or in a component; branch on
 * `available`, and on `reason` only to say why.
 */
const UNKNOWN: AiCapabilityState = Object.freeze({
  available: false,
  reason: "check_failed",
  onDeviceAllowed: false,
});

const NO_PROVIDER_STATE: AiProviderState = Object.freeze({
  configured: false,
  managedBy: null,
  canConfigure: false,
});

/** One capability, for the record this browser is inside. */
export function useAiCapability(key: AiCapabilityKey): AiCapabilityState {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return UNKNOWN;
  // The branch is stable for the component's lifetime (a provider is either
  // mounted around it or not), so the conditional hook call is safe.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useAiCapabilityInner(key);
}

function useAiCapabilityInner(key: AiCapabilityKey): AiCapabilityState {
  const { user } = useAuth();
  return user?.ai?.capabilities?.[key] ?? UNKNOWN;
}

/** The account's provider state: configured, managed by whom, configurable here. */
export function useAiProviderState(): AiProviderState {
  const hasClient = useQueryClientMounted();
  if (!hasClient) return NO_PROVIDER_STATE;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useAiProviderStateInner();
}

function useAiProviderStateInner(): AiProviderState {
  const { user } = useAuth();
  return user?.ai?.provider ?? NO_PROVIDER_STATE;
}
