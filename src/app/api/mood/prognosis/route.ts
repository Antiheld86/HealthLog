/**
 * `GET /api/mood/prognosis` — the day's two readings, side by side.
 *
 * The person's own rating leads and is returned exactly as it was stored. The
 * forecast rides beside it with its band, the number of days it was built
 * from, and how old it is. The two are never merged: the distance between them
 * is the whole finding, and a single blended number would destroy it.
 *
 * **This route declares `record`, not `mind`, and that is the security
 * decision on it.** The payload is not only mood: the fit reads the day's
 * level-B context AND the figures the sleep, activity and recovery modules
 * hold, and the contributions it publishes name those features one by one — a
 * reader can see that sleep or steps or resting heart rate carried weight on a
 * given day, and roughly how much. Declared `mind` it would be a hole with a
 * mood-shaped label on it: a delegate holding only the mind section would
 * receive a derived view of two sections the owner had declined to share. The
 * convention for a read that crosses sections is `record`
 * (`/api/mood/linked-context`, `/api/dashboard/snapshot`, `/api/daily/digest`
 * are the precedents) and a scoped grant never reaches one, so a scoped
 * delegate loses the forecast entirely rather than receiving a filtered
 * version of it. A filtered version would be worse: a contribution list with
 * the linked features quietly removed would tell the reader that the model
 * weighted only the mood fields, which is false.
 *
 * Nothing here writes. The rows come from the nightly job and the user cannot
 * overwrite them — `src/__tests__/mood-prediction-write-surface-guard.test.ts`
 * holds that, and this file is one of the ones it scans.
 */
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { readMoodPrognosis } from "@/lib/analytics/mood-prognosis/read";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  // `record`: see the file header. A scoped grant is refused here by
  // construction rather than served a narrowed payload.
  const { user } = await requireRecordAuth("read", "record");

  const gate = await requireModuleEnabled(user.id, "mood");
  if (!gate.enabled) return gate.response;

  const reading = await readMoodPrognosis(user.id, new Date(), user.timezone);

  annotate({
    action: { name: "mood.prognosis.read" },
    meta: reading.present
      ? {
          present: true,
          day: reading.date,
          fit_rows: reading.n,
          age_days: reading.ageDays,
          current: reading.current,
          provisional: reading.provisional,
          deviation: reading.deviation,
        }
      : { present: false, reason: reading.reason, entries: reading.entries },
  });

  return apiSuccess(reading);
});
