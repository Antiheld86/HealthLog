# v1.34.1 Audit Reconciliation Ledger

**Reconciled:** 2026-07-29

**Sources:** phase research, static correctness audit, read-only live audit, and
performance/resilience audit.

This ledger deduplicates overlapping observations. Confirmed findings remain
release work or explicit blockers; suspected findings remain hypotheses; cleared
findings preserve the attempted refutation so they cannot silently return to
scope. Evidence is limited to repository paths and redacted aggregate facts.

## Status summary

| Status | Meaning |
| --- | --- |
| confirmed | Evidence proves the behavior; implement or explicitly block release |
| suspected | Credible risk still needs the planned measurement or decision |
| blocked | External evidence is required before a resolution claim |
| cleared | The examined path refuted the proposed adjacent defect |
| refuted | The specific claim was disproved |

## AUD-001 — Dashboard pending lead duplicates the headline score

- **Source:** research:confirmed-dashboard; correctness:C8; performance:C7
- **Status:** confirmed
- **Severity:** medium
- **Category:** presentation-correctness
- **Evidence:** `src/lib/daily/digest.ts` supplies a score-only fallback while `src/components/daily/today-hero.tsx` renders the score ring independently.
- **Affected path:** digest fallback → Dashboard hero lead → score ring
- **Attempted refutation:** Generated or signal-driven prose later replaces the fallback, but the cold state is deterministic and still duplicates the score.
- **Impact:** The initial Dashboard repeats one headline fact and looks unfinished despite complete data.
- **Requirement:** DASH-01
- **Planned verification:** Plan 16 component contract for one numeric headline representation followed by Plan 24 merged re-audit.
- **Confidence:** high
- **Unresolved:** yes

## AUD-002 — Stored document summaries expose a redundant regenerate action

- **Source:** research:confirmed-document-action; correctness:K1
- **Status:** confirmed
- **Severity:** low
- **Category:** product-grammar
- **Evidence:** The stored-summary branch in `src/components/documents/document-summary-block.tsx` renders the action even though opening and reading require no generation.
- **Affected path:** stored summary state → document detail UI
- **Attempted refutation:** First-generation and retry states still require backend capability; only the ready-state action is redundant.
- **Impact:** Users see an action that the accepted release brief explicitly removes.
- **Requirement:** DOC-01
- **Planned verification:** Plan 16 ready-state component contract and Plan 24 re-audit.
- **Confidence:** high
- **Unresolved:** yes

## AUD-003 — Health Score card contains rejected explanatory blocks

- **Source:** research:confirmed-score-copy; correctness:K2
- **Status:** confirmed
- **Severity:** low
- **Category:** presentation-density
- **Evidence:** `src/components/insights/health-score-card.tsx` separates method, composition, band, and algorithm copy from canonical report construction.
- **Affected path:** Health Score report → card presentation
- **Attempted refutation:** No competing calculation or API score was found; removing the blocks can remain presentation-only.
- **Impact:** The card is denser than the accepted design and obscures pillar details.
- **Requirement:** INS-01, INS-02, INS-03, INS-04
- **Planned verification:** Plan 16 API parity plus one-score component contract; locale cleanup in Plan 23.
- **Confidence:** high
- **Unresolved:** yes

## AUD-004 — Medication assessment prose uses the wrong visual emphasis

- **Source:** research:confirmed-medication-tone
- **Status:** confirmed
- **Severity:** low
- **Category:** visual-consistency
- **Evidence:** `src/app/insights/medications/page.tsx` uses muted prose where established assessment bodies use foreground text.
- **Affected path:** medication assessment result → Insights card body
- **Attempted refutation:** Shared cards already use the intended token, limiting the defect to the concrete medication drift.
- **Impact:** Medication assessment text appears less important than equivalent assessment prose.
- **Requirement:** INS-06, INS-07
- **Planned verification:** Plan 16 focused component assertion and Plan 24 screenshot re-audit.
- **Confidence:** high
- **Unresolved:** yes

## AUD-005 — Empty Allergy and Family History managers duplicate create actions

- **Source:** research:confirmed-empty-ctas; correctness:K3
- **Status:** confirmed
- **Severity:** low
- **Category:** product-grammar
- **Evidence:** Both managers render an unconditional top action and an EmptyState action backed by the same create entry point.
- **Affected path:** empty records query → manager header and empty state
- **Attempted refutation:** The controls do not prove duplicate writes, but they are duplicate affordances in the same state.
- **Impact:** Empty screens present two equivalent primary actions.
- **Requirement:** REC-01, REC-03
- **Planned verification:** Plan 16 empty/populated component contracts with one request per activation.
- **Confidence:** high
- **Unresolved:** yes

## AUD-006 — Desktop Settings and Admin navigation starts below the heading

- **Source:** research:confirmed-shell-layout; correctness:K4; performance:C8
- **Status:** confirmed
- **Severity:** low
- **Category:** navigation-layout
- **Evidence:** Both shells place the heading in grid row one and navigation in row two with a separate sticky offset.
- **Affected path:** desktop shell grid → sticky navigation → section content
- **Attempted refutation:** Sticky positioning eventually pins the rail, but does not satisfy initial heading alignment or eliminate the visible travel.
- **Impact:** Navigation visibly drifts before pinning and Admin lacks the accepted grouping.
- **Requirement:** NAV-01, NAV-02, NAV-03, NAV-04, NAV-05
- **Planned verification:** Plan 17 responsive shell contracts and Plan 24 browser re-audit.
- **Confidence:** high
- **Unresolved:** yes

## AUD-007 — Reminder identity changes at the local-day boundary

- **Source:** research:pitfall-day-key; correctness:C1
- **Status:** confirmed
- **Severity:** critical
- **Category:** day-boundary
- **Evidence:** `src/lib/jobs/reminder/medication-reminder-check.ts` derives intake bounds, occurrence anchoring, and dedup keys from the worker tick day rather than the scheduled occurrence.
- **Affected path:** schedule recurrence → occurrence instant → intake attribution → reminder dedup
- **Attempted refutation:** Existing recurrence bands and a wider anchor lookup cannot match an identity whose local date changed before attribution.
- **Impact:** A completed late dose can repeat after midnight, while an overly broad repair could suppress the next real dose.
- **Requirement:** REM-01, REM-02, REM-03, REM-04
- **Planned verification:** Plan 18 fake-time and persisted cross-midnight matrix across normal and daylight-saving transitions.
- **Confidence:** high
- **Unresolved:** yes

## AUD-008 — Google resource diagnoses collapse before the manual-sync response

- **Source:** research:confirmed-google-reasons; correctness:C5
- **Status:** confirmed
- **Severity:** high
- **Category:** outcome-honesty
- **Evidence:** Resource failures are classified internally, but the aggregate route and failed card path retain only a generic failure envelope and stale status.
- **Affected path:** provider resource → sync ledger → route envelope → integration card
- **Attempted refutation:** The detailed ledger can appear after a later refetch, which does not make the immediate failed response actionable.
- **Impact:** Users cannot distinguish safe reason classes and are encouraged to retry blindly.
- **Requirement:** GH-03, GH-04, GH-06
- **Planned verification:** Plan 21 bounded per-resource DTO tests and failed-card status invalidation.
- **Confidence:** high
- **Unresolved:** yes

## AUD-009 — Safe deterministic Insights fallback is discarded

- **Source:** research:confirmed-screened-fallback; correctness:C2; live:C2
- **Status:** confirmed
- **Severity:** high
- **Category:** persistence
- **Evidence:** A safe fallback is produced, but the negative cache stub omits it and the shared card evaluates provider presence before available text.
- **Affected path:** outbound screen → deterministic fallback → status persistence → reader → card
- **Attempted refutation:** Retry-storm prevention and fail-closed screening are valid, but neither requires dropping already-safe text.
- **Impact:** A safe result becomes whitespace, indefinite preparation, or a false provider-setup prompt.
- **Requirement:** AI-01, AI-02, AI-03, AI-04
- **Planned verification:** Plan 20 worker-to-reader-to-card matrix for screened, timeout, error, cached, and generated states.
- **Confidence:** high
- **Unresolved:** yes

## AUD-010 — Reported Google full-sync failure lacks reproducible evidence

- **Source:** research:open-google-report; live:S1
- **Status:** blocked
- **Severity:** high
- **Category:** external-evidence
- **Evidence:** The audited instance had no connected Google cohort or retained manual-sync trace capable of reproducing the external report.
- **Affected path:** external reporter environment → manual full sync → user-visible result
- **Attempted refutation:** A clean zero-target local run cannot clear an issue that it cannot exercise.
- **Impact:** The release must not claim the reporter-specific failure resolved from adjacent fixes alone.
- **Requirement:** GH-01, GH-06
- **Planned verification:** Plan 21 fixture coverage plus a redacted reporter response checkpoint before any specific resolution claim.
- **Confidence:** high
- **Unresolved:** yes

## AUD-011 — Insights polling stops while the card remains preparing

- **Source:** correctness:C3
- **Status:** confirmed
- **Severity:** high
- **Category:** terminal-state
- **Evidence:** `src/hooks/use-insight-status.ts` stops scheduling after its ceiling without transforming the last preparing payload rendered by the card.
- **Affected path:** status GET loop → polling ceiling → shared card state
- **Attempted refutation:** Healthy workers usually replace the payload, but a negative stub can remain preparing with no work in flight.
- **Impact:** Bounded network work becomes an unbounded and misleading UI state.
- **Requirement:** AI-03, AI-04, AI-05
- **Planned verification:** Plan 20 fake-timer contract requiring an honest terminal state after the final poll.
- **Confidence:** high
- **Unresolved:** yes

## AUD-012 — Google writes can leave workout and score readers stale

- **Source:** correctness:C4; performance:C1
- **Status:** confirmed
- **Severity:** high
- **Category:** cache-freshness
- **Evidence:** Google workout and measurement writers omit the established server invalidators, while manual client invalidation omits the workout query family.
- **Affected path:** Google write → server projections → browser queries → Dashboard and workout views
- **Attempted refutation:** Cache expiry and remounts eventually heal views, but do not provide immediate post-success visibility across processes.
- **Impact:** A successful import can leave new or updated workouts and derived views visibly stale.
- **Requirement:** GH-02, GH-04, SYNC-03
- **Planned verification:** Plan 21 insert/update cache-prewarm tests plus real-database workout visibility coverage.
- **Confidence:** high
- **Unresolved:** yes

## AUD-013 — Resolved Google failures are counted as synced users

- **Source:** correctness:C6; performance:C2
- **Status:** confirmed
- **Severity:** high
- **Category:** silent-success
- **Evidence:** The default cohort adapter discards the returned failed verdict and increments success for every resolved promise.
- **Affected path:** per-user Google verdict → cohort counters → job outcome
- **Attempted refutation:** Isolating one user from cohort retries is valid, but does not justify classifying a failed verdict as synced.
- **Impact:** Operator counters can look green while user integrations fail or partially fail.
- **Requirement:** SYNC-02, JOB-01
- **Planned verification:** Plan 22 mixed clean, resolved-failure, and thrown-failure cohort contract.
- **Confidence:** high
- **Unresolved:** yes

## AUD-014 — Rollup failure does not change Google sync success

- **Source:** correctness:C7
- **Status:** confirmed
- **Severity:** medium
- **Category:** outcome-honesty
- **Evidence:** Full and incremental sync paths catch rollup recomputation failure after raw writes without changing the cycle verdict or success watermark.
- **Affected path:** raw measurement write → rollup recomputation → integration ledger → derived readers
- **Attempted refutation:** Raw rows were written, but derived readers consume materialized results, so raw write count alone is not a complete success verdict.
- **Impact:** The card can report success while Insights and derived views remain stale.
- **Requirement:** GH-04, GH-06, SYNC-03
- **Planned verification:** Plan 21 forced rollup-failure tests requiring partial or failed outcome and no success watermark.
- **Confidence:** high
- **Unresolved:** yes

## AUD-015 — Stamp-before-send can suppress a failed reminder phase

- **Source:** correctness:S1
- **Status:** suspected
- **Severity:** medium
- **Category:** delivery-policy
- **Evidence:** The worker persists its dedup anchor before dispatch and retains the anchor when dispatch fails.
- **Affected path:** reminder candidate → durable dedup anchor → channel dispatch → next tick
- **Attempted refutation:** The policy prevents notification floods and no live evidence ties it to the reported midnight defect.
- **Impact:** A transient dispatch failure can suppress that phase unless the product intentionally accepts at-most-once delivery.
- **Requirement:** OPS-01
- **Planned verification:** Plan 24 explicit at-most-once versus durable-outbox decision; no point-release behavior change without that decision.
- **Confidence:** medium
- **Unresolved:** yes

## AUD-016 — Recovery assessment visual mismatch is not statically proven

- **Source:** correctness:S2
- **Status:** suspected
- **Severity:** low
- **Category:** visual-consistency
- **Evidence:** Recovery mounts the same shared populated assessment component and foreground body token as established metric cards.
- **Affected path:** Recovery metric state → shared assessment card → themed rendering
- **Attempted refutation:** Shared code does not prove identical browser output across adjacent copy, themes, and responsive layouts.
- **Impact:** A speculative global CSS change could regress already-correct assessment states.
- **Requirement:** INS-06, INS-07
- **Planned verification:** Plan 24 mobile and desktop screenshot matrix across loading, fallback, generated, light, and dark states.
- **Confidence:** medium
- **Unresolved:** yes

## AUD-017 — Records preserve explicit revision and delete semantics

- **Source:** correctness:K3-cleared
- **Status:** cleared
- **Severity:** info
- **Category:** records-semantics
- **Evidence:** Facts expose separate save, correction history, and confirmed removal paths; duplicate empty actions share one create entry point.
- **Affected path:** records editor → revision persistence → history and removal
- **Attempted refutation:** Static tracing found no silent overwrite or delete triggered by the requested label and conditional-rendering changes.
- **Impact:** No adjacent data-correctness defect is established.
- **Requirement:** REC-02, REC-04, REC-05
- **Planned verification:** Plan 16 preserves revision history and one mutation per action; Plan 24 re-audit.
- **Confidence:** high
- **Unresolved:** no

## AUD-018 — Navigation authorization currently fails closed

- **Source:** correctness:K4-cleared
- **Status:** cleared
- **Severity:** info
- **Category:** authorization
- **Evidence:** Admin shell renders neither frame nor content until the role is authorized.
- **Affected path:** session role → Admin shell → navigation and content
- **Attempted refutation:** Static code clears an authorization leak, though it cannot clear the separate sticky-layout report.
- **Impact:** No adjacent role-boundary defect was found.
- **Requirement:** NAV-01, NAV-03
- **Planned verification:** Plan 17 non-admin and admin browser contracts followed by Plan 24 security re-audit.
- **Confidence:** high
- **Unresolved:** no

## AUD-019 — Written-plus-failed Google sync already renders partial

- **Source:** correctness:K5-cleared
- **Status:** cleared
- **Severity:** info
- **Category:** outcome-honesty
- **Evidence:** The shared written-outcome classifier and route preserve a partial aggregate when some rows were written and a leg failed.
- **Affected path:** resource counts → aggregate outcome → manual-sync route
- **Attempted refutation:** Per-resource detail and zero-write diagnosis remain missing, but the existing aggregate does not paint written-plus-failed work as full success.
- **Impact:** The central partial classifier should be extended, not replaced.
- **Requirement:** GH-04
- **Planned verification:** Plan 21 retains the partial contract while adding bounded per-resource detail.
- **Confidence:** high
- **Unresolved:** no

## AUD-020 — Settings and Admin eager imports may inflate route bundles

- **Source:** performance:M1
- **Status:** suspected
- **Severity:** medium
- **Category:** bundle-size
- **Evidence:** Both section renderers eagerly import broad section maps; the current budget tool does not emit watched rows for these routes.
- **Affected path:** route module graph → client chunks → parse and hydration
- **Attempted refutation:** Older uncompressed figures include a large shared shell and are not current transfer bytes.
- **Impact:** Mobile and cold clients may download and parse unrelated section code.
- **Requirement:** PERF-01
- **Planned verification:** Plan 24 must add or collect route-specific gzip evidence before any split; current aggregate baseline remains in `01-PERFORMANCE-BASELINE.md`.
- **Confidence:** medium
- **Unresolved:** yes

## AUD-021 — Page ceilings can return silently truncated Google histories

- **Source:** performance:C3
- **Status:** confirmed
- **Severity:** high
- **Category:** pagination-completeness
- **Evidence:** Data-point and rollup walkers can return accumulated rows when their final allowed page still contains a continuation token.
- **Affected path:** provider pagination → accumulated resource → watermark and outcome
- **Attempted refutation:** Page caps prevent infinite walks and ordinary incremental windows are smaller, but neither proves completeness at the cap.
- **Impact:** Historical data can be omitted while the cycle appears complete and advances its watermark.
- **Requirement:** GH-05, GH-07
- **Planned verification:** Plan 21 remaining-token-at-limit fixture requiring truncation status and no success watermark.
- **Confidence:** high
- **Unresolved:** yes

## AUD-022 — Google full sync buffers and serializes large workout histories

- **Source:** performance:C5
- **Status:** suspected
- **Severity:** medium
- **Category:** sync-scalability
- **Evidence:** Resource orchestration, workout page accumulation, and per-row persistence are serial in the synchronous manual request.
- **Affected path:** manual sync request → provider pages → workout mapping → database writes
- **Attempted refutation:** Serial ordering protects quota and no live timing proves the request exceeds its route budget.
- **Impact:** Large histories may consume the request window before returning a terminal outcome.
- **Requirement:** PERF-01, GH-07
- **Planned verification:** Plan 21 terminal workout fairness fixture and a database-backed statement-count benchmark before optimization.
- **Confidence:** medium
- **Unresolved:** yes

## AUD-023 — Reminder tick is a global serial query-amplifying pass

- **Source:** performance:C6
- **Status:** suspected
- **Severity:** medium
- **Category:** worker-scalability
- **Evidence:** The worker loads an unpaged medication cohort, processes it serially, and drains cleanup backlog before due-dose evaluation.
- **Affected path:** cleanup queue → medication cohort → per-slot queries → dispatch
- **Attempted refutation:** Local concurrency and dedup prevent overlap and repeats, but do not cap pass duration as cohorts grow.
- **Impact:** Due reminders may arrive late if a pass approaches its fifteen-minute cadence.
- **Requirement:** PERF-01
- **Planned verification:** Use the bounded cohort baseline plus a future database/network-stub p95 and query-budget test before structural changes.
- **Confidence:** medium
- **Unresolved:** yes

## AUD-024 — Dense Health Score reads may scale with sample density

- **Source:** performance:S1
- **Status:** suspected
- **Severity:** medium
- **Category:** score-scalability
- **Evidence:** The score reader fetches time-bounded but unbounded-row raw datasets to preserve local-day and source canonicalization.
- **Affected path:** raw measurements → canonicalization → Health Score → Dashboard
- **Attempted refutation:** Parallel queries, sparse domains, and caches bound common cases; only a dense cold user presents the risk.
- **Impact:** A cold score rebuild may allocate and process many rows for a power user.
- **Requirement:** PERF-01
- **Planned verification:** Use the dense local baseline, then require database row counts, heap, cold p95, and exact production score parity before optimization.
- **Confidence:** medium
- **Unresolved:** yes

## AUD-025 — Timed-out digest prefetch may duplicate bounded assembly work

- **Source:** performance:S2
- **Status:** suspected
- **Severity:** low
- **Category:** request-amplification
- **Evidence:** A soft-timeout loser is not cancelled and can continue while the client later requests the digest.
- **Affected path:** Dashboard server prefetch → soft timeout → client digest request
- **Attempted refutation:** Expensive snapshot work is single-flight and the remaining duplicated assembly is bounded.
- **Impact:** A cold navigation may perform small duplicate work without losing content.
- **Requirement:** PERF-01
- **Planned verification:** Plan 24 trace of one cold timeout navigation; add cancellation only if duplicate builders survive cache coalescing.
- **Confidence:** low
- **Unresolved:** yes

## AUD-026 — Comprehensive Insights screening follows multi-minute generation

- **Source:** live:C1
- **Status:** confirmed
- **Severity:** high
- **Category:** generated-content-latency
- **Evidence:** Redacted aggregate logs show repeated long comprehensive generation attempts ending in fail-closed causal-claim screening.
- **Affected path:** manual generation → provider response → outbound screen → client outcome
- **Attempted refutation:** Screening must remain fail-closed and unrelated request paths did not show a general outage.
- **Impact:** A refresh can occupy the UI for minutes and still produce no fresh provider prose.
- **Requirement:** AI-02, AI-03, AI-04
- **Planned verification:** Plan 20 safe rewrite or deterministic fallback tests with bounded retries and explicit visible outcome.
- **Confidence:** high
- **Unresolved:** yes

## AUD-027 — Status generation is degraded but safe fallback selection survives

- **Source:** live:C2-provider-chain
- **Status:** confirmed
- **Severity:** high
- **Category:** provider-resilience
- **Evidence:** Redacted aggregate logs contain repeated provider-error and screened fallback events while some provider rows later recovered.
- **Affected path:** status pregeneration → provider chain → screen → fallback
- **Attempted refutation:** The provider fleet was not totally unavailable and fallback selection itself was observable.
- **Impact:** Assessments can arrive late or remain deterministic for repeated cycles.
- **Requirement:** AI-02, AI-04
- **Planned verification:** Plan 20 preserves fail-closed fallback behavior and Plan 24 compares post-change reason counters.
- **Confidence:** high
- **Unresolved:** yes

## AUD-028 — Parked Withings targets are counted as synced

- **Source:** live:C3
- **Status:** confirmed
- **Severity:** medium
- **Category:** silent-success
- **Evidence:** A durable parked integration leg remained stale while hourly cohort aggregates counted every target as synced.
- **Affected path:** integration state → cohort polling → job counters → operator view
- **Attempted refutation:** Zero new rows can be healthy, but a persistent parked state and repeated warnings refute all-targets-healthy.
- **Impact:** Stale data can coexist with green cohort counters and delayed intervention.
- **Requirement:** SYNC-02, JOB-01
- **Planned verification:** Plan 22 mixed healthy, parked, failed, and zero-new-data cohort contracts.
- **Confidence:** high
- **Unresolved:** yes

## AUD-029 — Completed job rows contain no bounded outcome facts

- **Source:** live:C4
- **Status:** confirmed
- **Severity:** medium
- **Category:** outcome-honesty
- **Evidence:** Sampled completed operational queues had empty durable output, including zero-target and useful-work cases.
- **Affected path:** job handler result → durable queue row → Admin diagnosis
- **Attempted refutation:** Wide events sometimes carry counters and terminal-failure storage works, but completed rows still cannot distinguish work from no-op.
- **Impact:** Green completion cannot prove targets, writes, skips, failures, or fallbacks.
- **Requirement:** JOB-01
- **Planned verification:** Plan 22 scalar-only durable outcome digest with zero-target, partial, failed, skipped, and successful cases.
- **Confidence:** high
- **Unresolved:** yes

## AUD-030 — Measurement planner statistics and index footprint need maintenance review

- **Source:** live:C5
- **Status:** confirmed
- **Severity:** medium
- **Category:** operations
- **Evidence:** Redacted database aggregates show severely divergent planner estimates and a large index footprint without a current route outage.
- **Affected path:** measurement table statistics → query plans → read and write cost
- **Attempted refutation:** Current representative routes remain healthy and storage has headroom, so no incident or emergency rewrite is proven.
- **Impact:** Stale cardinality estimates can select poor plans as data changes.
- **Requirement:** OPS-01
- **Planned verification:** Plan 24 maintenance-window decision using representative plans before ordinary analyze or vacuum; no deploy-time storage rewrite.
- **Confidence:** high
- **Unresolved:** yes

## AUD-031 — Shared-host peaks are not attributable to HealthLog

- **Source:** live:S2
- **Status:** suspected
- **Severity:** low
- **Category:** host-pressure
- **Evidence:** Aggregate host peaks coincided with isolated slow health checks, while the application had no restart, memory kill, or sustained common-path slowdown.
- **Affected path:** shared host scheduling → application event loop → request latency
- **Attempted refutation:** Other workloads share the host and current application resource use was materially calmer.
- **Impact:** Isolated slow reads are possible, but no HealthLog regression is established.
- **Requirement:** AUD-03, OPS-01
- **Planned verification:** Correlate future slow events with per-container metrics and event-loop lag before changing application code.
- **Confidence:** low
- **Unresolved:** yes

## AUD-032 — Status transport errors can masquerade as no provider

- **Source:** performance:C4; live:S3
- **Status:** confirmed
- **Severity:** medium
- **Category:** terminal-state
- **Evidence:** Status hooks stop after transport failure and consumers omit the error state, defaulting absent data to no-provider semantics.
- **Affected path:** status transport → query hook → shared card
- **Attempted refutation:** Successful preparing responses poll correctly; the defect is specific to timeout and route-error transport.
- **Impact:** A failed read can show a false configuration prompt or hide safe fallback text.
- **Requirement:** AI-03, AI-04, AI-05
- **Planned verification:** Plan 20 aborted and server-error hook/card matrix with bounded retry and honest terminal rendering.
- **Confidence:** high
- **Unresolved:** yes

## AUD-033 — Runtime availability showed no general outage

- **Source:** live:cleared-runtime
- **Status:** cleared
- **Severity:** info
- **Category:** runtime-health
- **Evidence:** Read-only health, restart, and resource aggregates showed healthy application and database containers over the inspected window.
- **Affected path:** runtime containers → health endpoint → operator availability
- **Attempted refutation:** The audit checked restart, memory-kill, current resource, and full-window signals rather than one status response alone.
- **Impact:** No general outage explains the targeted integration and Insights symptoms.
- **Requirement:** AUD-03
- **Planned verification:** Plan 24 repeats health checks after the integrated build and Plan 25 records release evidence.
- **Confidence:** high
- **Unresolved:** no

## AUD-034 — Migration state showed no schema drift

- **Source:** live:cleared-migrations
- **Status:** cleared
- **Severity:** info
- **Category:** schema-health
- **Evidence:** Repository and database migration aggregates matched with no unfinished or rolled-back migration.
- **Affected path:** migration files → deployment ledger → runtime schema
- **Attempted refutation:** The audit compared counts and latest names rather than relying on application startup alone.
- **Impact:** Schema drift is not an evidenced cause of the reported symptoms.
- **Requirement:** AUD-03
- **Planned verification:** Preserve the normal migration gate and repeat it after any Plan 21 schema addition.
- **Confidence:** high
- **Unresolved:** no

## AUD-035 — No unrelated server-error or queue-lock cluster was found

- **Source:** live:cleared-errors-and-locks
- **Status:** cleared
- **Severity:** info
- **Category:** runtime-health
- **Evidence:** Redacted status aggregates found no server-error cluster outside screened generation, no exhausted queue retries, and no database lock incident.
- **Affected path:** HTTP actions and background queues → database concurrency → operator signals
- **Attempted refutation:** Queue state and database activity were checked directly in addition to structured logs.
- **Impact:** The audit does not support broad runtime or database remediation.
- **Requirement:** AUD-03, AUD-04
- **Planned verification:** Plan 24 merged re-audit with durable outcome facts, followed by Plan 25 release gate.
- **Confidence:** high
- **Unresolved:** no

## Reconciliation conclusions

- Confirmed findings map to an implementation plan or remain an explicit release
  blocker. No confirmed defect is silently downgraded to a hypothesis.
- The reporter-specific Google failure remains externally blocked even though
  adjacent cache, pagination, and outcome defects are independently confirmed.
- Performance entries preserve the difference between local measurements and
  production behavior. No optimization or dependency change is authorized by
  this ledger.
- Cleared findings remain recorded so future re-audits can distinguish a
  regression from an already-refuted adjacent theory.
