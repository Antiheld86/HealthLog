# v1.34.1 merged cross-domain re-audit

**Re-audited:** 2026-07-29

**Tree:** merged `release/v1.34.1` working tree

**Decision:** BLOCK

The merged implementation was traced from writer through durable state, reader,
API and card/operator boundary. The re-audit also reran 21 focused unit and
component files with 251 passing tests and eight real-PostgreSQL files with 42
passing tests.

Two findings block release:

- AUD-010 remains externally evidence-gated; this tree cannot honestly claim
  the reporter-specific Google full-sync failure resolved.
- AUD-029 remains an implementation gap: successful bounded job outcomes are
  constructed and validated but discarded before pg-boss persistence.

The residual set is exact:

- AUD-029: successful job outcomes are not durably persisted, Medium and
  release-blocking;
- Nightscout token warning logs: accepted Low scanner residual, unchanged;
- PWA post-logout offline asset refetch: accepted Low privacy-first behavior;
  and
- AUD-030: stale planner statistics, Medium controlled-operations residual.

AUD-010 is a separate reporter-evidence checkpoint, not an adopted residual.
No new High finding was discovered.

## AUD-001 — Dashboard pending lead no longer duplicates the headline score

- **Source:** research:merged-001; correctness:dashboard-lead
- **Status:** cleared
- **Severity:** medium
- **Category:** presentation-correctness
- **Evidence:** `src/lib/daily/digest.ts` and `src/components/daily/today-hero.tsx` now preserve one numeric headline representation, covered by the merged Dashboard contract.
- **Affected path:** digest fallback → Dashboard hero lead → score ring
- **Attempted refutation:** Cold fallback was rechecked because generated prose can replace it later; the deterministic cold state no longer repeats the score.
- **Impact:** The former unfinished-looking duplicate headline is absent.
- **Requirement:** DASH-01
- **Planned verification:** Re-audit accepted the Plan 16 component contract; the full browser artifact remains part of the release gate.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed in the merged tree.

## AUD-002 — Stored document summary action is state-correct

- **Source:** research:merged-002; correctness:document-ready
- **Status:** cleared
- **Severity:** low
- **Category:** product-grammar
- **Evidence:** `src/components/documents/document-summary-block.tsx` limits generation actions to states that require generation or retry.
- **Affected path:** stored summary state → document detail action
- **Attempted refutation:** First-generation and retry states were retained as positive controls; only ready-state regeneration disappeared.
- **Impact:** A readable stored summary no longer presents a redundant primary action.
- **Requirement:** DOC-01
- **Planned verification:** Plan 16 ready and retry component contracts were reviewed in the merged tree.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-003 — Health Score presentation uses the accepted density

- **Source:** research:merged-003; correctness:score-density
- **Status:** cleared
- **Severity:** low
- **Category:** presentation-density
- **Evidence:** `src/components/insights/health-score-card.tsx` no longer renders the rejected method, composition, band and algorithm blocks as competing card sections.
- **Affected path:** Health Score report → card presentation
- **Attempted refutation:** The retained transparency surface and canonical score construction were checked so presentation cleanup did not remove score provenance.
- **Impact:** Pillar detail is no longer obscured by duplicate explanatory blocks.
- **Requirement:** INS-01, INS-02, INS-03, INS-04
- **Planned verification:** Merged Plan 16 contracts and Plan 23 locale integrity coverage pass.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-004 — Medication assessment prose uses shared emphasis

- **Source:** research:merged-004; correctness:medication-tone
- **Status:** cleared
- **Severity:** low
- **Category:** visual-consistency
- **Evidence:** The medication assessment renders through the shared foreground assessment presentation rather than a muted one-off body.
- **Affected path:** medication assessment result → Insights card body
- **Attempted refutation:** Adjacent assessment cards were compared to avoid a global token change; the fix remains local to the intended shared contract.
- **Impact:** Medication assessment prose has the same hierarchy as equivalent assessments.
- **Requirement:** INS-06, INS-07
- **Planned verification:** The shared card regression is included in the 251-test re-audit run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-005 — Empty record managers expose one create action

- **Source:** research:merged-005; correctness:records-empty
- **Status:** cleared
- **Severity:** low
- **Category:** product-grammar
- **Evidence:** Allergy and Family History managers condition the header action so the empty state owns the single create entry point.
- **Affected path:** empty records query → manager header and empty state
- **Attempted refutation:** Populated states retain their header action and mutation path; only duplicate empty affordances were removed.
- **Impact:** Empty records screens no longer present two equivalent primary actions.
- **Requirement:** REC-01, REC-03
- **Planned verification:** Plan 16 empty and populated component contracts were reviewed.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-006 — Desktop navigation aligns and remains pinned

- **Source:** research:merged-006; performance:navigation-shell
- **Status:** cleared
- **Severity:** low
- **Category:** navigation-layout
- **Evidence:** Settings and Admin shells place heading, rail and content in the accepted desktop grid while retaining the mobile navigation branch.
- **Affected path:** desktop shell grid → sticky navigation → section content
- **Attempted refutation:** Sticky behavior alone was not accepted; initial heading alignment and scroll pinning are both represented in the responsive contracts.
- **Impact:** The navigation rail no longer visibly travels before pinning.
- **Requirement:** NAV-01, NAV-02, NAV-03, NAV-04, NAV-05
- **Planned verification:** Plan 17 responsive and authorization contracts pass; deterministic release screenshots remain a separate gate.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-007 — Medication occurrence identity survives the local-day boundary

- **Source:** correctness:merged-007; research:day-key
- **Status:** cleared
- **Severity:** critical
- **Category:** day-boundary
- **Evidence:** `medication-reminder-check.ts`, recurrence projection and list reads carry schedule ID plus exact scheduled instant; dedup and intake lookup use the occurrence local date.
- **Affected path:** recurrence → occurrence instant → intake attribution → reminder dedup → all medication consumers
- **Attempted refutation:** Tests include ordinary midnight, a daylight-saving boundary, positive-offset time, exact taken, skipped, auto-missed, sibling schedule, replacement era and retry controls.
- **Impact:** A late completed dose does not repeat after midnight and the next distinct dose remains actionable.
- **Requirement:** REM-01, REM-02, REM-03, REM-04
- **Planned verification:** Two real-PostgreSQL medication files passed again in the 42-test boundary run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Code path closed; reporter confirmation remains a release-process follow-up rather than a reproduced defect.

## AUD-008 — Google resource diagnoses reach the terminal user outcome

- **Source:** correctness:merged-008; research:google-reasons
- **Status:** cleared
- **Severity:** high
- **Category:** outcome-honesty
- **Evidence:** `sync.ts`, the manual-sync route, sync-status route and Google card carry bounded resource status and stable reason codes through complete, partial, truncated, failed and interrupted states.
- **Affected path:** provider resource → progress ledger → route envelope → integration card
- **Attempted refutation:** Generic failure remains the fallback for unknown errors, but known resource reasons are preserved and raw provider errors are excluded.
- **Impact:** Users receive an honest bounded diagnosis instead of a generic successful-looking retry prompt.
- **Requirement:** GH-03, GH-04, GH-06
- **Planned verification:** Google route, status and card files passed in the 251-test re-audit run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed for fixture-proven reason classes.

## AUD-009 — Safe deterministic Insights fallback persists and renders

- **Source:** correctness:merged-009; live:fallback-selection
- **Status:** cleared
- **Severity:** high
- **Category:** persistence
- **Evidence:** `status-shared.ts`, `status-cache.ts`, the hook and shared card treat safe text as the primary state and provider presence only as provenance metadata.
- **Affected path:** outbound screen → deterministic fallback → cache → reader → card
- **Attempted refutation:** Provider-setup, retry and negative-cache states remain available when no safe text exists; screened prose itself is never persisted.
- **Impact:** A safe assessment no longer becomes whitespace or a false provider-setup prompt.
- **Requirement:** AI-01, AI-02, AI-03, AI-04
- **Planned verification:** Screen, cache, hook and card regressions passed in the 251-test run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-010 — Reporter-specific Google full-sync failure remains externally gated

- **Source:** live:merged-010; research:external-google-report
- **Status:** blocked
- **Severity:** high
- **Category:** external-evidence
- **Evidence:** The audited production instance still has no connected Google cohort or retained reporter trace; fixtures prove internal branches but cannot reproduce the external environment.
- **Affected path:** reporter environment → manual full sync → terminal response
- **Attempted refutation:** Workout-first ordering, durable progress, truncation and terminal outcome fixtures all pass, but adjacent fixture success cannot disprove a report the instance cannot exercise.
- **Impact:** The release must not claim the specific full-sync report resolved without redacted reporter evidence.
- **Requirement:** GH-01, GH-06
- **Planned verification:** Obtain the redacted terminal response, release/build and resource outcome from the reporter, then reproduce that exact class.
- **Confidence:** high
- **Unresolved:** yes
- **Closure:** Release blocker until the external checkpoint is satisfied or explicitly waived by the release owner.

## AUD-011 — Insights polling ends in an honest terminal state

- **Source:** correctness:merged-011; research:poll-ceiling
- **Status:** cleared
- **Severity:** high
- **Category:** terminal-state
- **Evidence:** `use-insight-status.ts` bounds attempts per query identity and maps timeout, transport failure and poll exhaustion to explicit terminal states rendered by the shared card.
- **Affected path:** status request loop → polling ceiling → assessment card
- **Attempted refutation:** Revalidation preserves existing safe text, but a preparation-only payload cannot survive the final allowed poll unchanged.
- **Impact:** Bounded network work no longer leaves an unbounded preparing message.
- **Requirement:** AI-03, AI-04, AI-05
- **Planned verification:** Hook and card timer/state tests passed in the 251-test run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-012 — Google writes invalidate server and browser consumers

- **Source:** correctness:merged-012; performance:cache-prewarm
- **Status:** cleared
- **Severity:** high
- **Category:** cache-freshness
- **Evidence:** `sync-workout.ts` invalidates server measurement readers after committed writes; the Google card invalidates workouts, Dashboard snapshot, analytics, Google and integration-status query families.
- **Affected path:** Google write → server projections → browser queries → Dashboard and workouts
- **Attempted refutation:** Invalidation is emitted only after the relevant write resolves; failed and zero-write paths cannot announce nonexistent data.
- **Impact:** Successful imports become visible without waiting for expiry or remount.
- **Requirement:** GH-02, GH-04, SYNC-03
- **Planned verification:** The real-PostgreSQL workout-terminal cache test passed again.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-013 — Resolved Google failures are not counted as synced

- **Source:** correctness:merged-013; performance:cohort-fold
- **Status:** cleared
- **Severity:** high
- **Category:** silent-success
- **Evidence:** Google cohort code awaits the typed verdict and `poll-cohort.ts` increments synced users only for complete outcomes, including legitimate clean zero.
- **Affected path:** per-user verdict → cohort fold → operator counters
- **Attempted refutation:** Isolated user failures still do not fail the whole cohort, but they increment failed, parked, skipped or partial counters rather than success.
- **Impact:** Green cohort counters can no longer conceal a resolved failure.
- **Requirement:** SYNC-02, JOB-01
- **Planned verification:** Mixed-outcome cohort tests passed in the 251-test run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** In-memory and structured cohort accounting closed; durable job-row persistence is tracked separately by AUD-029.

## AUD-014 — Rollup failure prevents complete Google success

- **Source:** correctness:merged-014; research:rollup-verdict
- **Status:** cleared
- **Severity:** medium
- **Category:** outcome-honesty
- **Evidence:** `sync-core.ts` records a stable rollup failure; `sync.ts` returns a failed or partial resource and withholds the complete-success watermark.
- **Affected path:** raw write → rollup recomputation → progress → watermark
- **Attempted refutation:** Raw rows may have committed, so the result remains partial rather than pretending no work occurred; it is never complete.
- **Impact:** Derived readers are not represented as current after rollup failure.
- **Requirement:** GH-04, GH-06, SYNC-03
- **Planned verification:** Forced rollup-failure outcome tests passed in the focused Google run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-015 — Reminder stamp-before-send policy is explicit

- **Source:** correctness:merged-015; research:delivery-policy
- **Status:** cleared
- **Severity:** medium
- **Category:** delivery-policy
- **Evidence:** `medication-reminder-check.ts` deliberately writes the dedup anchor before dispatch and records a failed counter when dispatch throws.
- **Affected path:** reminder candidate → durable anchor → channel dispatch → next tick
- **Attempted refutation:** The order prevents a crash from repeating a phase every worker tick, but it cannot guarantee delivery without an outbox.
- **Impact:** A transient dispatch failure can suppress one reminder phase.
- **Requirement:** OPS-01
- **Planned verification:** The explicit at-most-once decision and future durable-outbox boundary are recorded in `01-OPS-DECISION.md`.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Decision-complete in `01-OPS-DECISION.md`; the release makes no reliable-delivery claim and adds no reminder residual.

## AUD-016 — Recovery assessment uses the verified shared presentation

- **Source:** correctness:merged-016; research:recovery-visual
- **Status:** cleared
- **Severity:** low
- **Category:** visual-consistency
- **Evidence:** Recovery uses the same populated assessment component, foreground token and stable geometry that passed the shared component run and is covered by the separate release visual gate.
- **Affected path:** Recovery metric state → shared assessment card → responsive theme
- **Attempted refutation:** The audit required the shared component contract plus the release visual owner rather than inferring parity from CSS alone.
- **Impact:** No distinct Recovery presentation defect is established.
- **Requirement:** INS-06, INS-07
- **Planned verification:** The separate release-gate artifact matrix owns final browser evidence.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared; no independent residual.

## AUD-017 — Records retain explicit revision and delete semantics

- **Source:** correctness:merged-017; research:records-semantics
- **Status:** cleared
- **Severity:** info
- **Category:** records-semantics
- **Evidence:** Save, correction history and confirmed removal remain separate paths after the empty-state action cleanup.
- **Affected path:** records editor → revision persistence → history and removal
- **Attempted refutation:** Conditional rendering was traced to ensure it changes affordance count only and not mutation selection.
- **Impact:** No adjacent overwrite or accidental delete defect is established.
- **Requirement:** REC-02, REC-04, REC-05
- **Planned verification:** Plan 16 one-mutation and history contracts remain applicable.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared.

## AUD-018 — Navigation and enrollment authorization fail closed

- **Source:** correctness:merged-018; research:authorization-boundary
- **Status:** cleared
- **Severity:** info
- **Category:** authorization
- **Evidence:** Admin content waits for an authorized role; passkey registration requires a live cookie session, an existing-factor proof and a session-bound single-use challenge.
- **Affected path:** session/role/proof → privileged shell or credential enrollment
- **Attempted refutation:** Positive admin and eligible enrollment paths still succeed; bearer, stale, foreign, replay and unprivileged paths fail.
- **Impact:** No adjacent authorization bypass was found.
- **Requirement:** NAV-01, NAV-03, SEC-05
- **Planned verification:** Passkey and admin-reset real-PostgreSQL files passed in the 42-test run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared.

## AUD-019 — Written-plus-failed Google work remains partial

- **Source:** correctness:merged-019; research:partial-classifier
- **Status:** cleared
- **Severity:** info
- **Category:** outcome-honesty
- **Evidence:** The route and card preserve a partial outcome when rows were written and another resource failed.
- **Affected path:** resource counts → aggregate outcome → manual-sync response
- **Attempted refutation:** Zero-write failures and complete success were checked separately so partial is not a universal fallback.
- **Impact:** Useful partial work is visible without being painted as complete.
- **Requirement:** GH-04
- **Planned verification:** Route and card outcome matrices passed.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared.

## AUD-020 — Watched Settings and Admin bundles remain within budget

- **Source:** performance:merged-020; research:eager-imports
- **Status:** cleared
- **Severity:** medium
- **Category:** bundle-size
- **Evidence:** The regenerated Plan 15 bundle snapshot passed the total client budget and all four watched route budgets with recorded headroom.
- **Affected path:** route module graph → client chunks → parse and hydration
- **Attempted refutation:** Aggregate size alone was not used; watched route rows were required after the analyzer workflow was repaired for the current bundler.
- **Impact:** No release-level route-size breach is established.
- **Requirement:** PERF-01
- **Planned verification:** The release gate must rerun the bundle budget on its recorded snapshot.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared against the measured budget; future growth remains monitored.

## AUD-021 — Google page ceilings cannot silently advance completeness

- **Source:** performance:merged-021; correctness:pagination-cap
- **Status:** cleared
- **Severity:** high
- **Category:** pagination-completeness
- **Evidence:** Client walkers record a truncated resource when a continuation token remains at the cap; `sync.ts` propagates truncation and withholds complete-success watermarking.
- **Affected path:** provider pagination → progress resource → terminal state → watermark
- **Attempted refutation:** A long successful history with 786 completed pages remains complete, proving the fix does not impose an artificial smaller ceiling.
- **Impact:** Omitted history cannot be represented as a complete sync.
- **Requirement:** GH-05, GH-07
- **Planned verification:** Fairness, truncation and progress fixtures passed in the focused Google run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-022 — Google full-sync fairness is bounded at the release contract

- **Source:** performance:merged-022; research:sync-scalability
- **Status:** cleared
- **Severity:** medium
- **Category:** sync-scalability
- **Evidence:** Workouts run before dense history, the large successful fixture completes, and durable progress exposes terminal state when the request boundary is uncertain.
- **Affected path:** manual request → provider pages → mapping → persistence
- **Attempted refutation:** Unbounded provider histories cannot be proven, but no tested fairness, truncation or terminal-state contract is violated.
- **Impact:** No silent or release-budget failure is established.
- **Requirement:** PERF-01, GH-07
- **Planned verification:** Continue performance monitoring before any future structural optimization.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared against the defined release contract; no residual adopted.

## AUD-023 — Reminder cohort baseline shows no release-budget breach

- **Source:** performance:merged-023; research:reminder-scan
- **Status:** cleared
- **Severity:** medium
- **Category:** worker-scalability
- **Evidence:** The worker remains a bounded global pass with serial per-medication work; the fixture baseline did not establish a release-budget violation.
- **Affected path:** reminder tick → medication scan → recurrence and dispatch
- **Attempted refutation:** The bounded baseline and current cohort evidence show no present breach; future growth is monitoring, not a current defect.
- **Impact:** No release-blocking worker cost is established.
- **Requirement:** PERF-01
- **Planned verification:** Add a database/network-stub p95 and query budget before a future structural change.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared for this release; no residual adopted.

## AUD-024 — Dense Health Score baseline stays within the release evidence

- **Source:** performance:merged-024; research:score-density-cost
- **Status:** cleared
- **Severity:** medium
- **Category:** score-scalability
- **Evidence:** The dense local baseline passed but the read path still scales with the amount of retained source data.
- **Affected path:** score request → measurement reads → canonical score
- **Attempted refutation:** The audit required exact score parity and measured timing; no threshold breach was observed.
- **Impact:** No current score-read regression is established.
- **Requirement:** PERF-01
- **Planned verification:** Require row count, heap and cold p95 evidence with exact score parity before any future optimization.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared for this release; no residual adopted.

## AUD-025 — Digest prefetch shows no duplicate-work release breach

- **Source:** performance:merged-025; research:digest-prefetch
- **Status:** cleared
- **Severity:** low
- **Category:** request-amplification
- **Evidence:** Digest assembly is bounded and cache-coalesced, but a timeout does not by itself prove the underlying builder stopped.
- **Affected path:** cold navigation → prefetch timeout → builder/cache
- **Attempted refutation:** No duplicate-work breach appeared in the measured route baseline, so cancellation is not justified release work.
- **Impact:** No current user-visible or capacity defect is established.
- **Requirement:** PERF-01
- **Planned verification:** Trace a future cold timeout only if monitoring shows a breach.
- **Confidence:** medium
- **Unresolved:** no
- **Closure:** Cleared; no residual adopted.

## AUD-026 — Slow screened Insights generation has a safe terminal result

- **Source:** live:merged-026; correctness:screened-generation
- **Status:** cleared
- **Severity:** high
- **Category:** generated-content-latency
- **Evidence:** Derived assessment generation screens before persistence and maps blocked, malformed or ungrounded prose to a deterministic fallback; polling ends explicitly.
- **Affected path:** provider generation → screen → cache → visible assessment
- **Attempted refutation:** Screening remains fail closed and slow providers can still consume their bounded request time; the change closes disappearance, not provider latency.
- **Impact:** A slow rejected response no longer ends as unexplained absence.
- **Requirement:** AI-02, AI-03, AI-04
- **Planned verification:** Generator, screen, hook and card tests passed in the focused run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Safety/outcome defect closed; provider latency remains observable.

## AUD-027 — Provider degradation preserves deterministic status text

- **Source:** live:merged-027; correctness:provider-resilience
- **Status:** cleared
- **Severity:** high
- **Category:** provider-resilience
- **Evidence:** Cache and card state prioritize screened fallback text while retaining bounded provider retry metadata.
- **Affected path:** degraded provider chain → safe fallback → status card
- **Attempted refutation:** Healthy generated text still supersedes fallback when it passes all screens; fallback is not mislabeled as provider content.
- **Impact:** Provider degradation does not create a blank assessment.
- **Requirement:** AI-02, AI-04
- **Planned verification:** Focused fallback and provider-state matrices passed.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed in code; live reason counters should be compared after deployment.

## AUD-028 — Parked Withings targets are not counted as synced

- **Source:** live:merged-028; correctness:withings-cohort
- **Status:** cleared
- **Severity:** medium
- **Category:** silent-success
- **Evidence:** Withings handlers fold connected, parked, partial, failed and clean-zero verdicts through the shared provider-neutral cohort aggregate.
- **Affected path:** integration state → per-user result → cohort counters
- **Attempted refutation:** Zero imported rows can still be healthy and count as clean success; parked state cannot.
- **Impact:** Operator counters distinguish a parked target from a healthy no-new-data target.
- **Requirement:** SYNC-02, JOB-01
- **Planned verification:** Mixed provider cohort tests passed in the 251-test run.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** In-memory accounting closed; durable row persistence is AUD-029.

## AUD-029 — Successful job outcomes are still absent from durable completed rows

- **Source:** live:merged-029; correctness:job-output-wiring
- **Status:** confirmed
- **Severity:** medium
- **Category:** outcome-honesty
- **Evidence:** `job-outcome.ts` validates a bounded serializer, but its only callers are tests; `run-job.ts` returns immediately with `void` when `outcome.ok` and never persists or returns the serialized facts to pg-boss.
- **Affected path:** handler `JobOutcome` → run wrapper → pg-boss completed row → operator reader
- **Attempted refutation:** Cohort handlers now construct truthful scalar facts and failed outcomes reach retry/error reporting, but neither makes successful facts durable.
- **Impact:** Completed jobs still cannot distinguish useful work, clean zero, skips, partial cohorts or fallbacks after logs expire.
- **Requirement:** JOB-01
- **Planned verification:** Wire `serializeJobOutcome` to a bounded durable success result, then prove completed rows contain only the allowlisted facts for useful, zero, partial and skipped runs.
- **Confidence:** high
- **Unresolved:** yes
- **Closure:** Release blocker; Plan 22's serializer is not an end-to-end persistence implementation.

## AUD-030 — Measurement planner statistics remain materially stale

- **Source:** live:merged-030; performance:planner-statistics
- **Status:** confirmed
- **Severity:** medium
- **Category:** operations
- **Evidence:** The read-only snapshot reports 628 estimated live and 24,253 dead tuples while `reltuples` remains 389,116; the relation uses about 664 MB across heap and 13 indexes with no recorded vacuum or analyze.
- **Affected path:** planner statistics → measurement query plans → maintenance thresholds
- **Attempted refutation:** There was no active contention or old transaction and earlier request timings were healthy; this refutes an outage but not stale cardinality.
- **Impact:** Bad estimates can select inefficient plans and delay threshold-based maintenance as data changes.
- **Requirement:** OPS-01
- **Planned verification:** Follow the separate read-plan, approved maintenance and remeasurement sequence in `01-OPS-DECISION.md`.
- **Confidence:** high
- **Unresolved:** yes
- **Closure:** Controlled operational residual; no release/deploy mutation was performed or authorized.

## AUD-031 — Shared-host peaks do not establish a HealthLog defect

- **Source:** live:merged-031; performance:host-pressure
- **Status:** cleared
- **Severity:** low
- **Category:** host-pressure
- **Evidence:** The prior aggregate host sample showed no HealthLog-specific causal trace for occasional shared-host peaks.
- **Affected path:** shared host load → container scheduling → request latency
- **Attempted refutation:** Healthy containers and bounded application timings provide no causal HealthLog link; future incidents require their own evidence.
- **Impact:** No application release defect is established.
- **Requirement:** AUD-03, OPS-01
- **Planned verification:** Correlate any future slow event with per-container metrics and event-loop lag.
- **Confidence:** medium
- **Unresolved:** no
- **Closure:** Cleared for this release; no residual adopted.

## AUD-032 — Status transport errors cannot masquerade as no provider

- **Source:** correctness:merged-032; live:transport-state
- **Status:** cleared
- **Severity:** medium
- **Category:** terminal-state
- **Evidence:** The hook maps abort, timeout and server failure to fixed error kinds; the card reserves provider setup for a genuine no-provider state.
- **Affected path:** status transport → hook normalization → card branch
- **Attempted refutation:** A real no-provider response still reaches setup guidance, proving transport failure is not collapsed into the same branch.
- **Impact:** Users receive an honest retryable or exhausted state instead of incorrect configuration advice.
- **Requirement:** AI-03, AI-04, AI-05
- **Planned verification:** Hook and card transport matrices passed.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Closed.

## AUD-033 — No general runtime outage is evidenced

- **Source:** live:merged-033; research:runtime-health
- **Status:** cleared
- **Severity:** info
- **Category:** runtime-health
- **Evidence:** The bounded production database snapshot completed immediately with one active session and no transaction older than one minute; the earlier same-day app audit found healthy containers and no general error cluster.
- **Affected path:** production runtime → database availability → application health
- **Attempted refutation:** This does not prove every provider integration is healthy and is not used to clear the reporter-specific Google finding.
- **Impact:** No general outage blocks interpretation of the targeted findings.
- **Requirement:** AUD-03
- **Planned verification:** Repeat served-version and health evidence in the release/deploy gate.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared for the bounded audit window.

## AUD-034 — Schema delta is singular and additive

- **Source:** live:merged-034; correctness:migration-boundary
- **Status:** cleared
- **Severity:** info
- **Category:** schema-health
- **Evidence:** From the recorded base, the only migration delta is `0287_google_health_sync_progress`; its SQL adds one nullable JSONB column and the Prisma mapping is the only matching schema change.
- **Affected path:** base tree → migration set → Google progress persistence
- **Attempted refutation:** Package, migration name, SQL body and Prisma schema were checked separately so a renamed or hidden schema delta could not pass by filename count alone.
- **Impact:** The release does not carry an unrelated schema or dependency change.
- **Requirement:** AUD-03, GH-07
- **Planned verification:** Migration-name, SQL-content and package-baseline commands pass before handoff.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared.

## AUD-035 — No unrelated queue-lock or server-error cluster was introduced

- **Source:** live:merged-035; correctness:cross-domain-regression
- **Status:** cleared
- **Severity:** info
- **Category:** runtime-health
- **Evidence:** The focused merged run passed 251 tests and the real-PostgreSQL boundary run passed 42 tests across medication, archive encryption, Google progress/cache, MCP replay, passkey and reset paths.
- **Affected path:** merged security/reliability tree → shared runtime boundaries
- **Attempted refutation:** Passing focused tests cannot replace the full release suite and does not clear AUD-010 or AUD-029.
- **Impact:** No additional cross-domain failure was found within the audited boundaries.
- **Requirement:** AUD-03, AUD-04
- **Planned verification:** The independent full release gate must still pass with zero release-critical failure or skip.
- **Confidence:** high
- **Unresolved:** no
- **Closure:** Cleared within Task 3 scope.

## AUD-036 — Nightscout token warning logs remain an accepted scanner residual

- **Source:** research:merged-036; correctness:nightscout-log-residual
- **Status:** confirmed
- **Severity:** low
- **Category:** privacy
- **Evidence:** The accepted scanner ledger still identifies legacy Nightscout token warning-log exposure; the exact-origin SSRF work did not claim or implement log redaction.
- **Affected path:** Nightscout error handling → warning log sink
- **Attempted refutation:** Connect, sync and operator-origin failures use stable redacted policy codes, but that does not refute the separately accepted token-warning path.
- **Impact:** A Nightscout credential could enter operator-controlled logs on the legacy warning branch.
- **Requirement:** DEFER-SEC-01
- **Planned verification:** Retain documentation and owner follow-up; do not claim closure without a dedicated log-redaction test and implementation.
- **Confidence:** high
- **Unresolved:** yes
- **Closure:** Accepted Low residual; unchanged and not release-blocking.

## AUD-037 — PWA logout favors privacy over immediate offline asset reuse

- **Source:** research:merged-037; correctness:pwa-privacy-tradeoff
- **Status:** confirmed
- **Severity:** low
- **Category:** privacy
- **Evidence:** Logout clears all current and legacy HealthLog static, page and data caches; the next offline launch can therefore show the data-free fallback until public assets are fetched again.
- **Affected path:** session end → owned cache eviction → next offline launch
- **Attempted refutation:** Unrelated cache namespaces survive and immutable public assets are cached again online; preserving the old HealthLog static cache would weaken complete account-data eviction.
- **Impact:** A user may temporarily lose the rich offline shell after logout, while authenticated Dashboard HTML cannot survive the session.
- **Requirement:** SEC-02, SEC-08
- **Planned verification:** Service-worker and query-persister privacy tests passed in the 251-test merged run.
- **Confidence:** high
- **Unresolved:** yes
- **Closure:** Accepted Low privacy-first behavior; unchanged and not release-blocking.

## Verification summary

| Gate | Result |
| --- | --- |
| Focused merged unit/component audit | PASS — 21 files, 251 tests |
| Real-PostgreSQL boundary audit | PASS — 8 files, 42 tests |
| Normalized ledger checker | PASS — 37 unique findings, privacy scan clean |
| Branch and immutable package baseline | PASS |
| Sole migration delta and SQL shape | PASS |
| Production planner diagnostic | PASS, read-only |
| Exact residual set | AUD-029, Nightscout warning logs, PWA offline-refetch behavior, AUD-030 |
| Release decision | BLOCK — AUD-010 evidence checkpoint and AUD-029 implementation gap |
