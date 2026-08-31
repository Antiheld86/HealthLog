/**
 * The Bearer scope for third-party measurement ingest.
 *
 * A leaf module with no imports, for the reason `FHIR_READ_SCOPE` sits in
 * `@/lib/fhir/rest` and `SCOPE_HEALTH_*` in `@/lib/mcp/scopes`: a scope belongs
 * beside the surface that consumes it, and a central scope registry would
 * invite a route to pick one off a menu — the opposite of the closed vocabulary
 * `bearer-scope-enforcement-guard.test.ts` freezes. Zero imports because the
 * mint route, both write routes, the settings card (a client component) and the
 * guards all read it, and none of them should inherit an import graph for a
 * string.
 *
 * Deliberately alone. There is no read counterpart and must not be one: the
 * measurement read legs stay cookie-equivalent, so a credential minted for a
 * scale or a home-automation rule cannot read a health history back out. An
 * unused `MEASUREMENTS_READ_SCOPE` sitting here is one somebody wires up later
 * without the review that admitting it deserves.
 */

/** The scope a narrow token must carry to write measurements. */
export const MEASUREMENTS_WRITE_SCOPE = "measurements:write";
