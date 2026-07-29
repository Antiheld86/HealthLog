#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

const LIMITS = Object.freeze({
  deadlineMs: 30_000,
  warmSamples: 11,
  googlePages: 786,
  googleRowsPerPage: 32,
  reminderMedications: 2_000,
  reminderSlotsPerMedication: 4,
  reminderCleanupBacklog: 2_000,
  healthDenseDays: 42,
  healthSamplesPerDay: 1_440,
  healthSparseDays: 379,
  healthSparseSamplesPerDay: 8,
});

const args = process.argv.slice(2);
const fixtureMode = args.includes("--fixture");
const outputIndex = args.indexOf("--output");
const outputPath =
  outputIndex >= 0 && args[outputIndex + 1]
    ? resolve(args[outputIndex + 1])
    : null;

function fail(message) {
  console.error(`v1341-performance-baseline: ${message}`);
  process.exit(2);
}

if (!fixtureMode) {
  fail("refusing to run without --fixture; live and production probes are unsupported");
}
if (process.env.NODE_ENV === "production") {
  fail("refusing to run with NODE_ENV=production");
}
if (!outputPath) {
  fail("--output <markdown-path> is required");
}
if (args.some((arg) => /^(--url|--host|--database|--token|--live)/.test(arg))) {
  fail("network, database, credential, and live-target arguments are unsupported");
}

const startedAt = performance.now();
const deadlineAt = startedAt + LIMITS.deadlineMs;

function assertWithinDeadline() {
  if (performance.now() > deadlineAt) {
    throw new Error(`fixture deadline exceeded (${LIMITS.deadlineMs} ms)`);
  }
}

function seededNumber(index, salt) {
  let value = (index + 1) ^ salt;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return (value ^ (value >>> 16)) >>> 0;
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function formatMs(value) {
  return value.toFixed(3);
}

function formatBytes(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}${(Math.abs(value) / 1024 / 1024).toFixed(2)} MiB`;
}

function measure(operation) {
  assertWithinDeadline();
  const beforeHeap = process.memoryUsage().heapUsed;
  const before = performance.now();
  const result = operation();
  const elapsedMs = performance.now() - before;
  const heapDeltaBytes = process.memoryUsage().heapUsed - beforeHeap;
  assertWithinDeadline();
  return { elapsedMs, heapDeltaBytes, result };
}

function benchmark(name, operation) {
  const cold = measure(operation);
  const warm = [];
  for (let index = 0; index < LIMITS.warmSamples; index += 1) {
    warm.push(measure(operation));
  }
  const elapsed = warm.map((sample) => sample.elapsedMs).sort((a, b) => a - b);
  const heaps = warm.map((sample) => sample.heapDeltaBytes);
  const checksums = new Set([cold.result.checksum, ...warm.map((sample) => sample.result.checksum)]);
  if (checksums.size !== 1) {
    throw new Error(`${name} fixture produced a non-deterministic checksum`);
  }
  return {
    name,
    coldMs: cold.elapsedMs,
    coldHeapBytes: cold.heapDeltaBytes,
    medianMs: percentile(elapsed, 0.5),
    p95Ms: percentile(elapsed, 0.95),
    maxMs: elapsed.at(-1),
    maxWarmHeapBytes: Math.max(...heaps),
    checksum: cold.result.checksum,
    counters: cold.result.counters,
  };
}

function googleHistoryFixture() {
  const accumulated = [];
  let checksum = 0;
  let finalTokenPresent = false;

  for (let page = 0; page < LIMITS.googlePages; page += 1) {
    const encodedPage = JSON.stringify({
      rows: Array.from({ length: LIMITS.googleRowsPerPage }, (_, row) => ({
        t: page * LIMITS.googleRowsPerPage + row,
        v: seededNumber(page * LIMITS.googleRowsPerPage + row, 17) % 10_000,
      })),
      next: page + 1 < LIMITS.googlePages ? `fixture-page-${page + 1}` : null,
    });
    const decodedPage = JSON.parse(encodedPage);
    accumulated.push(...decodedPage.rows);
    finalTokenPresent = decodedPage.next !== null;
  }

  for (const row of accumulated) {
    checksum = (checksum + row.t * 17 + row.v) >>> 0;
  }
  return {
    checksum,
    counters: {
      pages: LIMITS.googlePages,
      rows: accumulated.length,
      concurrency: 1,
      finalTokenPresent,
    },
  };
}

function reminderCohortFixture() {
  let checksum = 0;
  let dueCandidates = 0;
  let modeledQueries = 1;

  for (let cleanup = 0; cleanup < LIMITS.reminderCleanupBacklog; cleanup += 1) {
    checksum = (checksum + seededNumber(cleanup, 31)) >>> 0;
  }

  for (
    let medication = 0;
    medication < LIMITS.reminderMedications;
    medication += 1
  ) {
    modeledQueries += 2;
    for (let slot = 0; slot < LIMITS.reminderSlotsPerMedication; slot += 1) {
      const phase = seededNumber(
        medication * LIMITS.reminderSlotsPerMedication + slot,
        43,
      );
      if (phase % 5 === 0) {
        dueCandidates += 1;
        modeledQueries += 2;
      }
      checksum = (checksum + (phase & 0xffff)) >>> 0;
    }
  }
  return {
    checksum,
    counters: {
      medications: LIMITS.reminderMedications,
      slots: LIMITS.reminderMedications * LIMITS.reminderSlotsPerMedication,
      cleanupBacklog: LIMITS.reminderCleanupBacklog,
      dueCandidates,
      modeledQueries,
      concurrency: 1,
    },
  };
}

function healthScoreFixture() {
  const denseRows = Array.from(
    { length: LIMITS.healthDenseDays * LIMITS.healthSamplesPerDay },
    (_, index) => ({
      day: Math.floor(index / LIMITS.healthSamplesPerDay),
      source: index % 3,
      value: seededNumber(index, 59) % 1_000,
    }),
  );
  const sparseRows = Array.from(
    { length: LIMITS.healthSparseDays * LIMITS.healthSparseSamplesPerDay },
    (_, index) => ({
      day: Math.floor(index / LIMITS.healthSparseSamplesPerDay),
      domain: index % 8,
      value: seededNumber(index, 71) % 1_000,
    }),
  );

  const dailyCanonical = new Map();
  for (const row of denseRows) {
    const prior = dailyCanonical.get(row.day);
    if (!prior || row.source < prior.source) dailyCanonical.set(row.day, row);
  }
  const domainTotals = new Array(8).fill(0);
  const domainCounts = new Array(8).fill(0);
  for (const row of sparseRows) {
    domainTotals[row.domain] += row.value;
    domainCounts[row.domain] += 1;
  }
  let checksum = 0;
  for (const row of dailyCanonical.values()) checksum = (checksum + row.value) >>> 0;
  for (let domain = 0; domain < domainTotals.length; domain += 1) {
    const normalized = Math.round(domainTotals[domain] / domainCounts[domain]);
    checksum = (checksum * 31 + normalized) >>> 0;
  }
  return {
    checksum,
    counters: {
      denseRows: denseRows.length,
      sparseRows: sparseRows.length,
      canonicalDays: dailyCanonical.size,
      domains: domainTotals.length,
      concurrency: 1,
      parity: "stable-checksum",
    },
  };
}

function commitSha() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}

function counterSummary(result) {
  return Object.entries(result.counters)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

try {
  const results = [
    benchmark("Google history pagination shape", googleHistoryFixture),
    benchmark("Medication reminder cohort shape", reminderCohortFixture),
    benchmark("Health Score read/canonicalization shape", healthScoreFixture),
  ];
  const durationMs = performance.now() - startedAt;
  const generatedAt = new Date().toISOString();
  const markdown = `# v1.34.1 Performance Baseline

**Generated:** ${generatedAt}  
**Commit:** \`${commitSha()}\`  
**Exit status:** PASS  
**Mode:** deterministic local fixture only

## Safety and interpretation

- No network, database, provider, production, or staging endpoint was contacted.
- Fixtures contain generated counters only. The report emits no tokens, identifiers, payloads, health values, hostnames, usernames, or working-directory paths.
- Concurrency is fixed at one, warm sample count is ${LIMITS.warmSamples}, and the whole run has a ${LIMITS.deadlineMs / 1000}-second deadline.
- Timing is a local code-shape baseline, not a production latency or capacity claim. Database, provider, network, framework, cache, and rendering costs remain unmeasured.
- The Health Score fixture exercises dense/sparse row construction, source canonicalization, and a stable composite proxy. It does not replace production algorithm parity or database-backed performance tests.

## Environment

| Attribute | Value |
| --- | --- |
| Node | ${process.version} |
| Platform | ${platform()} ${release()} |
| Architecture | ${arch()} |
| Logical CPUs | ${cpus().length} |
| Process | single local Node process |
| Total harness duration | ${formatMs(durationMs)} ms |

## Fixture scale

| Path shape | Fixed scale |
| --- | --- |
| Google history | ${LIMITS.googlePages} serial pages × ${LIMITS.googleRowsPerPage} generated rows; terminal page has no remaining token |
| Reminder cohort | ${LIMITS.reminderMedications} medications × ${LIMITS.reminderSlotsPerMedication} slots plus ${LIMITS.reminderCleanupBacklog} cleanup records |
| Health Score | ${LIMITS.healthDenseDays} dense days × ${LIMITS.healthSamplesPerDay} samples plus ${LIMITS.healthSparseDays} sparse days × ${LIMITS.healthSparseSamplesPerDay} samples |

## Measurements

| Local path shape | Cold | Warm median | Warm p95 | Warm max | Cold heap delta | Max warm heap delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
${results
  .map(
    (result) =>
      `| ${result.name} | ${formatMs(result.coldMs)} ms | ${formatMs(result.medianMs)} ms | ${formatMs(result.p95Ms)} ms | ${formatMs(result.maxMs)} ms | ${formatBytes(result.coldHeapBytes)} | ${formatBytes(result.maxWarmHeapBytes)} |`,
  )
  .join("\n")}

### Determinism and bounded counters

${results
  .map(
    (result) =>
      `- **${result.name}:** checksum \`${result.checksum.toString(16).padStart(8, "0")}\`; ${counterSummary(result)}.`,
  )
  .join("\n")}

## Route/path interpretation

| Representative path | What this fixture measures | What it does not measure |
| --- | --- | --- |
| Google full-sync pagination | Serial JSON page materialization and accumulation at the observed 786-page shape | Provider latency, DB writes, token refresh, rollups, or a safe universal page ceiling |
| Medication reminder worker | Serial cohort/slot decisions, cleanup scan, and modeled query amplification | Prisma latency, locks, dispatch latency, or the live cohort size |
| Dashboard / analytics Health Score | Dense/sparse row processing, canonical selection, and stable composite proxy | SQL plans, cache behavior, exact production score parity, or user-visible route latency |

## Hypotheses and unmeasured risks

- **Hypothesis:** Serial provider latency and write statements dominate the Google full-sync wall time; this local CPU result neither confirms nor refutes that hypothesis.
- **Hypothesis:** Reminder query/dispatch amplification, not local loop cost, determines whether a high-water pass approaches its 15-minute cadence.
- **Hypothesis:** Cold database row materialization and canonicalization dominate dense-user Health Score work; production impact remains unconfirmed.
- **Unmeasured:** network and database tails, cache hit/miss ratios, cross-process invalidation, framework rendering, device/browser performance, and production cohort distributions.
- **Do not infer:** a provider defect, a safe page cap, a production regression, or permission to optimize from this report alone.

## Reproduction

\`node scripts/v1341-performance-baseline.mjs --fixture --output .planning/phases/01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability/01-PERFORMANCE-BASELINE.md\`
`;

  writeFileSync(outputPath, markdown, { encoding: "utf8", mode: 0o600 });
  console.log(
    `v1341-performance-baseline: PASS (${results.length} fixtures, ${formatMs(durationMs)} ms)`,
  );
} catch (error) {
  console.error(
    `v1341-performance-baseline: FAIL (${error instanceof Error ? error.message : "unknown error"})`,
  );
  process.exit(1);
}
