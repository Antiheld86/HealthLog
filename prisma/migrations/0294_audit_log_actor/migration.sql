-- v1.36.0 — who acted, when it was not the person the row is filed under.
--
-- The audit trail has answered one question until now: what happened to this
-- account. Delegation splits it in two — what happened to this account, and
-- who was at the keyboard — and a single `user_id` cannot hold both answers.
--
-- NULL is the whole design of this column. Every row written before today
-- means "this account acted for itself", and that reading has to survive: a
-- backfill, a default, or a threading rule that helpfully stamps the caller's
-- own id would rewrite the meaning of every historical row at once, silently,
-- with nothing to compare against afterwards. So the column arrives nullable,
-- unbackfilled, and the code that fills it (`src/lib/auth/audit.ts`) fills it
-- only when the request actually resolved an acting account.
--
-- A delegated action files under the OWNER, with the delegate here. The owner's
-- record was the thing touched, and "what happened to my data" is the owner's
-- question to ask.
--
-- No foreign key, deliberately, and against the grain of `user_id` right above
-- it. `user_id` is ON DELETE SET NULL because an erased account should drop out
-- of its own history. Applying that rule here would not erase, it would falsify:
-- nulling the actor turns "the delegate opened this record" into "the owner
-- opened this record", which is a sentence the trail would then assert about a
-- day it did not happen. An id that no longer resolves to a user reads as a
-- deleted account and is honest about it. The 365-day retention purge
-- (`src/lib/jobs/audit-log-cleanup.ts`) bounds how long the id lives either way.

ALTER TABLE "audit_logs" ADD COLUMN "actor_user_id" TEXT;

-- The owner's "who touched my record" view: their rows, delegated ones only,
-- newest first. Every existing index on this table leads with `user_id` and
-- then `action` or `created_at`, so without this one that read scans an
-- account's entire history — on the table the schema itself calls the
-- highest-churn one — to surface the few rows that carry an actor.
CREATE INDEX "audit_logs_user_id_actor_user_id_created_at_idx"
    ON "audit_logs" ("user_id", "actor_user_id", "created_at" DESC);

-- Delegated reads coalesce to one row per (owner, delegate, day).
--
-- Without this, a delegate paging through a record writes an audit row per
-- request, on the table that is already the busiest one here, and the owner's
-- activity view becomes a wall of identical lines nobody can read. One row a
-- day answers the question the owner is actually asking — "was she in my record
-- yesterday" — and the counter inside it answers "how much".
--
-- The uniqueness is what makes the coalescing atomic rather than a read
-- followed by a hopeful write: the writer INSERTs and lets the index send it
-- into the ON CONFLICT arm, so two concurrent delegated reads cannot both
-- decide the day's row is missing.
--
-- The day is a bare cast because `created_at` on this table is TIMESTAMP
-- WITHOUT TIME ZONE holding UTC — the whole application writes it that way, so
-- `::date` is already the UTC day and needs no conversion. It also has to be
-- bare: an index expression must be IMMUTABLE, and any form that converts a
-- zone at read time (`AT TIME ZONE`, casting through timestamptz) is only
-- STABLE, because its answer depends on a session setting an operator can
-- change. Postgres refuses to index it, which is the right refusal: a day
-- boundary that moves with a container's TZ would split or merge days the
-- trail has already recorded.
--
-- Partial on the action so it constrains exactly the rows the writer emits and
-- nothing else: `auth.login` rows carry no actor, and two of them on one day
-- for one account are entirely ordinary.
CREATE UNIQUE INDEX "audit_logs_delegated_access_day_key"
    ON "audit_logs" ("user_id", "actor_user_id", (("created_at")::date))
    WHERE "action" = 'sharing.record.accessed';
