# v1.34.1 Performance Baseline

**Generated:** 2026-07-29T12:38:03.677Z

**Commit:** `efe203212a7269c2bd3d16f011985dd888e35679`

**Exit status:** PASS

**Mode:** deterministic local fixture only

## Safety and interpretation

- No network, database, provider, production, or staging endpoint was contacted.
- Fixtures contain generated counters only. The report emits no tokens, identifiers, payloads, health values, hostnames, usernames, or working-directory paths.
- Concurrency is fixed at one, warm sample count is 11, and the whole run has a 30-second deadline.
- Timing is a local code-shape baseline, not a production latency or capacity claim. Database, provider, network, framework, cache, and rendering costs remain unmeasured.
- The Health Score fixture exercises dense/sparse row construction, source canonicalization, and a stable composite proxy. It does not replace production algorithm parity or database-backed performance tests.

## Environment

| Attribute | Value |
| --- | --- |
| Node | v25.9.0 |
| Platform | darwin 25.3.0 |
| Architecture | arm64 |
| Logical CPUs | 14 |
| Process | single local Node process |
| Total harness duration | 152.805 ms |

## Fixture scale

| Path shape | Fixed scale |
| --- | --- |
| Google history | 786 serial pages × 32 generated rows; terminal page has no remaining token |
| Reminder cohort | 2000 medications × 4 slots plus 2000 cleanup records |
| Health Score | 42 dense days × 1440 samples plus 379 sparse days × 8 samples |

## Measurements

| Local path shape | Cold | Warm median | Warm p95 | Warm max | Cold heap delta | Max warm heap delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Google history pagination shape | 8.539 ms | 7.499 ms | 10.600 ms | 10.600 ms | 2.00 MiB | 6.19 MiB |
| Medication reminder cohort shape | 2.723 ms | 0.083 ms | 1.586 ms | 1.586 ms | 0.18 MiB | 0.06 MiB |
| Health Score read/canonicalization shape | 6.232 ms | 4.141 ms | 5.758 ms | 5.758 ms | 7.20 MiB | 8.17 MiB |

### Determinism and bounded counters

- **Google history pagination shape:** checksum `47f760c2`; pages=786; rows=25152; concurrency=1; finalTokenPresent=false.
- **Medication reminder cohort shape:** checksum `73e03617`; medications=2000; slots=8000; cleanupBacklog=2000; dueCandidates=1582; modeledQueries=7165; concurrency=1.
- **Health Score read/canonicalization shape:** checksum `5c395b1a`; denseRows=60480; sparseRows=3032; canonicalDays=42; domains=8; concurrency=1; parity=stable-checksum.

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

`node scripts/v1341-performance-baseline.mjs --fixture --output .planning/phases/01-v1-34-1-dashboard-insights-records-admin-and-integration-reliability/01-PERFORMANCE-BASELINE.md`

## Release build and bundle evidence

The production build, fixture timings above, and bundle report below were
generated from one isolated archive of commit
`efe203212a7269c2bd3d16f011985dd888e35679`. Generated Prisma artifacts and the
existing local dependency store were supplied as build prerequisites; no
uncommitted product source was copied into the snapshot.

| Bundle signal | Measured | Budget / gate | Result |
| --- | ---: | ---: | --- |
| Shared root baseline | 130 KB gzip | informational | measured |
| All client chunks | 3,133 KB gzip | 3,140 KB gzip | pass; 7 KB headroom |
| Largest emitted chunk | 387 KB gzip | informational | measured |
| Recharts fingerprint chunks | 1 | maximum 1 | pass |
| Dashboard route (`/page`) | 431 KB gzip | 460 KB gzip | pass; 29 KB headroom |
| Insights route (`/insights/page`) | 417 KB gzip | 445 KB gzip | pass; 28 KB headroom |
| Measurements route (`/measurements/page`) | 417 KB gzip | 445 KB gzip | pass; 28 KB headroom |
| Mood route (`/insights/mood/page`) | 435 KB gzip | 460 KB gzip | pass; 25 KB headroom |
| Static message-catalog references | none reported | none allowed | pass |

Commands:

- `NODE_OPTIONS=--max-old-space-size=8192 ./node_modules/.bin/next build`
- `node scripts/check-bundle-budget.mjs`
- `node scripts/check-bundle-budget.mjs --check`

The normal 4 GiB Node heap compiled the shared workspace but exhausted memory
during TypeScript verification. The isolated snapshot passed after raising only
the build-process heap to 8 GiB; repository configuration and runtime limits
were not changed.

### Bundle interpretation

- The existing budget checker emits the four budgeted route entries above. It
  does not currently publish per-route gzip rows for Settings, Admin, or
  Documents when a budget file is present, so this report does not invent
  comparable figures for them.
- Passing the aggregate gate does not refute the earlier hypothesis that eager
  Settings/Admin section imports create avoidable route cost. That hypothesis
  remains unmeasured by the current watched-route output.
- The 7 KB aggregate headroom is narrow enough that the final merged release
  should rerun the same gate. It is evidence of the measured snapshot, not
  permission to raise a budget or a claim about browser parse/hydration time.
