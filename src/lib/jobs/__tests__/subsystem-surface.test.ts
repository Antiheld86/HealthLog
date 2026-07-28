import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  SUBSYSTEM_SURFACE,
  type SubsystemSurface,
} from "@/lib/jobs/subsystem-surface";

const REGISTRARS = [
  "register-integration-sync.ts",
  "register-status.ts",
  "register-rollup.ts",
  "register-reminders.ts",
  "register-maintenance.ts",
].map((file) => join(process.cwd(), "src/lib/jobs/reminder", file));

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

export function extractAllQueueBindings(source: string): string[] {
  const match = /const\s+allQueues\s*=\s*\[([\s\S]*?)\n\s*\];/.exec(source);
  if (!match) throw new Error("Registrar has no allQueues array");

  return withoutComments(match[1])
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(entry)) {
        throw new Error(`Unsupported allQueues entry: ${entry}`);
      }
      return entry;
    });
}

function literalPattern(binding: string): RegExp {
  return new RegExp(
    `(?:export\\s+)?const\\s+${binding}(?:\\s*:[^=;]+)?\\s*=\\s*["']([^"']+)["']`,
  );
}

function modulePath(fromFile: string, specifier: string): string {
  const base = specifier.startsWith("@/")
    ? resolve(process.cwd(), "src", specifier.slice(2))
    : resolve(dirname(fromFile), specifier);
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Cannot resolve ${specifier} from ${fromFile}`);
  return found;
}

function resolveQueueBinding(
  binding: string,
  file: string,
  seen: Set<string> = new Set(),
): string {
  const visit = `${file}:${binding}`;
  if (seen.has(visit)) throw new Error(`Cyclic queue binding: ${visit}`);
  seen.add(visit);

  const source = withoutComments(readFileSync(file, "utf8"));
  const local = literalPattern(binding).exec(source);
  if (local) return local[1];

  const imports = /import\s*{([\s\S]*?)}\s*from\s*["']([^"']+)["'];?/g;
  for (const match of source.matchAll(imports)) {
    for (const rawToken of match[1].split(",")) {
      const token = rawToken.trim().replace(/^type\s+/, "");
      if (!token) continue;
      const [imported, alias] = token
        .split(/\s+as\s+/)
        .map((part) => part.trim());
      if ((alias ?? imported) !== binding) continue;
      return resolveQueueBinding(imported, modulePath(file, match[2]), seen);
    }
  }

  throw new Error(`Cannot resolve queue binding ${binding} from ${file}`);
}

function registeredQueueNames(): string[] {
  return REGISTRARS.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return extractAllQueueBindings(source).map((binding) =>
      resolveQueueBinding(binding, file),
    );
  });
}

export function findSurfaceDrift(
  queueNames: readonly string[],
  surfaces: Readonly<Record<string, SubsystemSurface>>,
): { missing: string[]; extra: string[] } {
  const registered = new Set(queueNames);
  const classified = new Set(Object.keys(surfaces));
  return {
    missing: [...registered].filter((name) => !classified.has(name)).sort(),
    extra: [...classified].filter((name) => !registered.has(name)).sort(),
  };
}

function assertSurfaceComplete(
  queueNames: readonly string[],
  surfaces: Readonly<Record<string, SubsystemSurface>>,
): void {
  const drift = findSurfaceDrift(queueNames, surfaces);
  if (drift.missing.length === 0 && drift.extra.length === 0) return;
  throw new Error(
    `Subsystem surface drift: missing=[${drift.missing.join(", ")}], extra=[${drift.extra.join(", ")}]`,
  );
}

describe("SUBSYSTEM_SURFACE", () => {
  it("classifies every current registrar queue with no stale entries", () => {
    const names = registeredQueueNames();
    expect(new Set(names).size).toBe(names.length);
    expect(() => assertSurfaceComplete(names, SUBSYSTEM_SURFACE)).not.toThrow();
  });

  it("requires none reasons to cite a test path or issue", () => {
    for (const surface of Object.values(SUBSYSTEM_SURFACE)) {
      if (surface.audience !== "none") continue;
      expect(surface.reason).toMatch(/^(?:#\d+|.+\.test\.tsx?(?::\d+)?)$/);
    }
  });

  it("catches a new allQueues binding without a surface entry", () => {
    const fixture = `
      const EXISTING_QUEUE = "existing-queue";
      const NEW_QUEUE = "new-queue";
      const allQueues = [
        EXISTING_QUEUE,
        NEW_QUEUE,
      ];
    `;
    const names = extractAllQueueBindings(fixture).map((binding) => {
      const match = literalPattern(binding).exec(withoutComments(fixture));
      if (!match)
        throw new Error(`Fixture binding did not resolve: ${binding}`);
      return match[1];
    });

    expect(() =>
      assertSurfaceComplete(names, {
        "existing-queue": { audience: "system" },
      }),
    ).toThrow(/missing=\[new-queue\]/);
  });
});
