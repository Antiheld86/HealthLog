import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "@/lib/openapi/registry";

/**
 * Every schema id the sharing route table declares reaches the published
 * document.
 *
 * The failure this exists for looks like nothing at all. `.meta()` in Zod 4 is
 * immutable: it returns a NEW schema carrying the metadata and registers that
 * one, so `schema.meta({ id, description })` written as a statement registers
 * an instance no route references. The generator then emits the request body
 * inline and anonymous, the id never becomes a component, and the object-level
 * description never leaves the source file. Nothing throws, nothing drifts,
 * `openapi:check` stays green, and the sentence somebody wrote for the client
 * team is readable only by someone already reading the code.
 *
 * Four of the sharing bodies were written that way, and one of them carried the
 * clause scoping every rule on the invitation endpoint to an INVITED grant —
 * the exact sentence a reader needs in order not to carry the step-up and the
 * refusals across to a Guardian grant. It was found by reading the artifact
 * instead of the source, which is not a repeatable way to find things.
 *
 * ## What is checked
 *
 * The ids are read out of the route table's own text rather than listed here,
 * so a body added tomorrow is covered without anybody remembering this file.
 * The set is asserted non-empty first: a matcher that silently stopped matching
 * would otherwise report a green run over nothing, which is the same class of
 * defect as the one under test.
 *
 * The document is BUILT rather than read off disk. `scripts/check-openapi.ts`
 * already pins `docs/api/openapi.yaml` to exactly this document and CI fails on
 * drift, so building it here checks the same artifact without parsing a
 * megabyte of YAML.
 *
 * ## What it cannot see
 *
 * Only this route module. The idiom is long-standing across the registry and
 * fifty-seven other ids are declared the same way in modules this file does not
 * read; widening the sweep is a separate change with a separate diff, recorded
 * in the post-release inventory.
 */
const ROUTE_TABLE = join(
  process.cwd(),
  "src/lib/openapi/routes/account-sharing.ts",
);

/** Every `id: "…"` the route table declares, in source order. */
function declaredIds(): string[] {
  const source = readFileSync(ROUTE_TABLE, "utf8");
  return [...source.matchAll(/\bid:\s*"([A-Za-z0-9_]+)"/g)].map(
    (match) => match[1]!,
  );
}

describe("the sharing route table's schema ids reach the document", () => {
  const ids = declaredIds();
  const schemas = buildOpenApiDocument().components?.schemas ?? {};

  it("has ids to check", () => {
    // The non-zero control. Rename the file, change the quoting style, drop the
    // `id` key convention, and this leg fails instead of the file passing
    // vacuously.
    expect(ids.length).toBeGreaterThan(10);
    expect(ids).toContain("AccountGrantInvite");
    expect(ids).toContain("CreateManagedProfileRequest");
    expect(ids).toContain("InviteManagedProfileGuardianRequest");
    expect(ids).toContain("AccountSwitchRequest");
  });

  it("publishes every declared id as a named component", () => {
    const missing = ids.filter((id) => !(id in schemas));
    expect(missing).toEqual([]);
  });

  it("publishes the invited-grant scoping clause with the request body", () => {
    // The sentence that was lost, checked where a client would read it rather
    // than where it was written.
    const invite = schemas["AccountGrantInvite"] as
      { description?: string } | undefined;
    expect(invite?.description ?? "").toMatch(
      /Every sentence here describes an INVITED grant on this endpoint/,
    );
    // And the boundary it states is the corrected one. The stale wording denied
    // every settings surface, which stopped being true when the anamnesis
    // surface opened to a manage delegate.
    expect(invite?.description ?? "").not.toMatch(
      /never reaches[^.]*\bsettings\b/i,
    );
    expect(invite?.description ?? "").toMatch(
      /record content versus account configuration/i,
    );
  });
});
