/**
 * `GET /api/mood/linked-context?date=YYYY-MM-DD&tz=…` — what the modules that
 * own sleep, activity, vitals and body symptoms already know about one day.
 *
 * Keyed by the local day rather than by an entry id, deliberately: the capture
 * sheet needs these figures BEFORE an entry exists, and a route that could
 * only answer for a saved row would leave the one surface that most wants them
 * unable to ask. The capture sheet sends the browser's zone, which is the zone
 * the day it is about to write will be anchored to; the edit dialog sends the
 * entry's stored `tz`, so an entry logged in another country keeps its own day
 * boundaries instead of being re-read under whichever zone the correction is
 * being made from.
 *
 * Nothing here is stored on the mood row. Every figure is read from its owning
 * module on each request, which is what makes a corrected sleep session show
 * up on the mood entry with nothing to re-sync.
 *
 * **This route declares `record`, not `mind`, and that is the whole security
 * decision on it.** Its payload is sleep minutes, steps, active energy,
 * resting heart rate, heart-rate variability and an illness day-log with its
 * symptom keys — the `measurements` and `illness` sections, reached from a
 * mood surface. Declared as `mind` it was a hole with a mood-shaped label on
 * it: a delegate given only the mind section could walk arbitrary dates
 * through this one URL and read two sections the owner had declined to share,
 * and no mood entry needed to exist for any of those dates. `record` is the
 * convention for a read that crosses sections (`/api/dashboard/snapshot`,
 * `/api/daily/digest` are the precedents) and a scoped grant never reaches
 * one, so a scoped delegate loses the linked block entirely rather than
 * receiving a filtered version of it. That is the honest answer: a block that
 * silently dropped the sections a grant does not cover would show a day that
 * looks empty where the truth is that it is none of the reader's business.
 */
import { NextRequest } from "next/server";
import { z } from "zod/v4";

import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { resolveLinkedDayContext } from "@/lib/mood/linked-context";
import { DEFAULT_TIMEZONE } from "@/lib/mood/date-key";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // The zone the day is anchored to. Absent falls back to the account's own
  // display timezone; the edit dialog passes the entry's stored `tz` so a row
  // logged elsewhere keeps its own day boundaries.
  tz: z.string().min(1).max(64).optional(),
});

export const GET = apiHandler(async (request: NextRequest) => {
  // `record`: see the file header. A scoped grant is refused here by
  // construction rather than served a narrowed payload.
  const { user } = await requireRecordAuth("read", "record");

  const gate = await requireModuleEnabled(user.id, "mood");
  if (!gate.enabled) return gate.response;

  const parsed = querySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    annotate({
      action: { name: "mood.linked-context.validation-failed" },
      meta: { issue_count: parsed.error.issues.length },
    });
    return returnAllZodIssues(parsed.error, 422, {
      errorCode: "mood.linkedContext.invalid",
    });
  }

  const linked = await resolveLinkedDayContext(user.id, {
    date: parsed.data.date,
    tz: parsed.data.tz ?? user.timezone ?? DEFAULT_TIMEZONE,
  });

  annotate({
    action: { name: "mood.linked-context.read" },
    // Which blocks the person can see at all, so a support question about a
    // missing figure can be answered without asking them to describe their
    // module settings.
    meta: {
      day: linked.day,
      sleep_available: linked.sleep.available,
      activity_available: linked.activity.available,
      body_available: linked.body.available,
    },
  });

  return apiSuccess(linked);
});
