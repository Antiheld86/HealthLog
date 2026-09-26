import { shiftDateKey, userDayKey } from "@/lib/tz/format";

export interface StreakInfo {
  currentDays: number;
  longest: number;
}

/**
 * The current logging-day streak (days where any measurement or intake
 * event was recorded, in the user's zone) plus the longest streak among
 * `activityDays`.
 *
 * `activityDays` holds `YYYY-MM-DD` keys already cut in `userTz`. The walk
 * steps through day KEYS (`shiftDateKey`), never instants: stepping back from
 * UTC midnight of today's key read that instant in the user's zone, which
 * west of UTC is still yesterday, so the streak started one day early and
 * came out one day short. Yesterday counts as the streak's head when today
 * has not been logged yet.
 */
export function computeStreak(
  activityDays: ReadonlySet<string>,
  userTz: string,
  now: Date = new Date(),
): StreakInfo {
  if (activityDays.size === 0) return { currentDays: 0, longest: 0 };

  const sorted = [...activityDays].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (shiftDateKey(sorted[i - 1], 1) === sorted[i]) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  let cursor = userDayKey(now, userTz);
  if (!activityDays.has(cursor)) cursor = shiftDateKey(cursor, -1);
  let currentDays = 0;
  while (activityDays.has(cursor)) {
    currentDays += 1;
    cursor = shiftDateKey(cursor, -1);
  }
  return { currentDays, longest };
}
