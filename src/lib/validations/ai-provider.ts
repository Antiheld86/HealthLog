/**
 * Request schema for `POST /api/ai/test` — the AI connection probe.
 *
 * Lives outside the route file so the OpenAPI registry can import it (a route
 * module may only export handlers plus the Next.js route config), which keeps
 * the published contract and the runtime parser one object.
 *
 * The body carries UNSAVED credentials on purpose: the settings surface tests
 * a selection before it is persisted. Nothing here is written to the user row
 * — `resolveProviderForTest` layers the override over the stored config for
 * the duration of the one probe and drops it.
 */
import { z } from "zod/v4";

/** The five provider kinds a user may select. */
export const AI_PROVIDER_KINDS = [
  "OPENAI",
  "ANTHROPIC",
  "LOCAL",
  "OPENAI_COMPATIBLE",
  "CHATGPT_OAUTH",
] as const;

export const aiProviderKindSchema = z.enum(AI_PROVIDER_KINDS);

export const aiTestOverrideSchema = z
  .object({
    provider: aiProviderKindSchema.optional().nullable(),
    model: z.string().min(1).max(120).optional().nullable(),
    baseUrl: z.string().url().max(2048).optional().nullable(),
    anthropicKey: z.string().min(1).max(500).optional().nullable(),
    localKey: z.string().min(1).max(500).optional().nullable(),
    openaiKey: z.string().min(1).max(500).optional().nullable(),
    // The OpenAI-compatible gateway's own fields, kept separate from
    // `baseUrl` / `openaiKey` so testing an unsaved gateway config can never
    // reach the pinned OpenAI arm and vice versa.
    compatBaseUrl: z.string().url().max(2048).optional().nullable(),
    compatKey: z.string().min(1).max(500).optional().nullable(),
    compatModel: z.string().min(1).max(120).optional().nullable(),
  })
  .strict();

export type AiTestOverrideInput = z.infer<typeof aiTestOverrideSchema>;
