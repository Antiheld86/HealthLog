"use client";

/**
 * v1.18.0 (S5) — Settings → Coach.
 *
 * The Coach preference cards moved out of the AI / Assistant section into
 * their own dedicated entry so the AI section owns only provider / model /
 * BYOK configuration. This section gathers the Coach-specific surface:
 *
 *   1. Disable Coach    — the per-user opt-out (kept first so a user who
 *                         wants the surface gone finds it immediately).
 *   2. Coach preferences — tone, verbosity, data scope (`useCoachPrefs`).
 *   3. Proactive nudge   — the daily-nudge opt-out + per-group frequency
 *                          (moved here from Settings → Benachrichtigungen in
 *                          v1.18.6: it is a Coach setting, not a generic
 *                          notification).
 *   4. Coach memory      — durable-fact review + forget controls.
 *
 * The nav entry is module-gated on `coach`. The preference + nudge cards
 * keep their own content gate on `!user.disableCoach`: hiding the Coach hides
 * its tuning. The memory (facts, stored conversations and reminders) is never
 * gated: it is the person's own record, readable and deletable whatever the
 * Coach's state. The reminders card turns read-only while the Coach is
 * unavailable and, with the Coach hidden, shows only when rows exist.
 *
 * The "about me" context lives in the AI section, not here — the daily
 * briefing reads it too, so it is not a Coach-only setting.
 *
 * v1.18.6 (W9) — the visible heading + subtitle now come from the shared
 * `<SettingsSectionFrame>` in the route; this body is the Coach cards only.
 */

import { DisableCoachCard } from "@/components/settings/ai/disable-coach-card";
import { CoachMemorySection } from "@/components/settings/coach-memory-section";
import { CoachConversationsMemoryCard } from "@/components/settings/coach-conversations-memory-card";
import { CoachRemindersSection } from "@/components/settings/coach-reminders-section";
import { CoachNudgeCard } from "@/components/settings/coach-nudge-card";
import { CoachPrefsSection } from "@/components/settings/coach-prefs-section";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";

export function CoachSection() {
  const { isAuthenticated, user } = useAuth();
  // Mirror the AI section's hydration-safe gating: the auth query can
  // resolve before this boundary hydrates, so gate the child props on
  // `useMounted()` to keep the hydration render matching the SSR HTML.
  const mounted = useMounted();
  const authed = mounted && isAuthenticated;
  // The preference + memory cards ride the same content gate as the rest
  // of the Coach surface: when the user has hidden the Coach there is no
  // assistant to tune or remember anything. (`mounted`-gated so the SSR +
  // hydration renders agree.)
  const coachEnabled = !mounted || !user?.disableCoach;

  return (
    <div className="space-y-6">
      <DisableCoachCard isAuthenticated={authed} />

      {coachEnabled && <CoachPrefsSection isAuthenticated={authed} />}

      {/* Proactive Coach nudge — moved here from Benachrichtigungen (v1.18.6).
          Keeps the `#coach-nudge` anchor so existing deep links resolve. */}
      {coachEnabled && (
        <div id="coach-nudge" className="scroll-mt-28">
          <CoachNudgeCard isAuthenticated={isAuthenticated} />
        </div>
      )}

      <CoachMemorySection isAuthenticated={authed} />

      <CoachConversationsMemoryCard isAuthenticated={authed} />

      <CoachRemindersSection
        isAuthenticated={authed}
        hideWhenEmpty={!coachEnabled}
      />
    </div>
  );
}
