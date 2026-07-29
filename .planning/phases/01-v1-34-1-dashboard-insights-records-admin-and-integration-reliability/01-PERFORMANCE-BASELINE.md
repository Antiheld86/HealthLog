# v1.34.1 Performance Baseline

**Generated:** 2026-07-29T12:30:52.301Z  
**Commit:** `c0af97ce4`  
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
| Total harness duration | 100.435 ms |

## Fixture scale

| Path shape | Fixed scale |
| --- | --- |
| Google history | 786 serial pages × 32 generated rows; terminal page has no remaining token |
| Reminder cohort | 2000 medications × 4 slots plus 2000 cleanup records |
| Health Score | 42 dense days × 1440 samples plus 379 sparse days × 8 samples |

## Measurements

| Local path shape | Cold | Warm median | Warm p95 | Warm max | Cold heap delta | Max warm heap delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Google history pagination shape | 7.462 ms | 5.283 ms | 5.860 ms | 5.860 ms | 2.00 MiB | 6.19 MiB |
| Medication reminder cohort shape | 0.773 ms | 0.080 ms | 0.971 ms | 0.971 ms | 0.19 MiB | 0.07 MiB |
| Health Score read/canonicalization shape | 3.982 ms | 2.280 ms | 3.384 ms | 3.384 ms | 7.09 MiB | 7.30 MiB |

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
