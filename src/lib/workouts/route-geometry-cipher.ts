/**
 * Workout GPS track ↔ encrypted column (v1.39.4).
 *
 * `WorkoutRoute.geometry` held the GeoJSON LineString of every outdoor workout
 * readable in the database, and the first and last points of most tracks are
 * the person's front door. From v1.39.4 the track is stored in
 * `geometryEncrypted`: the JSON text sealed as one binary AES-256-GCM value
 * (`encryptBytes`, labelled with {@link WORKOUT_ROUTE_GEOMETRY_AAD}). The
 * binary codec rather than the base64 string codec the notes use, because a
 * track of 20 000 points is a blob and base64 would add a third to it.
 *
 * Every reader goes through {@link readRouteGeometry}: the ciphertext when a
 * row has one, the legacy readable column for a row the boot-time backfill has
 * not reached yet. A ciphertext that does not open reads as no track, with a
 * warning on the request's event: it is never replaced by the readable column,
 * and one damaged track must not fail the workout detail or the insight job
 * that reads it. `decryptRouteGeometry` itself still throws.
 *
 * The wire shape is unchanged: readers hand back the same GeoJSON object the
 * JSONB column used to return.
 */
import { Buffer } from "node:buffer";

import { decryptBytes, encryptBytes } from "@/lib/crypto";
import { WORKOUT_ROUTE_GEOMETRY_AAD } from "@/lib/crypto/encrypted-columns";
import { getEvent } from "@/lib/logging/context";

/** Seal a route's GeoJSON geometry for `WorkoutRoute.geometryEncrypted`. */
export function encryptRouteGeometry(
  geometry: unknown,
): Uint8Array<ArrayBuffer> {
  const sealed = encryptBytes(
    Buffer.from(JSON.stringify(geometry), "utf8"),
    WORKOUT_ROUTE_GEOMETRY_AAD,
  );
  const out = new Uint8Array(new ArrayBuffer(sealed.byteLength));
  out.set(sealed);
  return out;
}

/** Open a sealed route geometry. Throws on a bad key id or a tampered value. */
export function decryptRouteGeometry(sealed: Uint8Array): unknown {
  const plain = decryptBytes(Buffer.from(sealed), WORKOUT_ROUTE_GEOMETRY_AAD);
  return JSON.parse(plain.toString("utf8")) as unknown;
}

/**
 * The geometry a route row holds: the ciphertext first, the legacy readable
 * column only when there is no ciphertext. Null when the row holds neither,
 * and null (with a warning) when the ciphertext does not open.
 */
export function readRouteGeometry(row: {
  geometry?: unknown;
  geometryEncrypted?: Uint8Array | null;
}): unknown {
  if (row.geometryEncrypted && row.geometryEncrypted.byteLength > 0) {
    try {
      return decryptRouteGeometry(row.geometryEncrypted);
    } catch (err) {
      getEvent()?.addWarning(
        `workout route decrypt failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
  return row.geometry ?? null;
}
