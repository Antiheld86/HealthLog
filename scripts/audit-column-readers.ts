/**
 * Release-battery sweep: which Prisma columns are written but never read?
 *
 * Run it as part of the deep-audit step, not in CI:
 *
 *     pnpm dlx tsx scripts/audit-column-readers.ts
 *     pnpm dlx tsx scripts/audit-column-readers.ts --model Measurement
 *     pnpm dlx tsx scripts/audit-column-readers.ts --all
 *
 * ## Why this is a script and not a test
 *
 * The question "does this column have a reader anywhere in the tree" is a
 * whole-program property, and the only cheap way to approximate it is grep.
 * Grep is unsound in both directions here. Generic field names (`value`,
 * `type`, `state`, `source`) match unrelated identifiers and read as consumed
 * when they are not. Consumption through a select-less `findUnique` plus
 * whole-row serialization reads as unconsumed when it is not. Raw SQL and
 * dynamic selects fall outside the matcher entirely.
 *
 * A gate built on that matcher would drift towards green and stop meaning
 * anything, which is exactly the failure this whole family of guards exists to
 * prevent — a pair guard that quietly degrades into a one-end guard is worse
 * than no guard, because it also removes the suspicion. So this stays a review
 * tool with a human reading the output. The two questions that CAN be answered
 * exactly — is every account-payload field consumed, is every Measurement
 * column backed up — are tests instead:
 * `src/__tests__/account-payload-consumer-guard.test.ts` and
 * `src/__tests__/measurement-backup-completeness.test.ts`.
 *
 * ## The annotation convention
 *
 * A pull request that adds a column, payload field, or preference contains its
 * consumer. When it genuinely cannot, the schema comment says so and this
 * sweep treats the marker as an expiring allowlist entry:
 *
 *     /// @pending-consumer(#123) — iOS reads this from v1.33; server-side unread until then.
 *     /// @internal: cooldown bookkeeping for the reminder cron; never surfaced.
 *
 * `@internal` is permanent and silences the field. `@pending-consumer` is
 * temporary: the field stays out of the findings list but is reported
 * separately every run, so an issue that closed without the consumer landing
 * becomes visible at the next release audit instead of never.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const SRC = join(ROOT, "src");

/** `generated` is the Prisma client: megabytes of noise, and never a consumer. */
const SKIP_DIRS = new Set([
  "generated",
  "node_modules",
  ".next",
  "__tests__",
  "__mocks__",
]);

/**
 * Names too generic for the matcher to say anything useful about. Reported in
 * their own section rather than dropped, so the sweep never claims a clean
 * bill it cannot back up.
 */
const GENERIC_NAMES = new Set([
  "id",
  "name",
  "type",
  "value",
  "unit",
  "source",
  "state",
  "status",
  "label",
  "kind",
  "data",
  "key",
  "code",
  "url",
  "title",
  "notes",
  "userId",
  "createdAt",
  "updatedAt",
  "deletedAt",
]);

interface Field {
  model: string;
  name: string;
  annotation: "internal" | "pending-consumer" | null;
  annotationText: string | null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function parseSchema(schema: string): Field[] {
  const models = new Set(
    [...schema.matchAll(/^model\s+([A-Za-z_]\w*)\s*\{/gm)].map((m) => m[1]),
  );
  const fields: Field[] = [];

  for (const model of models) {
    const start = schema.indexOf(`model ${model} {`);
    const end = schema.indexOf("\n}", start);
    const lines = schema.slice(start, end).split("\n").slice(1);

    let pending: string[] = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("//") || line.startsWith("///")) {
        pending.push(line);
        continue;
      }
      if (line.startsWith("@@")) {
        pending = [];
        continue;
      }
      const m = /^([a-zA-Z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?/.exec(line);
      if (!m) {
        pending = [];
        continue;
      }
      const [, name, type, isList] = m;
      if (isList || models.has(type) || line.includes("@relation")) {
        pending = [];
        continue;
      }
      const comment = [...pending, line].join(" ");
      let annotation: Field["annotation"] = null;
      let annotationText: string | null = null;
      const internal = /@internal:?\s*(.*)$/.exec(comment);
      const pendingConsumer = /@pending-consumer\(([^)]*)\)\s*(.*)$/.exec(
        comment,
      );
      if (pendingConsumer) {
        annotation = "pending-consumer";
        annotationText = `${pendingConsumer[1]} ${pendingConsumer[2]}`.trim();
      } else if (internal) {
        annotation = "internal";
        annotationText = internal[1].trim();
      }
      fields.push({ model, name, annotation, annotationText });
      pending = [];
    }
  }

  return fields;
}

interface Usage {
  writes: number;
  reads: number;
  selects: number;
}

function countUsage(text: string, field: string): Usage {
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selects = text.match(
    new RegExp(`(?<![\\w$])${esc}:\\s*(?:true|false)(?![\\w$])`, "g"),
  );
  const writes = text.match(
    new RegExp(`(?<![\\w$.])${esc}:\\s*(?!true|false)`, "g"),
  );
  const reads = text.match(
    new RegExp(`\\.\\s*${esc}(?![\\w$])|[{,]\\s*${esc}\\s*[,}]`, "g"),
  );
  return {
    writes: writes?.length ?? 0,
    reads: reads?.length ?? 0,
    selects: selects?.length ?? 0,
  };
}

function main() {
  const args = process.argv.slice(2);
  const modelFilter = args.includes("--model")
    ? args[args.indexOf("--model") + 1]
    : null;
  const includeGeneric = args.includes("--all");

  const fields = parseSchema(readFileSync(SCHEMA, "utf8")).filter(
    (f) => !modelFilter || f.model === modelFilter,
  );
  const text = walk(SRC)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");

  const findings: Array<Field & Usage> = [];
  const generic: Array<Field & Usage> = [];
  const pendingConsumers: Field[] = [];

  for (const field of fields) {
    if (field.annotation === "pending-consumer") pendingConsumers.push(field);
    if (field.annotation) continue;
    const usage = countUsage(text, field.name);
    if (usage.reads > 0 || usage.selects > 0) continue;
    if (usage.writes === 0) continue;
    if (GENERIC_NAMES.has(field.name) && !includeGeneric) {
      generic.push({ ...field, ...usage });
      continue;
    }
    findings.push({ ...field, ...usage });
  }

  const scope = modelFilter ? `model ${modelFilter}` : "every model";
  console.log(
    `Column-reader sweep over ${scope} — ${fields.length} scalar column(s).\n`,
  );

  if (findings.length === 0) {
    console.log("No unannotated write-only columns matched.\n");
  } else {
    console.log(
      `${findings.length} column(s) written but never read or selected — verify each by hand:\n`,
    );
    for (const f of findings) {
      console.log(`  ${f.model}.${f.name}  (writes: ${f.writes})`);
    }
    console.log("");
  }

  if (pendingConsumers.length > 0) {
    console.log(
      `${pendingConsumers.length} column(s) marked @pending-consumer — check whether the issue closed without the consumer landing:\n`,
    );
    for (const f of pendingConsumers) {
      console.log(`  ${f.model}.${f.name}  ${f.annotationText ?? ""}`);
    }
    console.log("");
  }

  if (generic.length > 0) {
    console.log(
      `${generic.length} match(es) suppressed as too generic to judge (re-run with --all to see them).\n`,
    );
  }

  console.log(
    "Expect false positives: raw SQL, dynamic selects, and whole-row serialization\n" +
      "all read columns this matcher cannot see. Confirm a finding before acting on it.",
  );
}

main();
