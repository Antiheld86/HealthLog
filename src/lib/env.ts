/**
 * Reading operator configuration from the environment.
 *
 * `docker-compose.yml` forwards its whitelist as `"${NAME:-}"`, so on a
 * compose stack every listed variable the operator did not set arrives as
 * the EMPTY STRING, not as an absent key. An empty string is not nullish,
 * which means a nullish fallback (`??`) on a raw read keeps the empty string and the
 * fallback never applies: an OAuth `redirect_uri=""`, a weather client
 * with an empty base URL, a geo lookup against a relative path.
 *
 * Every read with a fallback goes through this module instead. A value that
 * is missing, empty, or only whitespace counts as unset. The guard
 * `src/__tests__/env-empty-is-unset-guard.test.ts` refuses a `??` fallback
 * written directly against a raw read anywhere else in `src/`.
 *
 * Server-side only. `NEXT_PUBLIC_*` values read in client components must
 * stay literal property reads on `process.env` so Next.js can inline them at
 * build time; those use `||` directly.
 */

/** The trimmed value of `name`, or `undefined` when it is unset or blank. */
export function envValue(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** The trimmed value of `name`, or `fallback` when it is unset or blank. */
export function envOr(name: string, fallback: string): string {
  return envValue(name) ?? fallback;
}

const TRUE_WORDS = new Set(["1", "true", "yes", "on"]);

/**
 * Whether a switch-style variable is turned on. Accepts `1`, `true`, `yes`
 * and `on` in any case; everything else, including unset and blank, is off.
 */
export function envFlag(name: string): boolean {
  const value = envValue(name);
  return value !== undefined && TRUE_WORDS.has(value.toLowerCase());
}
