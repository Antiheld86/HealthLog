import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * v1.29.x (S7) — THE structural guarantee behind the fence (design §2.3 / §0).
 *
 * Document text enters an LLM prompt in EXACTLY ONE code path: the fenced
 * pipeline. That pipeline registers NO tools and builds NO health snapshot. This
 * test converts "benign race" from an argument into a PROPERTY: it walks the
 * static import graph of the fenced entry points and asserts the coach tool
 * registry + snapshot builder are UNREACHABLE from them — and symmetrically that
 * the tool route cannot reach any document-text loader. A future refactor that
 * wires document text into the tool path (or tools into the fenced path) fails
 * loudly here, in the same spirit as the i18n call-site walker.
 */

const SRC = resolve(__dirname, "../../..");

function resolveAlias(spec: string, fromFile: string): string | null {
  let candidate: string;
  if (spec.startsWith("@/")) {
    candidate = resolve(SRC, spec.slice(2));
  } else if (spec.startsWith(".")) {
    candidate = resolve(dirname(fromFile), spec);
  } else {
    return null; // bare package import — outside our graph
  }
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const p = `${candidate}${ext}`;
    if (existsSync(p)) return p;
  }
  if (existsSync(candidate)) return candidate;
  return null;
}

const IMPORT_RE = /(?:from|import)\s+["']([^"']+)["']/g;

/** BFS the static import graph from `entries`, returning every reachable file. */
function reachableFrom(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      const resolved = resolveAlias(match[1], file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

const FENCED_ENTRIES = [
  resolve(SRC, "lib/documents/fenced-chat.ts"),
  resolve(SRC, "app/api/insights/chat/fenced/route.ts"),
  resolve(SRC, "app/api/documents/inbound/[id]/chat/route.ts"),
];

const TOOL_ROUTE = resolve(SRC, "app/api/insights/chat/route.ts");

// Modules that constitute the tool loop / health snapshot — forbidden in the
// fenced graph.
const TOOL_MODULES = [
  resolve(SRC, "lib/ai/coach/tools/index.ts"),
  resolve(SRC, "lib/ai/coach/snapshot.ts"),
];

// Document-text loaders — forbidden in the tool-route graph.
const DOCUMENT_TEXT_MODULES = [
  resolve(SRC, "lib/documents/fenced-chat.ts"),
  resolve(SRC, "lib/documents/content-index.ts"),
  resolve(SRC, "lib/documents/document-chat-prompt.ts"),
];

describe("fenced-chat module graph — the fence is structural", () => {
  it("the fenced pipeline can reach neither the coach tool registry nor the snapshot builder", () => {
    const reachable = reachableFrom(FENCED_ENTRIES);
    for (const forbidden of TOOL_MODULES) {
      expect(
        reachable.has(forbidden),
        `Fenced graph must NOT import ${forbidden}`,
      ).toBe(false);
    }
  });

  it("the tool route can reach no document-text loader (no untrusted document text on the tool path)", () => {
    const reachable = reachableFrom([TOOL_ROUTE]);
    for (const forbidden of DOCUMENT_TEXT_MODULES) {
      expect(
        reachable.has(forbidden),
        `Tool route must NOT import ${forbidden}`,
      ).toBe(false);
    }
  });

  it("the Coach turn's wire modules reach neither the tool registry nor the snapshot builder", () => {
    // `turn/sse.ts` (framing, refusal and error streams) and `turn/errors.ts`
    // (provider-error classification) are the parts of the Coach turn a fenced
    // pipeline could share. They stay usable there only while they are
    // tool-free.
    const reachable = reachableFrom([
      resolve(SRC, "lib/ai/coach/turn/sse.ts"),
      resolve(SRC, "lib/ai/coach/turn/errors.ts"),
    ]);
    for (const forbidden of TOOL_MODULES) {
      expect(
        reachable.has(forbidden),
        `Coach turn wire modules must NOT import ${forbidden}`,
      ).toBe(false);
    }
    // Sanity: the walk actually left the entry files.
    expect(reachable.has(resolve(SRC, "lib/ai/coach/turn/types.ts"))).toBe(
      true,
    );
  });

  it("sanity: the tool route DOES reach the tool registry through the turn pipeline", () => {
    const reachable = reachableFrom([TOOL_ROUTE]);
    // Without this the negative checks above would pass against a path that
    // no longer exists — which is how `tools.ts` (now `tools/index.ts`) sat
    // here unmatched after the tool registry became a directory.
    for (const target of TOOL_MODULES) {
      expect(reachable.has(target), `Tool route must reach ${target}`).toBe(
        true,
      );
    }
  });

  it("sanity: the fenced pipeline DOES reach its document loader + prompt builder", () => {
    const reachable = reachableFrom(FENCED_ENTRIES);
    expect(reachable.has(resolve(SRC, "lib/documents/content-index.ts"))).toBe(
      true,
    );
    expect(
      reachable.has(resolve(SRC, "lib/documents/document-chat-prompt.ts")),
    ).toBe(true);
  });
});
