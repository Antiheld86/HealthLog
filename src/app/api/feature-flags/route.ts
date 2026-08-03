/**
 * `GET /api/feature-flags` — operator-side assistant flag matrix.
 *
 * Projects `AppSettings.assistant*Enabled` over HTTP so every client
 * (web React tree + iOS native) reads the same authoritative shape.
 *
 * Response envelope:
 *
 *   {
 *     "data": {
 *       "assistant": {
 *         "enabled": true,
 *         "coach": true,
 *         "briefing": true,
 *         "insightStatus": true,
 *         "correlations": true
 *       }
 *     },
 *     "error": null
 *   }
 *
 * - `requireActorAuth()` — any logged-in user, including one acting on
 *   somebody else's record. Per-request flag fetches from the iOS native
 *   client always arrive after auth, so the gate matches the rest of the
 *   read-only profile surface; the mode is argued at the call site.
 * - Master kills every sub-flag in the resolver before the shape
 *   leaves the handler, so callers never have to compose
 *   `master && sub`.
 * - `Cache-Control: private, max-age=60` — operator toggles flip
 *   rarely; a 60-second per-session cache keeps the cost off the
 *   hot /insights mount path while still propagating an admin
 *   change within a minute.
 *
 * Locked per `.planning/RESPONSE-TO-IOS-TEAM-2026-05-16.md` §3 R5
 * and `.planning/research/v15-assistant-optional.md` Part D.
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
  annotate({ action: { name: "feature-flags.read" } });

  const assistant = await getAssistantFlags();

  const response = apiSuccess({ assistant });
  response.headers.set("Cache-Control", "private, max-age=60");
  return response;
});
