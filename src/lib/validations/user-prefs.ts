/**
 * Request schemas for the per-user scalar preference endpoints under
 * `/api/auth/me/*`. Single-sourced here so the runtime `safeParse` and the
 * OpenAPI registry (`src/lib/openapi/routes/profile.ts`) describe the identical
 * wire contract — the same reason `mfa.ts` exists next door.
 *
 * All three follow the same shape: a one-field PATCH that hard-sets the value
 * and answers with the resolved next state, so a client can replace its
 * optimistic update rather than re-read.
 */
import { z } from "zod/v4";

import {
  injectionSiteEnum,
  INJECTION_SITE_VALUES,
} from "@/lib/validations/medication";

/** `PATCH /api/auth/me/unit-preference` — metric/imperial display branch. */
export const unitPreferencePatchSchema = z.object({
  unitPreference: z.enum(["metric", "imperial"]),
});

/** `PATCH /api/auth/me/documents-auto-ai-read` — the auto-read opt-in. */
export const documentsAutoAiReadPatchSchema = z.object({
  documentsAutoAiRead: z.boolean(),
});

/** `PATCH /api/auth/me/injection-site-prefs` — the user-level deny-list. */
export const injectionSitePrefsPatchSchema = z.object({
  // Dedup at write time; cap at the full enum size. An empty array
  // clears the exclusion.
  globalExcludedInjectionSites: z
    .array(injectionSiteEnum)
    .max(INJECTION_SITE_VALUES.length)
    .meta({
      description:
        "User-level injection-site deny-list. Sites here are never offered for any medication and rejected at intake (deny wins). Empty array clears the exclusion.",
    }),
});
