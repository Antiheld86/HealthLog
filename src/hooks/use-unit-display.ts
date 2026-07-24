"use client";

/**
 * v1.32.26 — the single client choke point for metric/imperial display.
 *
 * Reads the user's `unitPreference` from the cached `/api/auth/me` payload
 * (`useAuth`, keyed under `queryKeys.authMe()`, invalidated by the settings
 * select on change — no extra fetch) and hands back preference-bound sugar
 * over `getDisplayTransform`. Every render surface that shows a measurement
 * value or unit for a type in `TRANSFORMS` resolves through this hook, so the
 * preference is honoured in exactly one place and no surface hardcodes a unit
 * string or scale.
 *
 * The underlying `display-transform.ts` module stays pure and server-safe (it
 * is imported by an API route); only this thin wrapper is a client hook.
 */
import { useMemo } from "react";

import { useAuth } from "@/hooks/use-auth";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getDisplayTransform,
  invertDisplayTransform,
  hasDisplayTransform,
  type DisplayTransform,
  type UnitPreference,
} from "@/lib/measurements/display-transform";

export interface UnitDisplay {
  /** Resolved preference ("metric" by default / on a stale payload). */
  preference: UnitPreference;
  /** The full transform for a type under the current preference. */
  transformFor: (type: string) => DisplayTransform;
  /** Convert a raw canonical ABSOLUTE value to the display value. */
  toDisplay: (type: string, rawValue: number) => number;
  /** Convert a display ABSOLUTE value back to canonical (entry boundary). */
  fromDisplay: (type: string, displayValue: number) => number;
  /** Convert a DELTA / slope / SD — factor only, never the affine offset. */
  toDisplayDelta: (type: string, deltaValue: number) => number;
  /** The display unit symbol for a type under the current preference. */
  unitFor: (type: string) => string;
  /** Display decimal places for a type under the current preference. */
  decimalsFor: (type: string) => number;
  /** True when a type actually rescales under preference (vs identity). */
  isTransformed: (type: string) => boolean;
}

export function useUnitDisplay(): UnitDisplay {
  const { user } = useAuth();
  const preference: UnitPreference =
    user?.unitPreference === "imperial" ? "imperial" : "metric";

  return useMemo<UnitDisplay>(() => {
    const transformFor = (type: string) =>
      getDisplayTransform(type, preference);
    return {
      preference,
      transformFor,
      toDisplay: (type, rawValue) =>
        applyDisplayTransform(rawValue, transformFor(type)),
      fromDisplay: (type, displayValue) =>
        invertDisplayTransform(displayValue, transformFor(type)),
      toDisplayDelta: (type, deltaValue) =>
        applyDisplayTransformDelta(deltaValue, transformFor(type)),
      unitFor: (type) => transformFor(type).displayUnit,
      decimalsFor: (type) => transformFor(type).decimals,
      isTransformed: (type) => hasDisplayTransform(type),
    };
  }, [preference]);
}
