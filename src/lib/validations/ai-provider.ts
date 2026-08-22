/**
 * Request schemas for the AI-provider surfaces: the configuration write
 * (`PATCH /api/user/ai-provider`) and the connection probe
 * (`POST /api/ai/test`).
 *
 * They live outside the route files so the OpenAPI registry can import them (a
 * route module may only export handlers plus the Next.js route config), which
 * keeps the published contract and the runtime parser one object.
 *
 * Both bodies carry plaintext credentials, which puts one constraint on every
 * rule below: a validation message must never interpolate the value it
 * rejected. Zod's built-in type, enum and range messages name the received
 * TYPE and never the received value, so the multi-issue 422 these feed is safe
 * to return. A `.refine()` with a message that quotes its input would break
 * that, and would put a key in an error body.
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

/**
 * A field the caller may set, clear, or leave alone.
 *
 * Three states, and the difference matters on every column here: an OMITTED
 * key leaves the stored value untouched, `null` or `""` clears it, and a
 * non-empty string replaces it. The empty string is not a synonym for "no
 * change" anywhere on this surface — the settings forms send `null` and `""`
 * interchangeably to mean "clear", and both have always cleared.
 */
const clearableString = z.string().nullable();

/**
 * `PATCH /api/user/ai-provider` — a partial update of the provider config.
 *
 * The route used to inspect the body key by key with `typeof` guards, which
 * meant a wrongly-typed value (a numeric `model`, a boolean `baseUrl`) was
 * SKIPPED rather than refused: the write went ahead without it, and a body of
 * nothing but such keys came back as "No valid fields" without naming one.
 * This schema is what closes that — every accepted field now states its type,
 * and a mismatch is a named issue in the standard multi-issue 422.
 *
 * The accepted field set is exactly what the route already accepted; this
 * describes the existing contract rather than changing it. In particular the
 * object is deliberately NOT `.strict()`: an unrecognised key has always been
 * ignored here, and refusing one now would break a client sending a field this
 * server does not know yet. Unknown keys are dropped, as before.
 */
export const aiProviderPatchSchema = z.object({
  /**
   * The selected provider. `null` / `""` clears it. Unlike every other field
   * this one has always REFUSED an unrecognised value rather than skipping it,
   * and still does.
   */
  provider: z
    .union([aiProviderKindSchema, z.literal("")])
    .nullable()
    .optional(),
  /** Trimmed on write; whitespace-only clears, like `""`. */
  model: clearableString.optional(),
  /**
   * Custom base URL for the LOCAL provider. Trimmed, then run through the
   * SSRF floor at the route — a private host is refused there, not here,
   * because the allowlist is operator state rather than a shape rule.
   */
  baseUrl: clearableString.optional(),
  /** The OpenAI-compatible gateway's own base URL. Same SSRF floor. */
  compatBaseUrl: clearableString.optional(),
  compatModel: clearableString.optional(),
  /** Encrypted at rest on write; never echoed back by the read. */
  compatKey: clearableString.optional(),
  anthropicKey: clearableString.optional(),
  localKey: clearableString.optional(),
  openaiKey: clearableString.optional(),
  /**
   * Per-user AI response timeout in seconds. `null` restores the built-in
   * default. The 10 s floor is below what any real backend beats and the
   * 600 s ceiling is generous for a slow self-hosted one; outside that range
   * the value is refused rather than clamped, so a typo is visible.
   */
  responseTimeoutSeconds: z
    .number()
    .int()
    .min(10, "Response timeout must be between 10 and 600 seconds")
    .max(600, "Response timeout must be between 10 and 600 seconds")
    .nullable()
    .optional(),
});

export type AiProviderPatchInput = z.infer<typeof aiProviderPatchSchema>;

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
