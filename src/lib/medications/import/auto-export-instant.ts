/**
 * Reading an instant that carries its own UTC offset.
 *
 * The medication export writes `2023-02-16 08:38:00 +1030` — a space instead
 * of `T`, and a compact offset with no colon. Neither form is ISO 8601, so
 * `new Date(...)` on it is engine-dependent leniency rather than a contract:
 * V8 happens to accept it, another runtime need not, and a silent `Invalid
 * Date` or a reinterpretation in the server's zone would move every dose in
 * the file by hours. A file spanning an Australian summer carries `+1030` and
 * `+0930` on adjacent rows, so the offset is per-row data, not a file-level
 * setting to be guessed at once.
 *
 * So the offset is read explicitly and the epoch computed arithmetically:
 * `Date.UTC(wall clock) - offset`. Nothing here parses a date from a string
 * through the platform. A value without an offset is refused rather than
 * assumed — the server's zone is not evidence about where the dose was taken.
 *
 * `src/lib/tz/` is the project's timezone layer and it stays the authority for
 * the other direction (an instant plus a zone name to a local day key, which
 * is what the compliance rollups key on). It carries no parser, by design: it
 * converts an offset-less wall clock plus a zone NAME to UTC. An offset is not
 * a zone name, so this is the one thing it cannot do, and this module is
 * deliberately the narrowest possible complement to it.
 */

/** Widest real UTC offset in either direction (±14:00, Kiritimati). */
const MAX_OFFSET_MINUTES = 14 * 60;

/**
 * `YYYY-MM-DD` `HH:MM:SS` with an optional fractional second, then either `Z`
 * or a `±HHMM` / `±HH:MM` offset. Both the space and the `T` separator are
 * accepted: the CSV uses a space, and a hand-edited file may well use `T`.
 */
const OFFSET_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?\s*(?:(Z|z)|([+-])(\d{2}):?(\d{2}))$/;

export type AutoExportInstantFailure =
  /** The cell was blank. Distinct from unreadable: nothing was stated. */
  | "absent"
  /** Shaped like a timestamp but carries no offset, so the instant is unknown. */
  | "missing_offset"
  /** Does not match the documented `yyyy-MM-dd HH:mm:ss Z` shape at all. */
  | "unreadable"
  /** Matches the shape but names no real instant (month 13, offset ±99:00). */
  | "out_of_range";

export type AutoExportInstantResult =
  | { ok: true; instant: Date; offsetMinutes: number }
  | { ok: false; failure: AutoExportInstantFailure };

/**
 * True when the value looks like a date-time that simply lost its offset, so
 * the refusal can say "no offset" rather than the less useful "unreadable".
 */
const OFFSETLESS_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d{1,9})?$/;

/**
 * Parse one `Date` / `Scheduled Date` cell.
 *
 * Returns the absolute instant and the offset that produced it. The offset is
 * handed back rather than discarded so a caller can prove, in a test, that the
 * value the file stated is the value that survived.
 */
export function parseAutoExportInstant(
  raw: string | null | undefined,
): AutoExportInstantResult {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: false, failure: "absent" };

  const match = OFFSET_INSTANT_RE.exec(value);
  if (!match) {
    return {
      ok: false,
      failure: OFFSETLESS_INSTANT_RE.test(value)
        ? "missing_offset"
        : "unreadable",
    };
  }

  const [, y, mo, d, h, mi, s, zulu, sign, offH, offM] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { ok: false, failure: "out_of_range" };
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return { ok: false, failure: "out_of_range" };
  }

  let offsetMinutes = 0;
  if (!zulu) {
    const offsetHours = Number(offH);
    const offsetRemainder = Number(offM);
    if (offsetRemainder > 59) return { ok: false, failure: "out_of_range" };
    offsetMinutes =
      (sign === "-" ? -1 : 1) * (offsetHours * 60 + offsetRemainder);
    if (Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) {
      return { ok: false, failure: "out_of_range" };
    }
  }

  // `Date.UTC` rolls a nonexistent calendar day over (Feb 30 becomes Mar 2),
  // so the components are read back and compared. A rolled-over value means
  // the file named a day that does not exist, which is a refusal, not a
  // silently shifted dose.
  const wallClockMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(wallClockMs);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return { ok: false, failure: "out_of_range" };
  }

  const instant = new Date(wallClockMs - offsetMinutes * 60_000);
  if (Number.isNaN(instant.getTime())) {
    return { ok: false, failure: "out_of_range" };
  }
  return { ok: true, instant, offsetMinutes };
}
