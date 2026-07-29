# v1.34.1 controlled operations decision

**Decision date:** 2026-07-29

**Decision:** Do not run PostgreSQL maintenance as part of the v1.34.1
release or deploy path. Preserve the current reminder at-most-once delivery
policy for this point release.

**Operations gate:** PASS with one controlled planner-statistics residual.

**Overall merged re-audit:** BLOCK for the independent release findings in
`01-MERGED-REAUDIT.md`.

## Production evidence boundary

The production check was deliberately read-only, bounded, and aggregate-only:

- connected to the existing production PostgreSQL container;
- forced `default_transaction_read_only=on`;
- used a five-second statement timeout and one-second lock timeout;
- read only PostgreSQL catalog/statistics views and relation sizes;
- retained no account identifiers, credentials, row payloads, error payloads,
  or health values; and
- ran no `ANALYZE`, `VACUUM`, reindex, schema command, sync, deploy, restart,
  cleanup, or other mutation.

The snapshot completed at 2026-07-29 13:16 UTC. PostgreSQL had started at
2026-07-28 22:43 UTC, and no statistics reset was recorded.

## Planner-statistics evidence

| Observation | Read-only result |
| --- | ---: |
| Estimated live tuples | 628 |
| Estimated dead tuples | 24,253 |
| `pg_class.reltuples` | 389,116 |
| Heap size | 137,682,944 bytes |
| Index size | 526,458,880 bytes |
| Total relation size | 664,215,552 bytes |
| Database size | 1,015,815,191 bytes |
| Index count | 13 |
| Recorded table vacuum/analyze events | 0 |
| Active database sessions during sample | 1 |
| Transactions older than one minute | 0 |

Autovacuum is enabled with the default observed table thresholds: vacuum
threshold 50 and scale factor 0.2; analyze threshold 50 and scale factor 0.1.
The old `reltuples` estimate therefore materially inflates the scale-factor
thresholds. The index statistics also show that the footprint is not uniformly
dead: the principal live covering index is heavily used, while several large
indexes have much lower recorded scan counts. Statistics alone do not prove
that any individual index is redundant.

The attempted refutation is only partial. There is no current database
contention signal, the earlier live audit found healthy bounded measurement
request timings, and planner counts are estimates rather than an exact row
count. Those facts refute an active outage, but they do not refute the
cardinality mismatch or the maintenance risk.

## Explicit planner decision

The stale statistics are a Medium operational residual, not an automatic
release-deploy mutation.

1. Do not add `ANALYZE`, `VACUUM`, `VACUUM FULL`, or reindexing to the
   container entrypoint, migration, or release command sequence.
2. Open a separate approved maintenance change. Before mutation, capture
   representative read-only plans for the measurement list, series, rollup,
   and retention paths and record their estimates.
3. In that separate window, start with ordinary table statistics maintenance,
   then repeat the same plans and aggregate statistics. This document does not
   authorize that action.
4. Consider low-lock index maintenance only after plan and usage evidence
   identifies a concrete candidate and disk headroom is verified. Never use
   `VACUUM FULL` in the point-release path.
5. Roll back the maintenance change by stopping after measurement and leaving
   the application release untouched; no schema or application rollback is
   coupled to this decision.

## Reminder delivery policy

`medication-reminder-check.ts` intentionally writes the durable dedup anchor
before notification dispatch. A crash or dispatch failure can therefore cost
one phase, while stamping after send can repeat a notification every worker
tick. The merged implementation exposes `notifications_failed` and preserves
the canonical occurrence identity, but it does not add a durable outbox.

For v1.34.1 the explicit decision is to retain at-most-once phase delivery.
Changing to retry-until-delivered would require a separately designed durable
outbox/idempotent channel contract and is not safe point-release scope. The
decision closes the release ambiguity: phase delivery is not represented as
reliable delivery, and no additional reminder residual is created for this
release.

## Immutable execution baseline

Recomputed on the merged working tree:

| Baseline item | Required | Observed | Result |
| --- | --- | --- | --- |
| Branch | `release/v1.34.1` | `release/v1.34.1` | PASS |
| Binary package/workspace patch SHA-256 | `b1206decc31f09b621676ac558919caf23a2190869d948fbc585fa3f38170f95` | same | PASS |
| `package.json` SHA-256 | `7a6dbc488beaf210808bf959b84717be462781f2aca74a5fbc157699d7b3668a` | same | PASS |
| `pnpm-lock.yaml` SHA-256 | `d9fa8c99e86eb4977f55395c43ca2c1781de26400870003c783e7112405970d6` | same | PASS |
| `pnpm-workspace.yaml` SHA-256 | `979d04c351ba838e6c8da97aa34545c9a76513710f86d84f6c07d1289d0cd054` | same | PASS |

The semantic allowlist is unchanged:

- `package.json` adds only `@openai/codex-security` at `^0.1.1`;
- `pnpm-workspace.yaml` adds only the matching scanner release-age exclusion;
- `pnpm-lock.yaml` contains the corresponding resolved installation delta; and
- the line deltas remain +1/-0, +657/-21, and +1/-0 respectively.

No package install, normalization, upgrade, or lockfile write was performed.

## Migration boundary

Against base commit
`6528d9f289faedf54e16f0531d862282b53847ed`, the only migration delta is:

`prisma/migrations/0287_google_health_sync_progress/migration.sql`

Its complete SQL adds one nullable `sync_progress` JSONB column to
`google_health_connections`. The matching Prisma schema delta adds only the
nullable `syncProgress` mapping. No other migration, table, index, constraint,
enum, package, or dependency delta was found.

## Closure

OPS-01 is decision-complete: production evidence was refreshed without
mutation, planner maintenance is separated from release deployment, and the
reminder delivery tradeoff is explicit. This operations PASS does not override
the merged audit's release BLOCK.
