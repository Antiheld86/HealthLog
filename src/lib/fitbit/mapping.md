# Fitbit Web API field → Measurement mapping

Single source of truth for the classic Fitbit Web API (`api.fitbit.com`) →
HealthLog `Measurement` mapping. Keep this in sync with `FITBIT_FIELD_MAP` and
the per-type mappers in `client.ts`. Every Fitbit row ingests server-side with
`source = FITBIT`; the `externalId` is a stable per-reading key so a re-fetch of
the same window overwrites in place rather than minting a duplicate.

Transport: v1.20.0 retargeted Fitbit from the Google Health API (Restricted
scopes behind brand-verification + CASA — a self-hoster adoption wall) onto the
classic Web API. A self-hoster registers an app at **dev.fitbit.com** in minutes
(no CASA). Auth: Authorization Code + **PKCE (S256)**;
`www.fitbit.com/oauth2/authorize` + `api.fitbit.com/oauth2/token`. Refresh tokens
**rotate** (one-time use) — the new token must be persisted every refresh.

Deprecation note: the classic Web API is announced for deprecation in September
2026, with migration directed back at the Google Health API. Until a self-serve
Google path exists, the classic API is the only viable transport for
self-hosters; the settings card keeps its experimental badge.

All data reads send `Accept-Language: en_GB` so weight + distance arrive in
metric (kg / km); the US default is imperial.

## Health-metrics endpoints

Scope: `weight`, `oxygen_saturation`, `heartrate`, `respiratory_rate`. Verified
against the dev.fitbit.com reference (response shapes quoted there).

| Endpoint                                       | MeasurementType          | Unit        | Source field                                | Grain | Note                                                        |
| ---------------------------------------------- | ------------------------ | ----------- | ------------------------------------------- | ----- | ----------------------------------------------------------- |
| `/1/user/-/body/log/weight/date/{s}/{e}.json`  | `WEIGHT`                 | kg          | `weight[].weight`                           | log   | externalId anchors on `logId`. Picker ranks Withings above. |
| `/1/user/-/body/log/fat/date/{s}/{e}.json`     | `BODY_FAT`               | %           | `fat[].fat`                                 | log   | externalId anchors on `logId`.                              |
| `/1/user/-/spo2/date/{s}/{e}.json`             | `OXYGEN_SATURATION`      | %           | `[].value.avg` (bare array)                 | daily | day-keyed externalId.                                       |
| `/1/user/-/hrv/date/{s}/{e}.json`              | `HEART_RATE_VARIABILITY` | ms          | `hrv[].value.dailyRmssd`                    | daily | RMSSD estimator → canonical HRV slot (not `HRV_RMSSD`).     |
| `/1/user/-/activities/heart/date/{s}/{e}.json` | `RESTING_HEART_RATE`     | bpm         | `activities-heart[].value.restingHeartRate` | daily | rows with no resting HR for the day are skipped.            |
| `/1/user/-/br/date/{s}/{e}.json`               | `RESPIRATORY_RATE`       | breaths/min | `br[].value.breathingRate`                  | daily |                                                             |

Each daily-summary value passes a finite + strictly-positive guard (a 0/NaN is a
garbage/empty reading and is dropped). Each endpoint caps its own date range
(30–31 days for these), so the sync chunks `[start, end]` into ≤30-day windows.

## Activity + VO2 max endpoints

Scope: `activity`, `cardio_fitness`. Per-day summaries; the externalId carries
the `stats:` daily-total prefix — `stats:<fieldTag>:<YYYY-MM-DD>` — so a
re-fetched day **overwrites** in place (Apple-Health `stats:<HK>:<YYYY-MM-DD>`
contract). The running totals **preserve a 0** (a rest day is real data); VO2 max
stays strictly positive.

| Endpoint                                                  | MeasurementType            | Unit        | Source field                          | Note                                                         |
| --------------------------------------------------------- | -------------------------- | ----------- | ------------------------------------- | ------------------------------------------------------------ |
| `/1/user/-/activities/steps/date/{s}/{e}.json`            | `ACTIVITY_STEPS`           | steps       | `activities-steps[].value` (string)   | daily total; 0 valid                                         |
| `/1/user/-/activities/distance/date/{s}/{e}.json`         | `WALKING_RUNNING_DISTANCE` | m           | `activities-distance[].value`         | km → m (×1000) under the metric locale                       |
| `/1/user/-/activities/activityCalories/date/{s}/{e}.json` | `ACTIVE_ENERGY_BURNED`     | kcal        | `activities-activityCalories[].value` | ACTIVE portion only (excludes BMR)                           |
| `/1/user/-/activities/floors/date/{s}/{e}.json`           | `FLIGHTS_CLIMBED`          | flights     | `activities-floors[].value`           | daily total; 0 valid                                         |
| `/1/user/-/cardioscore/date/{s}/{e}.json`                 | `VO2_MAX`                  | mL/(kg·min) | `cardioScore[].value.vo2Max`          | **string** — a single number or a `"lo-hi"` range → midpoint |

Activity time-series values arrive as numeric **strings** (`"2504"`). VO2 max
arrives as a string that may be a single value (`"45"`) or a range (`"44-48"`,
when no GPS run data exists) — the range resolves to its midpoint.

## Sleep endpoint

Scope: `sleep`. `/1.2/user/-/sleep/date/{s}/{e}.json` →
`sleep[].levels.data[]` (`{ dateTime, level, seconds }`). One `SLEEP_DURATION`
row **per segment**, `measuredAt = segment START + seconds = segment END`, value =
seconds → minutes. The 1.2 log carries a real per-segment series, so the rows lay
each block at its true clock time (a MEASURED timeline — rows are NOT flagged
reconstructed). externalId = `<logId>:sleep:<segment-start-ISO>` — the stable
session anchor plus the segment's own start instant, so a re-scored night
overwrites in place. The key carried a positional index and the stage label
until 2026-07-25; both moved on a re-score, which minted parallel rows the night
total then double-counted, so the key now carries neither and
`replaceStaleFitbitSleep` sweeps the night's window before the fresh set
upserts. The segment `dateTime` is local wall-clock ISO without an offset (the
night belongs to the user's local clock) — parsed as local time.

Stage map (stages logs + classic logs): `light → CORE` (Fitbit "light" ↔ Apple
"core" shallow-NREM band), `deep → DEEP`, `rem → REM`, `wake`/`awake`/`restless →
AWAKE`, classic `asleep → ASLEEP`, `in_bed → IN_BED`. Unknown labels are skipped,
not mis-bucketed.

## Workouts (activity log list)

Scope: `activity`. `/1/user/-/activities/list.json?afterDate=...&sort=asc&offset&limit`
→ `activities[]`. Each → one `Workout` row (NOT a Measurement), keyed
`(userId, source: "FITBIT", externalId=logId)`. Fields: `sportType`
(`activityName` → canonical `WorkoutSportType`, `other` fallback),
`startedAt`/`endedAt` (`startTime` + `duration` ms), `durationSec`,
`totalEnergyKcal` (`calories`), `totalDistanceM` (`distance` km → m),
`avgHeartRate` (`averageHeartRate`). The classic list endpoint does NOT surface
min/max HR, so those stay null. A Fitbit run and the same run via Apple Health /
WHOOP stay distinct rows; the read-time `pickCanonicalWorkoutRows` picker
collapses the cross-source twin (FITBIT ranks just below WHOOP in the default
ladder).

## Deliberately skipped

- **Intraday heart rate → `PULSE`.** The classic API gates intraday HR + step
  series behind a Personal-app type or a per-app intraday access request at
  dev.fitbit.com that most self-hosters do not have. Daily resting HR is always
  available and is synced; intraday is left out so a missing grant never parks
  the connection. (A per-endpoint 403 also soft-skips, as a safety net.)
- **Skin temperature.** `/1/user/-/temp/skin/...` returns
  `value.nightlyRelative` — a **delta from the user's personal baseline**, not an
  absolute temperature. Mapping a baseline delta into the absolute
  `WRIST_TEMPERATURE`/`BODY_TEMPERATURE` slot would write misleading values, so
  the metric is **not mapped** (and `temperature` is not requested). Revisit only
  if a relative-temperature slot is added.
- **Blood glucose / blood pressure.** No classic self-serve endpoint maps cleanly
  to the HealthLog slots at launch.

## Idempotency

`(userId, type, source: "FITBIT", externalId)` unique. Log-anchored metric rows:
`externalId = <logId>:<fieldTag>`. Daily-summary rows: `externalId =
<YYYY-MM-DD>:<fieldTag>`. Daily cumulative activity rows: `externalId =
stats:<fieldTag>:<YYYY-MM-DD>` (Apple-Health overwrite shape). Sleep:
`<logId>:sleep:<segment-start-ISO>`. Workouts: `(userId, source: "FITBIT", externalId)`
on the `Workout` table. A re-fetch of the same window (daily summaries settle
after the fact, so the incremental overlap is 24 h) overwrites in place.
