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

-- Refs #776 — record what became of a document's content-index attempt.
-- Additive, nullable, no backfill: existing rows read NULL ("no attempt
-- recorded"), which is exactly true for them — outcomes only exist from the
-- release that writes them. `last_index_outcome` is a closed string enum
-- enforced in code (see `DocumentIndexOutcomeValue`); NULL after a
-- successful attempt, since the `document_content_index` row itself is the
-- success signal.
ALTER TABLE "inbound_documents" ADD COLUMN "last_index_attempt_at" TIMESTAMP(3);
ALTER TABLE "inbound_documents" ADD COLUMN "last_index_outcome" TEXT;
