import { z } from "zod/v4";

/**
 * Per-user Google Health BYO-key credentials. Each self-hoster registers their
 * own Google Cloud OAuth client (the Restricted-scope brand verification + CASA
 * assessment is per-OAuth-client, so a single shared app is unworkable for a
 * multi-operator product) and pastes the client id/secret into Settings. Stored
 * encrypted on `User`.
 */
export const googleHealthCredentialsSchema = z.object({
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1).max(200),
});

export type GoogleHealthCredentialsInput = z.infer<
  typeof googleHealthCredentialsSchema
>;
