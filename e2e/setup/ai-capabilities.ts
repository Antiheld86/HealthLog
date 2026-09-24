/**
 * Serve `GET /api/auth/me` with a chosen `ai` block.
 *
 * Every AI surface on the web renders from the capability map `/me` carries,
 * and nothing else. The operator's switches are instance-wide, so flipping
 * the real master switch in one spec would switch AI off under every spec
 * running beside it; a real provider cannot be reached from the suite at all.
 * A journey that asserts what the web does in one AI state therefore takes
 * the real `/me` answer and replaces only its `ai` block, and states the
 * limit plainly: it proves the web's rendering and its requests for that
 * state. What the server publishes for which inputs is proven by the
 * resolver's unit tests and `tests/integration/auth-me-ai-capabilities`.
 */
import type { Page } from "@playwright/test";

export const AI_CAPABILITY_KEYS = [
  "coach",
  "briefing",
  "periodNarrative",
  "statusText",
  "workoutInsights",
  "reactionLines",
  "aboutMeQuestions",
  "documentAi",
  "labsOcr",
  "medicationExtract",
] as const;

type Reason =
  | "operator_disabled"
  | "not_permitted_for_record"
  | "module_disabled"
  | "user_disabled"
  | "no_provider"
  | "consent_required"
  | "check_failed";

interface AiBlock {
  capabilities: Record<
    string,
    { available: boolean; reason: Reason | null; onDeviceAllowed: boolean }
  >;
  provider: {
    configured: boolean;
    managedBy: "user" | "local" | "server" | null;
    canConfigure: boolean;
  };
}

/** Every capability unavailable for one reason. */
export function aiBlockUnavailable(
  reason: Reason,
  provider: AiBlock["provider"],
): AiBlock {
  const onDeviceAllowed =
    reason === "no_provider" || reason === "consent_required";
  return {
    capabilities: Object.fromEntries(
      AI_CAPABILITY_KEYS.map((key) => [
        key,
        { available: false, reason, onDeviceAllowed },
      ]),
    ),
    provider,
  };
}

/** Every capability available, a provider of the person's own. */
export function aiBlockAvailable(): AiBlock {
  return {
    capabilities: Object.fromEntries(
      AI_CAPABILITY_KEYS.map((key) => [
        key,
        { available: true, reason: null, onDeviceAllowed: true },
      ]),
    ),
    provider: { configured: true, managedBy: "user", canConfigure: true },
  };
}

/** Replace the `ai` block of every `/api/auth/me` answer on this page. */
export async function serveAiBlock(page: Page, ai: AiBlock): Promise<void> {
  await page.route("**/api/auth/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      data: Record<string, unknown> | null;
    };
    if (body.data) body.data.ai = ai;
    await route.fulfill({ response, json: body });
  });
}
