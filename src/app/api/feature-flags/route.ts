/**
 * `GET /api/feature-flags` — the operator's assistant switches. DEPRECATED.
 *
 * The answer a client needs is not the switch set but what the switches, the
 * record's modules, the provider-work authority, the provider and consent add
 * up to, per capability. That is `ai` on `GET /api/auth/me`, and it is what
 * every client reads from this release on. This route stays a projection of
 * the operator switches alone, for clients that have not moved yet, and is
 * removed in the first release after the native build that reads `ai` ships:
 *
 *   { "data": { "assistant": { "enabled", "coach", "briefing",
 *                              "insightStatus", "documentAi" } } }
 *
 * The master is applied (every sub-switch reads false when it is off), and a
 * switch read that fails answers every switch off. The response carries
 * `Deprecation: true` and a `Link` to its successor.
 *
 * `Cache-Control: private, max-age=60`: switches flip rarely.
 */
import type { NextRequest } from "next/server";

import { apiHandler, requireActorAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { getAssistantFlags } from "@/lib/feature-flags";
import { annotate } from "@/lib/logging/context";

export const GET = apiHandler(async (_request: NextRequest) => {
  // An actor surface, and the easiest call in the set: the answer comes off
  // the `AppSettings` singleton and reads no user row at all, so there is no
  // record for a switch to substitute. It stays reachable while a switch is on
  // because the shell needs it on every page — the Coach launcher and the
  // assistant surfaces are gated on it, and a 403 here is a piece of chrome
  // that decides it does not exist.
  //
  // Declared rather than left bare so the reasoning is recorded: it answers
  // about the DEPLOYMENT, which for this purpose is the caller's side of the
  // request, not the record's.
  await requireActorAuth();
  annotate({
    action: { name: "feature-flags.read" },
    meta: { deprecated: true },
  });

  const assistant = await getAssistantFlags();

  const response = apiSuccess({ assistant });
  response.headers.set("Cache-Control", "private, max-age=60");
  response.headers.set("Deprecation", "true");
  response.headers.set("Link", '</api/auth/me>; rel="successor-version"');
  return response;
});
