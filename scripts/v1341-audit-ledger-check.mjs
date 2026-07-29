#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const ledgerArg = process.argv[2];
if (!ledgerArg) {
  console.error("usage: node scripts/v1341-audit-ledger-check.mjs <ledger.md>");
  process.exit(2);
}

const ledgerPath = resolve(ledgerArg);
const MAX_BYTES = 256 * 1024;
const REQUIRED_FIELDS = [
  "Source",
  "Status",
  "Severity",
  "Category",
  "Evidence",
  "Affected path",
  "Attempted refutation",
  "Impact",
  "Requirement",
  "Planned verification",
  "Confidence",
  "Unresolved",
];
const ALLOWED_STATUS = new Set(["confirmed", "suspected", "blocked", "cleared", "refuted"]);
const ALLOWED_SEVERITY = new Set(["critical", "high", "medium", "low", "info"]);
const ALLOWED_CONFIDENCE = new Set(["high", "medium", "low"]);
const REQUIRED_SOURCES = ["research:", "correctness:", "live:", "performance:"];
const REQUIRED_CATEGORIES = [
  "day-boundary",
  "silent-success",
  "cache-freshness",
  "persistence",
  "outcome-honesty",
];
const PRIVACY_PATTERNS = [
  {
    name: "email address",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  { name: "authorization credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/i },
  {
    name: "secret assignment",
    pattern:
      /\b(?:token|secret|password|api[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
  },
  {
    name: "URL or endpoint with authority",
    pattern: /\bhttps?:\/\/[^\s)>\]]+/i,
  },
  {
    name: "IPv4 address",
    pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  },
  {
    name: "UUID-like identifier",
    pattern:
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
  },
  {
    name: "long hexadecimal identifier",
    pattern: /\b[0-9a-f]{32,}\b/i,
  },
  {
    name: "local user filesystem path",
    pattern: /(?:\/Users\/|\/home\/)[^\s`]+/,
  },
  {
    name: "explicit health value",
    pattern:
      /\b(?:glucose|blood pressure|heart rate|weight|bmi|hba1c)\s*(?:value\s*)?[:=]\s*-?\d+(?:\.\d+)?/i,
  },
];

const errors = [];
let source;
try {
  if (statSync(ledgerPath).size > MAX_BYTES) {
    errors.push(`ledger exceeds ${MAX_BYTES} bytes`);
  }
  source = readFileSync(ledgerPath, "utf8");
} catch (error) {
  console.error(
    `v1341-audit-ledger-check: cannot read ledger (${error instanceof Error ? error.message : "unknown error"})`,
  );
  process.exit(2);
}

for (const check of PRIVACY_PATTERNS) {
  if (check.pattern.test(source)) errors.push(`privacy-dangerous ${check.name} detected`);
}

const headingPattern = /^## (AUD-\d{3}) — (.+)$/gm;
const headings = [...source.matchAll(headingPattern)];
if (headings.length === 0) errors.push("no finding headings found");
if (headings.length > 200) errors.push("finding count exceeds 200");

const ids = new Set();
const sourceRecords = new Set();
const records = [];

for (let index = 0; index < headings.length; index += 1) {
  const match = headings[index];
  const id = match[1];
  const title = match[2].trim();
  const bodyStart = match.index + match[0].length;
  const bodyEnd = headings[index + 1]?.index ?? source.length;
  const body = source.slice(bodyStart, bodyEnd);
  const fields = new Map();

  if (ids.has(id)) errors.push(`${id}: duplicate finding ID`);
  ids.add(id);
  if (!title) errors.push(`${id}: missing title`);

  for (const line of body.split("\n")) {
    const fieldMatch = line.match(/^- \*\*([^*]+):\*\* (.+)$/);
    if (!fieldMatch) continue;
    const [, name, value] = fieldMatch;
    if (fields.has(name)) errors.push(`${id}: duplicate field ${name}`);
    fields.set(name, value.trim());
  }

  for (const field of REQUIRED_FIELDS) {
    if (!fields.get(field)) errors.push(`${id}: missing ${field}`);
  }

  const status = fields.get("Status")?.toLowerCase();
  const severity = fields.get("Severity")?.toLowerCase();
  const confidence = fields.get("Confidence")?.toLowerCase();
  const unresolved = fields.get("Unresolved")?.toLowerCase();
  const sourceField = fields.get("Source");

  if (status && !ALLOWED_STATUS.has(status)) {
    errors.push(`${id}: invalid Status ${status}`);
  }
  if (severity && !ALLOWED_SEVERITY.has(severity)) {
    errors.push(`${id}: invalid Severity ${severity}`);
  }
  if (confidence && !ALLOWED_CONFIDENCE.has(confidence)) {
    errors.push(`${id}: invalid Confidence ${confidence}`);
  }
  if (unresolved && !["yes", "no"].includes(unresolved)) {
    errors.push(`${id}: Unresolved must be yes or no`);
  }
  if (["cleared", "refuted"].includes(status) && unresolved !== "no") {
    errors.push(`${id}: ${status} findings must set Unresolved to no`);
  }
  if (sourceField) {
    if (sourceRecords.has(sourceField)) errors.push(`${id}: duplicate Source record`);
    sourceRecords.add(sourceField);
  }

  records.push({ id, fields });
}

for (let index = 0; index < records.length; index += 1) {
  const expected = `AUD-${String(index + 1).padStart(3, "0")}`;
  if (records[index].id !== expected) {
    errors.push(`${records[index].id}: expected sequential ID ${expected}`);
  }
}

for (const prefix of REQUIRED_SOURCES) {
  if (!records.some((record) => record.fields.get("Source")?.includes(prefix))) {
    errors.push(`missing source family ${prefix}`);
  }
}
for (const category of REQUIRED_CATEGORIES) {
  if (!records.some((record) => record.fields.get("Category") === category)) {
    errors.push(`missing required category ${category}`);
  }
}

if (errors.length > 0) {
  console.error(`v1341-audit-ledger-check: FAIL (${errors.length} issue(s))`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `v1341-audit-ledger-check: PASS (${records.length} unique findings; privacy scan clean)`,
);
