"use client";

import { useQuery } from "@tanstack/react-query";

import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/**
 * One reconstructed night from `GET /api/sleep/night?date=YYYY-MM-DD`.
 *
 * The date is the WAKE day: the night a person woke from into that day.
 * The server owns the reconstruction (stage folding, cross-source pick,
 * WHOOP timeline synthesis) and the day keying, so this hook only carries
 * the resolved figures across.
 *
 * The route is gated on the `sleep` module and answers 403 when it is off.
 * Callers gate the mount on `useModuleEnabled("sleep")` so a switched-off
 * module never paints as a failed read.
 */
export interface SleepNightSegment {
  stage: string;
  start: string;
  end: string;
  minutes: number;
}

export interface SleepNightSession {
  /** `YYYY-MM-DD` wake-day key. */
  night: string;
  source: string | null;
  start: string;
  end: string;
  asleepMinutes: number;
  inBedMinutes: number | null;
  awakeMinutes: number | null;
  /** Mid-sleep awakenings. `0` is a real answer, not an absence. */
  awakenings: number;
  reconstructed: boolean;
  stages: Record<string, number>;
  segments: SleepNightSegment[];
}

export interface SleepNightPayload {
  night: string | null;
  /** `null` when nothing scorable was recorded for that night. */
  main: SleepNightSession | null;
  naps: SleepNightSession[];
}

export interface UseSleepNightResult {
  /** `undefined` until the route has answered — never confuse it with a
   *  night that carried nothing. */
  data: SleepNightPayload | undefined;
  isError: boolean;
  refetch: () => void;
}

/**
 * Reads the night a person woke from into `date`.
 *
 * `enabled` is the caller's gate — pass `false` when the user is signed
 * out or the sleep module is disabled, and nothing is fetched.
 */
export function useSleepNight(
  date: string | undefined,
  enabled: boolean,
): UseSleepNightResult {
  const { data, isError, refetch } = useQuery({
    queryKey: queryKeys.sleepNight(date),
    queryFn: () =>
      apiGet<SleepNightPayload>(
        `/api/sleep/night?date=${encodeURIComponent(date as string)}`,
      ),
    enabled: enabled && Boolean(date),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  return { data, isError, refetch: () => void refetch() };
}
