-- Refs #788 — heal phantom summary PENDING rows.
-- `enqueueDocumentSummary` used to claim PENDING even when the owner's
-- auto-read opt-in was OFF; the job's opt-out branch then left the state
-- alone, so the detail view said "being generated" forever. Both writers now
-- agree (the enqueue end no longer claims what the job cannot resolve, the
-- job end heals PENDING→NONE on opt-out); this one-time data fix drains the
-- rows already stranded. Safe by construction: READY / WITHHELD / UNAVAILABLE
-- are never touched, and a job that is genuinely mid-flight rewrites its
-- terminal state after this UPDATE anyway.
UPDATE "inbound_documents"
SET "summary_state" = 'NONE'
WHERE "summary_state" = 'PENDING';
