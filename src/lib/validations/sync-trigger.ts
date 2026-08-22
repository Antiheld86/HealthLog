import { z } from "zod/v4";

/**
 * The optional flag-only body every manual provider-sync trigger accepts.
 *
 * Deliberately NOT `strict()`. An unknown key has always been ignored here and
 * tightening that would refuse callers this change is not aiming at — the point
 * is that a key the server DOES read must not be misread, not that the body
 * becomes a closed shape.
 */
export const syncTriggerSchema = z.object({
  fullSync: z.boolean().optional(),
});

export type SyncTriggerInput = z.infer<typeof syncTriggerSchema>;
