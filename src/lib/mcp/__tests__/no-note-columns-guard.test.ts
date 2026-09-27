/**
 * No MCP code path reads a condition or vaccination note (v1.39.3 review).
 *
 * A condition's note and a vaccination dose's note are never handed to an AI
 * surface: the Coach illness snapshot and the doctor-report clinical records
 * both leave them out on purpose. The MCP wire reaches an outside assistant,
 * so the same rule holds here.
 *
 * The guard walks every non-test source file under `src/lib/mcp`, finds each
 * Prisma call on `illnessEpisode` or `vaccinationRecord` (whitespace-tolerant,
 * so a call split across lines is still found), and requires its argument to
 * carry an explicit `select` without `noteEncrypted`. A read with no select
 * would load every column, the note included, so it fails too.
 *
 * Proved both ways: the matcher must find calls in the tree (an empty match
 * set is a failure, not a pass), and the same check must flag a planted call
 * that reads the note or selects nothing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MCP_ROOT = join(process.cwd(), "src/lib/mcp");
const CALL =
  /\b(?:prisma|tx)\s*\.\s*(illnessEpisode|vaccinationRecord)\s*\.\s*(\w+)\s*\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === "__tests__" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** The text between a call's opening parenthesis and its matching close. */
function argumentOf(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open + 1);
}

/** The keys of the call's argument object, ignoring nested objects. */
function topLevelKeys(arg: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < arg.length; i += 1) {
    const ch = arg[i];
    if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") depth -= 1;
    else if (depth === 1) {
      const key = /^([A-Za-z_]\w*)\s*:/.exec(arg.slice(i));
      if (key && !/\w/.test(arg[i - 1] ?? "")) {
        keys.push(key[1]);
        i += key[0].length - 1;
      }
    }
  }
  return keys;
}

interface Violation {
  call: string;
  problem: string;
}

function violations(source: string): { calls: number; bad: Violation[] } {
  const bad: Violation[] = [];
  let calls = 0;
  for (const match of source.matchAll(CALL)) {
    calls += 1;
    const call = `${match[1]}.${match[2]}`;
    const arg = argumentOf(source, (match.index ?? 0) + match[0].length - 1);
    const keys = topLevelKeys(arg);
    if (/\bnoteEncrypted\b/.test(arg)) {
      bad.push({ call, problem: "names noteEncrypted" });
    } else if (!keys.includes("select")) {
      // `include` alone, or nothing, loads every scalar column.
      bad.push({ call, problem: "has no explicit select" });
    }
  }
  return { calls, bad };
}

describe("MCP note-column guard", () => {
  it("flags a planted read of the note, and a read with no select", () => {
    const planted = `
      await prisma.illnessEpisode.findFirst({
        where: { id },
        select: { id: true, noteEncrypted: true },
      });
      await prisma
        .vaccinationRecord
        .findMany({ where: { userId } });
      await prisma.illnessEpisode.findMany({ where: {}, select: { id: true } });
      await prisma.vaccinationRecord.findFirst({
        where: { id },
        include: { practitioner: { select: { name: true } } },
      });
    `;
    const { calls, bad } = violations(planted);
    expect(calls).toBe(4);
    expect(bad.map((b) => b.problem)).toEqual([
      "names noteEncrypted",
      "has no explicit select",
      // A nested select under `include` does not narrow the row itself.
      "has no explicit select",
    ]);
  });

  it("no MCP read of a condition or a dose can load its note", () => {
    const files = sourceFiles(MCP_ROOT);
    expect(files.length).toBeGreaterThan(10);
    let calls = 0;
    const offenders: string[] = [];
    for (const file of files) {
      const result = violations(readFileSync(file, "utf8"));
      calls += result.calls;
      for (const v of result.bad) {
        offenders.push(`${file}: ${v.call} ${v.problem}`);
      }
    }
    // record-search reads both models; zero matches means a broken matcher.
    expect(calls).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});
