/**
 * Query validation for `GET /api/analytics`.
 *
 * One parameter, one legal value, and the point of writing it down is that
 * the route used to compare the raw string against `"summaries"` and fall
 * through to the thick default body on anything else. `?slice=summary` then
 * ran the whole 30-query chain and answered as if nothing were wrong, which
 * is the most expensive way this surface can absorb a typo.
 *
 * Lives outside the route file so the OpenAPI registry can import it (a route
 * module may only export handlers plus the Next.js route config).
 */
import { z } from "zod/v4";

/** The slices `GET /api/analytics` knows how to serve. */
export const ANALYTICS_SLICES = ["summaries"] as const;

export const analyticsSliceEnum = z.enum(ANALYTICS_SLICES);

export const analyticsQuerySchema = z.object({
  /**
   * `summaries` selects the slim tile-strip body. Omitted selects the thick
   * default body. Any other value is refused — falling through to the
   * default would hide the typo behind the more expensive read.
   */
  slice: analyticsSliceEnum.optional(),
});

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
