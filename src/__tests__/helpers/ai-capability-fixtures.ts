/**
 * Capability states for test fixtures, so a fixture names the state it means
 * rather than spelling the object out.
 */
import {
  ON_DEVICE_ALLOWED_REASONS,
  type AiCapabilityState,
  type AiUnavailableReason,
} from "@/lib/ai/capabilities/types";
import type { DailyDigestAi } from "@/lib/daily/digest";

export const AI_AVAILABLE: AiCapabilityState = Object.freeze({
  available: true,
  reason: null,
  onDeviceAllowed: true,
});

export function aiUnavailable(reason: AiUnavailableReason): AiCapabilityState {
  return {
    available: false,
    reason,
    onDeviceAllowed: ON_DEVICE_ALLOWED_REASONS.has(reason),
  };
}

/** Every AI part of the daily digest available. */
export const DIGEST_AI_AVAILABLE: DailyDigestAi = Object.freeze({
  briefing: AI_AVAILABLE,
  coach: AI_AVAILABLE,
  reactionLines: AI_AVAILABLE,
});
