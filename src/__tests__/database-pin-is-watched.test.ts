import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The bundled database is pinned to an exact minor, AND something watches it.
 *
 * Both halves matter and only together. The pin exists so a database change is
 * a deliberate, reviewable one rather than whatever the registry happens to
 * serve on the day an operator pulls. But PostgreSQL ships security and
 * data-corruption fixes in minor releases and recommends running the current
 * one, so a pin nobody moves ships a knowingly outdated database: this line
 * sat on 16.14 for five weeks after 16.15 was published, because the
 * `docker` ecosystem Dependabot was configured with reads the Dockerfile and
 * never looks at a compose file.
 *
 * So: drop the pin and the deliberate-update model goes; drop the watch and
 * the pin ages in silence. This test fails on either.
 */

const ROOT = resolve(__dirname, "../..");

function read(relative: string): string {
  return readFileSync(resolve(ROOT, relative), "utf8");
}

describe("the bundled database pin", () => {
  it("names an exact minor version, not a floating major alias", () => {
    const images = [
      ...read("docker-compose.yml").matchAll(/^\s*image:\s*(postgres:\S+)/gm),
    ].map((match) => match[1]);

    expect(images.length).toBe(1);
    // `postgres:16-alpine` or `postgres:16` would match a moving target.
    expect(images[0]).toMatch(/^postgres:\d+\.\d+-alpine$/);
  });

  it("is watched by the compose ecosystem, which is not the Dockerfile one", () => {
    const dependabot = read(".github/dependabot.yml");
    const ecosystems = [
      ...dependabot.matchAll(/package-ecosystem:\s*"([^"]+)"/g),
    ].map((match) => match[1]);

    expect(ecosystems).toContain("docker-compose");
    // The Dockerfile watch is a separate entry and does not stand in for it.
    expect(ecosystems).toContain("docker");
  });
});
