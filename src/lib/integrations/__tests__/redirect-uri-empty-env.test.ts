/**
 * The compose file passes every whitelisted variable through, so an unset
 * redirect URI reaches the process as an empty string. Every integration
 * treats an empty or blank value as unset and derives the callback from
 * `NEXT_PUBLIC_APP_URL`: Withings used to send `redirect_uri=` and Fitbit and
 * Google Health refused to start the handshake as "not configured".
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { getWithingsRedirectUri } from "@/lib/withings/client";
import { getFitbitRedirectUri } from "@/lib/fitbit/client";
import { getGoogleHealthRedirectUri } from "@/lib/google-health/client";
import { getPolarRedirectUri } from "@/lib/polar/client";
import { getWhoopRedirectUri } from "@/lib/whoop/client";
import { getStravaRedirectUri } from "@/lib/strava/client";
import { getOuraRedirectUri } from "@/lib/oura/client";

const APP = "https://health.example.test";

const CASES: Array<[string, string, () => string, string]> = [
  ["Withings", "WITHINGS_REDIRECT_URI", getWithingsRedirectUri, "withings"],
  ["Fitbit", "FITBIT_REDIRECT_URI", getFitbitRedirectUri, "fitbit"],
  [
    "Google Health",
    "GOOGLE_HEALTH_REDIRECT_URI",
    getGoogleHealthRedirectUri,
    "google-health",
  ],
  ["Polar", "POLAR_REDIRECT_URI", getPolarRedirectUri, "polar"],
  ["WHOOP", "WHOOP_REDIRECT_URI", getWhoopRedirectUri, "whoop"],
  ["Strava", "STRAVA_REDIRECT_URI", getStravaRedirectUri, "strava"],
  ["Oura", "OURA_REDIRECT_URI", getOuraRedirectUri, "oura"],
];

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each(CASES)("%s redirect URI", (_name, variable, resolve, path) => {
  it.each(["", "   "])(
    "derives the callback when the variable is %j",
    (value) => {
      vi.stubEnv(variable, value);
      vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
      expect(resolve()).toBe(`${APP}/api/${path}/callback`);
    },
  );

  it("uses an explicit value, trimmed", () => {
    const explicit = `${APP}/api/${path}/callback`;
    vi.stubEnv(variable, ` ${explicit} `);
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP);
    expect(resolve()).toBe(explicit);
  });
});

describe("with neither variable set", () => {
  it.each([
    ["Fitbit", "FITBIT_REDIRECT_URI", getFitbitRedirectUri],
    ["Google Health", "GOOGLE_HEALTH_REDIRECT_URI", getGoogleHealthRedirectUri],
  ] as const)("%s still says it is not configured", (_n, variable, resolve) => {
    vi.stubEnv(variable, "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", " ");
    expect(() => resolve()).toThrow(/not configured/);
  });
});
