# Off-host backup & restore

HealthLog ships with an optional daily off-host backup that ships every
user's JSON dump, encrypted with AES-256-GCM under a SEPARATE key
(`BACKUP_ENCRYPTION_KEY`), to any S3-compatible bucket — Cloudflare R2,
AWS S3, Backblaze B2, MinIO, etc.

The backup runs at **02:30 Europe/Berlin** every day from the worker
container (queue `data-backup-offhost`). Object key layout:

```
<bucket>/YYYY-MM-DD/user-<userId>.json.enc
```

## Wire format (binary)

```
magic   = "HLBK"           (4 bytes, ASCII)
version = 0x01             (1 byte)
iv      = 12 random bytes  (AES-GCM nonce)
authTag = 16 bytes         (AES-GCM tag)
ciphertext = N bytes       (AES-256-GCM, key = BACKUP_ENCRYPTION_KEY)
plaintext  = JSON dump (UTF-8)
```

## Required env vars

| Var                     | Required | Notes                                                                |
| ----------------------- | -------- | -------------------------------------------------------------------- |
| `BACKUP_ENCRYPTION_KEY` | yes      | 64 hex chars or 32-byte base64. **Different from `ENCRYPTION_KEY`.** |
| `BACKUP_S3_ENDPOINT`    | yes      | e.g. `https://<account>.r2.cloudflarestorage.com`                    |
| `BACKUP_S3_BUCKET`      | yes      |                                                                      |
| `BACKUP_S3_ACCESS_KEY`  | yes      |                                                                      |
| `BACKUP_S3_SECRET_KEY`  | yes      |                                                                      |
| `BACKUP_S3_REGION`      | no       | defaults to `auto` (Cloudflare R2)                                   |
| `BACKUP_RETENTION_DAYS` | no       | defaults to `30`                                                     |

## Bucket lifecycle (recommended)

The worker prunes objects older than `BACKUP_RETENTION_DAYS`, but the
storage provider's lifecycle rule is the canonical safety net:

```
Filter: "" (all objects)
Action: Expire after 30 days
```

For Cloudflare R2 add this from the bucket's **Settings → Lifecycle**.

## Smoke test

After deploying, hit `POST /api/admin/backup/test` (admin-only). It
performs a 1-byte PUT + GET round-trip and returns:

```json
{
  "data": {
    "endpoint": "https://...r2.cloudflarestorage.com",
    "bucket": "healthlog-backups",
    "region": "auto",
    "putLatencyMs": 142,
    "getLatencyMs": 38,
    "ok": true
  },
  "error": null
}
```

The credentials are never returned.

## Restore

Pick a key (e.g. `2026-05-08/user-clx123.json.enc`) from the bucket
and run the restore script with the same backup credentials and
encryption key the backup was written under — a freshly generated
`BACKUP_ENCRYPTION_KEY` cannot decrypt any existing object:

```bash
BACKUP_S3_ENDPOINT=https://...r2.cloudflarestorage.com       \
BACKUP_S3_BUCKET=healthlog-backups                           \
BACKUP_S3_ACCESS_KEY=...                                     \
BACKUP_S3_SECRET_KEY=...                                     \
BACKUP_S3_REGION=auto                                        \
BACKUP_ENCRYPTION_KEY=<the key the backup was written under> \
pnpm dlx tsx scripts/restore-backup.ts \
  2026-05-08/user-clx123.json.enc \
  /tmp/restored.json
```

Run this command from a source checkout with the production backup variables
exported. The script imports the full application dependency graph, which the
minimal production image does not expose as an operator scripting environment.

The script downloads the object, decrypts it, and writes the JSON dump
to disk. Importing the JSON back into a HealthLog instance is left to
the operator (use `prisma db seed` or a custom script).

### What a backup deliberately does not carry

Every credential-shaped row is left out, and this is not an oversight to fix:
API tokens, trusted devices, step-up elevations, known devices, clinician share
links, and the account grants behind shared record access. Restoring data is
rolling a record back to a known state. Restoring an authorization is different
in kind, because a grant the owner revoked on Tuesday would come back alive out
of Monday's file with nobody deciding it and neither person told.

What this means in practice depends on where you restore to.

**Onto the same instance.** Nothing changes. The restore replaces the account's
data tables and does not touch grants, tokens or devices, so shared access
carries on exactly as it was. Somebody who had read access before the restore
still has it afterwards, now looking at the restored data.

**Onto a fresh instance.** None of it comes with the file. Nobody has access to
anybody's record, every API token has to be reissued, every device re-trusted,
and both people have to invite and accept again before sharing works. That is
the fail-safe direction — access lost, never access resumed — and re-consenting
is the right amount of ceremony for handing someone your health record a second
time. Plan for it rather than discovering it.

The full per-model reasoning lives in `src/lib/export/backup-plan.ts`, where
every excluded model carries a written verdict and a structural test refuses to
let a new model land without one.

## The weekly in-database backup (`data-backup`)

Separate from the off-host job above, and easy to confuse with it. A second
pg-boss job writes one `WEEKLY_AUTO` row per user into `data_backups.data` —
the same JSON document, gzipped and then encrypted under `ENCRYPTION_KEY` /
`ENCRYPTION_KEYS`, staying inside the instance. It is what
`/api/admin/backups/<id>/restore` reads.

### Container memory

This is the part that bites. The job runs inside the app process, so V8's heap
limit is the app's heap limit, and a container capped at 1 GB gives Node a
524 MB old-space limit by default. A long-lived record is bigger than it looks:
several hundred thousand measurements serialise to a JSON document of a few
hundred megabytes, and the writer used to need the object graph and that
document resident at the same time. On a seeded account of 445 000 measurements
under a 546 MB limit that is `FATAL ERROR: Reached heap limit` about thirty
seconds in — and since the job shares the process, the whole instance restarted
and every signed-in session on it went with it.

Two things changed, and both matter to an operator:

- **The writer streams.** The three tables that grow without bound —
  measurements, intake events, mood entries — are read a page at a time and
  serialised straight into gzip and the cipher, and every other section is
  released as soon as its JSON exists. On the same fixture doubled to 890 000
  measurements, the pass completes inside a 296 MB heap limit; before the
  change, half that record did not fit in 546 MB.
- **It stops itself.** The writer watches its own live heap and aborts at 80 %
  of V8's limit. That backup then fails for that one account, is counted in the
  run's `users_failed` and `heap_budget_trips` meta, and the pass carries on
  with everybody else. A memory failure is now a failed job rather than a
  restart for every user on the host.

If `heap_budget_trips` is non-zero in `job.data_backup`, the answer is more
memory, not a retry: raise the container's limit, or set
`NODE_OPTIONS=--max-old-space-size=<MB>` to something under it.

### The stored column is the remaining ceiling

`data_backups.data` is a single `text` column, so the finished artifact has to
exist as one value before it can be written — that copy cannot be streamed
away. It is the only thing left in the job that grows with the record: at a
compressed blob of ~42 MB the pass peaks around 236 MB, and the growth from
there is roughly twice the blob's size (the base64 answer, plus the driver's
copy of it on the way to the wire). A blob past roughly 150 MB — an account
several times larger than any seen so far — will hit a 524 MB limit again, and
the fix at that point is to stop storing the artifact in one column: chunk it
across rows, or keep only the off-host copy. Reading it back has the same
shape, and worse: a restore parses the whole document, so the read path needs
several times the blob in heap. An operator restoring a very large account
should give the container more memory for the duration.

## Monthly restore drill (automatic)

Since v1.16.4 a pg-boss job (`data-restore-drill`, cron `11 4 1 * *` —
04:11 on the 1st of each month) exercises the read path end-to-end:
fetch the most recent backup object from the bucket, decrypt it under
the current `BACKUP_ENCRYPTION_KEY`, JSON-parse it, and sanity-check
the payload shape. It performs **no database restore** — it validates
the artefact, not the import path.

Outcomes:

- **Success** — record counts, object age, and sizes land in the
  wide-event meta (`job.restore_drill`).
- **Stale chain** — the newest object is older than 3 days: the nightly
  uploader has stalled (or the lifecycle rule is too aggressive). The
  drill pages via the worker error reporter (stderr + GlitchTip).
- **Failure** — empty bucket, fetch error, decryption failure (wrong or
  rotated key), malformed JSON: pages the same way. A decryption
  failure right after a `BACKUP_ENCRYPTION_KEY` change means the new
  key cannot read the existing objects — re-encrypt or accept that
  pre-rotation backups are only readable with the retired key.
- **Not configured** — deployments without the `BACKUP_S3_*` vars skip
  silently (wide-event warning only).

The drill needs no IAM grant beyond the uploader's existing
`GetObject` + `ListBucket`.
