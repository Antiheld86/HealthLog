/**
 * scripts/rotate-encryption-key.ts <new-key-id>
 *
 * Re-encrypts every encrypted column in the database with the currently
 * active key (`ENCRYPTION_ACTIVE_KEY_ID`). Idempotent: rows whose ciphertext
 * already carries the active key id prefix are skipped.
 *
 * The set of columns this script rotates is the canonical registry in
 * `src/lib/crypto/encrypted-columns.ts`. The guard test
 * `src/lib/crypto/__tests__/encrypted-columns.test.ts` fails CI if any
 * encrypted column in `prisma/schema.prisma` is missing from the registry,
 * or if any registry column is not referenced here — so a new `*Encrypted`
 * column can never silently skip rotation (which would make those rows
 * permanently undecryptable once the legacy key is dropped, since decrypt is
 * fail-closed).
 *
 * Usage:
 *   ENCRYPTION_KEYS='{"v1":"<old>","v2":"<new>"}' \
 *   ENCRYPTION_ACTIVE_KEY_ID=v2 \
 *   pnpm tsx scripts/rotate-encryption-key.ts v2
 */
import "dotenv/config";
import { Buffer } from "node:buffer";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { decrypt, encrypt, extractKeyId, getActiveKeyId } from "@/lib/crypto";
import {
  rotateColumn,
  type CorpusClient,
} from "@/lib/crypto/encryption-corpus";
import { tokeniseAndHash } from "@/lib/documents/content-index";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}

const targetKeyId = process.argv[2] ?? getActiveKeyId();
if (targetKeyId !== getActiveKeyId()) {
  console.error(
    `Refusing to rotate: argv key id '${targetKeyId}' does not match the ` +
      `currently active id '${getActiveKeyId()}'. Set ENCRYPTION_ACTIVE_KEY_ID first.`,
  );
  process.exit(2);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: DATABASE_URL }),
});

interface RotationResult {
  table: string;
  field: string;
  scanned: number;
  rotated: number;
  errors: number;
}

function shouldRotate(value: string | null): boolean {
  if (!value) return false;
  const id = extractKeyId(value);
  // null = legacy/unversioned (rotate); else rotate if not already on active.
  return id !== getActiveKeyId();
}

/**
 * Rotate one `String` ciphertext column on a Prisma model. `delegate` is the
 * `prisma.<model>` accessor; `field` is the column. Reads only `id` + the
 * column, re-encrypts every row not already on the active key.
 */
async function rotateStringColumn(
  table: string,
  field: string,
  delegate: {
    findMany: (args: {
      select: Record<string, true>;
    }) => Promise<Array<Record<string, unknown>>>;
    update: (args: {
      where: { id: string };
      data: Record<string, string>;
    }) => Promise<unknown>;
  },
): Promise<RotationResult> {
  const rows = await delegate.findMany({ select: { id: true, [field]: true } });
  const result: RotationResult = {
    table,
    field,
    scanned: rows.length,
    rotated: 0,
    errors: 0,
  };
  for (const row of rows) {
    const v = row[field] as string | null;
    if (!shouldRotate(v)) continue;
    const id = row.id as string;
    try {
      const re = encrypt(decrypt(v as string));
      await delegate.update({ where: { id }, data: { [field]: re } });
      result.rotated++;
    } catch (err) {
      result.errors++;
      console.error(`[${table}.${field}] row ${id}: ${(err as Error).message}`);
    }
  }
  return result;
}

/**
 * Rotate one `Bytes` ciphertext column. The encrypt/decrypt helpers operate
 * on strings, so we go through a UTF-8 Buffer round-trip identical to the
 * persistence layer (`src/lib/ai/coach/persistence.ts:60-71`).
 */
async function rotateBytesColumn(
  table: string,
  field: string,
  delegate: {
    findMany: (args: {
      select: Record<string, true>;
    }) => Promise<Array<Record<string, unknown>>>;
    update: (args: {
      where: { id: string };
      data: Record<string, Uint8Array>;
    }) => Promise<unknown>;
  },
): Promise<RotationResult> {
  const rows = await delegate.findMany({ select: { id: true, [field]: true } });
  const result: RotationResult = {
    table,
    field,
    scanned: rows.length,
    rotated: 0,
    errors: 0,
  };
  for (const row of rows) {
    const buf = row[field] as Uint8Array | null;
    if (!buf || buf.byteLength === 0) continue;
    const asString = Buffer.from(buf).toString("utf8");
    if (!shouldRotate(asString)) continue;
    const id = row.id as string;
    try {
      const rotated = encrypt(decrypt(asString));
      const encoded = Buffer.from(rotated, "utf8");
      const next = new Uint8Array(new ArrayBuffer(encoded.byteLength));
      next.set(encoded);
      await delegate.update({ where: { id }, data: { [field]: next } });
      result.rotated++;
    } catch (err) {
      result.errors++;
      console.error(`[${table}.${field}] row ${id}: ${(err as Error).message}`);
    }
  }
  return result;
}

async function main() {
  console.log(`Rotating encrypted rows to active key id: ${targetKeyId}`);
  const results: RotationResult[] = [];

  // ───── User — integration credentials + AI keys + KVNR (String) ─────
  // Columns: "codexAccessTokenEncrypted" "codexRefreshTokenEncrypted"
  // "telegramBotToken" "withingsClientIdEncrypted"
  // "withingsClientSecretEncrypted" "whoopClientIdEncrypted"
  // "whoopClientSecretEncrypted" "fitbitClientIdEncrypted"
  // "fitbitClientSecretEncrypted" "nightscoutUrlEncrypted"
  // "nightscoutTokenEncrypted" "polarAccessTokenEncrypted"
  // "polarUserIdEncrypted" "polarClientIdEncrypted"
  // "polarClientSecretEncrypted" "ouraAccessTokenEncrypted"
  // "ouraRefreshTokenEncrypted" "ouraClientIdEncrypted"
  // "ouraClientSecretEncrypted" "stravaClientIdEncrypted"
  // "stravaClientSecretEncrypted" "stravaAccessTokenEncrypted"
  // "stravaRefreshTokenEncrypted" "aiAnthropicKeyEncrypted"
  // "aiLocalKeyEncrypted" "aiOpenaiKeyEncrypted" "insuranceNumberEncrypted"
  // v1.33.1 adds the gateway bearer; it is named in the array below only.
  // Quoting a column name in this comment would satisfy the coverage guard
  // in encrypted-columns.test.ts without the script rotating anything, so
  // the newest entry stays unquoted here on purpose.
  const userFields = [
    "codexAccessTokenEncrypted",
    "codexRefreshTokenEncrypted",
    "telegramBotToken",
    "withingsClientIdEncrypted",
    "withingsClientSecretEncrypted",
    "whoopClientIdEncrypted",
    "whoopClientSecretEncrypted",
    "fitbitClientIdEncrypted",
    "fitbitClientSecretEncrypted",
    "googleHealthClientIdEncrypted",
    "googleHealthClientSecretEncrypted",
    "nightscoutUrlEncrypted",
    "nightscoutTokenEncrypted",
    "polarAccessTokenEncrypted",
    "polarUserIdEncrypted",
    "polarClientIdEncrypted",
    "polarClientSecretEncrypted",
    "ouraAccessTokenEncrypted",
    "ouraRefreshTokenEncrypted",
    "ouraClientIdEncrypted",
    "ouraClientSecretEncrypted",
    "stravaClientIdEncrypted",
    "stravaClientSecretEncrypted",
    "stravaAccessTokenEncrypted",
    "stravaRefreshTokenEncrypted",
    "aiAnthropicKeyEncrypted",
    "aiLocalKeyEncrypted",
    "aiOpenaiKeyEncrypted",
    // v1.33.1 (#470) — the OpenAI-compatible gateway's optional bearer.
    "aiCompatKeyEncrypted",
    "insuranceNumberEncrypted",
    // v1.23 — TOTP shared secret (second factor).
    "totpSecretEncrypted",
  ];
  for (const field of userFields) {
    results.push(await rotateStringColumn("User", field, prisma.user));
  }

  // ───── OAuth token tables (String "accessToken" / "refreshToken") ─────
  for (const field of ["accessToken", "refreshToken"]) {
    results.push(
      await rotateStringColumn(
        "WithingsConnection",
        field,
        prisma.withingsConnection,
      ),
    );
    results.push(
      await rotateStringColumn(
        "WhoopConnection",
        field,
        prisma.whoopConnection,
      ),
    );
    results.push(
      await rotateStringColumn(
        "FitbitConnection",
        field,
        prisma.fitbitConnection,
      ),
    );
    results.push(
      await rotateStringColumn(
        "GoogleHealthConnection",
        field,
        prisma.googleHealthConnection,
      ),
    );
  }

  // ───── AppSettings — operator credentials (String) ─────
  // Columns: "adminAiKeyEncrypted" "webPushVapidPrivateKeyEncrypted"
  // "adminCodexAccessTokenEncrypted" "adminCodexRefreshTokenEncrypted"
  // "adminCodexAccountIdEncrypted"
  for (const field of [
    "adminAiKeyEncrypted",
    "webPushVapidPrivateKeyEncrypted",
    "adminCodexAccessTokenEncrypted",
    "adminCodexRefreshTokenEncrypted",
    "adminCodexAccountIdEncrypted",
  ]) {
    results.push(
      await rotateStringColumn("AppSettings", field, prisma.appSettings),
    );
  }

  // ───── Custom labels — mood + cycle (String "labelEncrypted") ─────
  // Catalogue rows carry NULL and are skipped by `shouldRotate`.
  results.push(
    await rotateStringColumn("MoodTag", "labelEncrypted", prisma.moodTag),
  );
  results.push(
    await rotateStringColumn(
      "MoodTagCategory",
      "labelEncrypted",
      prisma.moodTagCategory,
    ),
  );
  results.push(
    await rotateStringColumn(
      "CycleSymptom",
      "labelEncrypted",
      prisma.cycleSymptom,
    ),
  );

  // ───── NotificationChannel."config" (encrypted JSON) ─────
  // Channel config (Telegram chat id, ntfy topic, etc.). Skipping these on
  // rotation would leave channels permanently undecryptable once the
  // operator drops `v1` from the key map.
  results.push(
    await rotateStringColumn(
      "NotificationChannel",
      "config",
      prisma.notificationChannel,
    ),
  );

  // ───── PushSubscription."p256dh" / "auth" ─────
  // Web-push routing secrets — without these, the push endpoint is reachable
  // but the browser ignores the message (auth tag mismatch).
  for (const field of ["p256dh", "auth"]) {
    results.push(
      await rotateStringColumn(
        "PushSubscription",
        field,
        prisma.pushSubscription,
      ),
    );
  }

  // ───── IntegrationStatus."lastError" ─────
  // AES-256-GCM ciphertext of an upstream error payload. Drop the legacy key
  // while a row still lives here and the admin status view 500s.
  results.push(
    await rotateStringColumn(
      "IntegrationStatus",
      "lastError",
      prisma.integrationStatus,
    ),
  );

  // ───── CycleDayLog — "sensitiveEncrypted" / "notesEncrypted" (String) ─────
  for (const field of ["sensitiveEncrypted", "notesEncrypted"]) {
    results.push(
      await rotateStringColumn("CycleDayLog", field, prisma.cycleDayLog),
    );
  }

  // ───── Coach (Bytes columns) ─────
  // "encryptedContent" "summaryEncrypted" "factEncrypted"
  results.push(
    await rotateBytesColumn(
      "CoachMessage",
      "encryptedContent",
      prisma.coachMessage,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "CoachConversation",
      "summaryEncrypted",
      prisma.coachConversation,
    ),
  );
  results.push(
    await rotateBytesColumn("CoachFact", "factEncrypted", prisma.coachFact),
  );

  // ───── CoachPlan (Bytes columns) ─────
  // "ifCueEncrypted" "thenActionEncrypted" "targetEncrypted" "outcomeEncrypted"
  for (const field of [
    "ifCueEncrypted",
    "thenActionEncrypted",
    "targetEncrypted",
    "outcomeEncrypted",
  ]) {
    results.push(await rotateBytesColumn("CoachPlan", field, prisma.coachPlan));
  }

  // ───── CoachReminder (Bytes column) ─────
  // "noteEncrypted"
  results.push(
    await rotateBytesColumn(
      "CoachReminder",
      "noteEncrypted",
      prisma.coachReminder,
    ),
  );

  // ───── UserHealthProfile (Bytes columns) ─────
  // "aboutMeEncrypted" "conditionsEncrypted" "allergiesEncrypted"
  // "coachFocusEncrypted" "pendingQuestionsEncrypted"
  // "emergencyContactsEncrypted" "emergencyImplantsEncrypted"
  // "emergencyNoteEncrypted"
  for (const field of [
    "aboutMeEncrypted",
    "conditionsEncrypted",
    "allergiesEncrypted",
    "coachFocusEncrypted",
    "pendingQuestionsEncrypted",
    "emergencyContactsEncrypted",
    "emergencyImplantsEncrypted",
    "emergencyNoteEncrypted",
  ]) {
    results.push(
      await rotateBytesColumn(
        "UserHealthProfile",
        field,
        prisma.userHealthProfile,
      ),
    );
  }

  // ───── HealthProfileFactRevision."valueEncrypted" (Bytes) ─────
  results.push(
    await rotateBytesColumn(
      "HealthProfileFactRevision",
      "valueEncrypted",
      prisma.healthProfileFactRevision,
    ),
  );

  // ───── InsightNarrative."encryptedContent" (Bytes) ─────
  results.push(
    await rotateBytesColumn(
      "InsightNarrative",
      "encryptedContent",
      prisma.insightNarrative,
    ),
  );

  // ───── v1.31.0 ArrivalReaction."lineEncrypted" (Bytes, nullable) ─────
  // The data-arrival spine's generated reaction line. Nullable by design — a
  // provider-less install writes markers with no line at all — and
  // `rotateBytesColumn` already skips a NULL / zero-length payload, so those
  // rows are scanned and cleanly left alone.
  results.push(
    await rotateBytesColumn(
      "ArrivalReaction",
      "lineEncrypted",
      prisma.arrivalReaction,
    ),
  );

  // ───── v1.31.0 WorkoutInsight."paragraphEncrypted" (Bytes) ─────
  // The per-workout Activity Insight paragraph. Not nullable — a row exists
  // only where a paragraph was generated — so every scanned row rotates.
  results.push(
    await rotateBytesColumn(
      "WorkoutInsight",
      "paragraphEncrypted",
      prisma.workoutInsight,
    ),
  );

  // ───── v1.18.1 clinical-spine notes (Bytes columns) ─────
  // "noteEncrypted" (LabResult / IllnessEpisode / IllnessDayLog) +
  // "contextEncrypted" (Biomarker). Mirror the CoachFact.factEncrypted block.
  results.push(
    await rotateBytesColumn("LabResult", "noteEncrypted", prisma.labResult),
  );
  results.push(
    await rotateBytesColumn("Biomarker", "contextEncrypted", prisma.biomarker),
  );
  results.push(
    await rotateBytesColumn(
      "IllnessEpisode",
      "noteEncrypted",
      prisma.illnessEpisode,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "IllnessDayLog",
      "noteEncrypted",
      prisma.illnessDayLog,
    ),
  );

  // ───── v1.19.0 ECG waveform (Bytes column) ─────
  // "waveformEncrypted" holds the JSON-encoded micro-volt sample array in the
  // same `encrypt()` ciphertext-string-as-UTF-8 shape the Coach columns use
  // (see src/lib/withings/ecg-waveform-codec.ts), so the generic Bytes
  // rotation re-stamps it without decoding the waveform.
  results.push(
    await rotateBytesColumn(
      "EcgRecording",
      "waveformEncrypted",
      prisma.ecgRecording,
    ),
  );

  // ───── v1.23 free-text health notes (Bytes columns) ─────
  // "noteEncrypted" (MoodEntry) + "notesEncrypted" (Measurement). Same shared-
  // codec shape as the clinical-spine note columns. NULL on rows whose note is
  // still in the legacy plaintext column (pre-backfill) — `rotateBytesColumn`
  // skips those.
  results.push(
    await rotateBytesColumn("MoodEntry", "noteEncrypted", prisma.moodEntry),
  );
  results.push(
    await rotateBytesColumn(
      "Measurement",
      "notesEncrypted",
      prisma.measurement,
    ),
  );
  // v1.38 — the day-context note on a mood entry. Its own table, so its own
  // walk; a context row exists only where somebody added one, and a row with
  // no note carries NULL here and is skipped like every other nullable Bytes
  // column.
  results.push(
    await rotateBytesColumn(
      "MoodContext",
      "notesEncrypted",
      prisma.moodContext,
    ),
  );

  // ───── v1.25 medication free-text notes (Bytes columns) ─────
  // "notesEncrypted" (MedicationSideEffect + MedicationInventoryItem) +
  // "noteEncrypted" (MedicationDoseChange). Same shared-codec shape as the
  // other free-text note columns. NULL on rows whose note is still in the
  // legacy plaintext column (pre-backfill) — `rotateBytesColumn` skips those.
  results.push(
    await rotateBytesColumn(
      "MedicationSideEffect",
      "notesEncrypted",
      prisma.medicationSideEffect,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "MedicationDoseChange",
      "noteEncrypted",
      prisma.medicationDoseChange,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "MedicationInventoryItem",
      "notesEncrypted",
      prisma.medicationInventoryItem,
    ),
  );

  // ───── v1.25 mental-health screener item answers (Bytes column) ─────
  // The PHQ-9 / GAD-7 encrypted per-item blob. Always present (NOT NULL), so
  // every row rotates.
  results.push(
    await rotateBytesColumn(
      "MentalHealthAssessment",
      "responsesEncrypted",
      prisma.mentalHealthAssessment,
    ),
  );
  // ───── v1.25 structured health records (Bytes columns) ─────
  // Allergy free-text reaction + note; family-history note. Always encrypted
  // on write (no legacy plaintext column), so every non-null row rotates.
  results.push(
    await rotateBytesColumn("Allergy", "reactionEncrypted", prisma.allergy),
  );
  results.push(
    await rotateBytesColumn("Allergy", "notesEncrypted", prisma.allergy),
  );
  results.push(
    await rotateBytesColumn(
      "FamilyHistoryEntry",
      "notesEncrypted",
      prisma.familyHistoryEntry,
    ),
  );

  // ───── v1.38.0 visit free text (Bytes columns) ─────
  // Why the person went, what came out of it, and the practice note. Always
  // encrypted on write, so every non-null row rotates.
  results.push(
    await rotateBytesColumn("Encounter", "reasonEncrypted", prisma.encounter),
  );
  results.push(
    await rotateBytesColumn("Encounter", "outcomeEncrypted", prisma.encounter),
  );
  results.push(
    await rotateBytesColumn(
      "Practitioner",
      "noteEncrypted",
      prisma.practitioner,
    ),
  );

  // ───── v1.38.0 dose free text (Bytes column) ─────
  // The note on an administered dose — a reaction, a sore arm. Always
  // encrypted on write, so every non-null row rotates.
  results.push(
    await rotateBytesColumn(
      "VaccinationRecord",
      "noteEncrypted",
      prisma.vaccinationRecord,
    ),
  );

  // ───── Inbound clinical document (Bytes column, codec-dispatched) ─────
  // The raw uploaded document. Two layouts recorded per row in
  // `contentCodec` ("base64v1" string codec | "binary2" binary codec), so
  // rotation goes through the shared codec-aware corpus walk: bounded
  // id-cursor batches (rows are up to cap-sized blobs — never an unbounded
  // findMany) re-encrypted under each row's OWN codec. Idempotent, so an
  // interrupted run resumes on re-invocation.
  {
    const docResult = await rotateColumn(
      { inboundDocument: prisma.inboundDocument } as unknown as CorpusClient,
      {
        model: "InboundDocument",
        field: "contentEncrypted",
        kind: "bytes",
        codecField: "contentCodec",
      },
    );
    results.push({
      table: docResult.model,
      field: docResult.field,
      scanned: docResult.scanned,
      rotated: docResult.rotated,
      errors: docResult.errors,
    });
  }
  // The staged extracted-fact payloads: the FHIR-staged clinical values and the
  // verbatim source-span provenance. Both NOT NULL, so every staged row rotates.
  results.push(
    await rotateBytesColumn(
      "ExtractedFact",
      "dataEncrypted",
      prisma.extractedFact,
    ),
  );
  results.push(
    await rotateBytesColumn(
      "ExtractedFact",
      "provenanceEncrypted",
      prisma.extractedFact,
    ),
  );
  // The short background document summary. Small `encrypt()`-string-as-UTF-8
  // Bytes payload (never the multi-megabyte original blob — the select is
  // scoped to id + this column), so the generic Bytes walk covers it. NULL on
  // rows uploaded with auto-read OFF / no provider — `rotateBytesColumn` skips
  // those.
  results.push(
    await rotateBytesColumn(
      "InboundDocument",
      "summaryEncrypted",
      prisma.inboundDocument,
    ),
  );

  // ───── v1.27.22 document content-search index (Bytes text + re-tokenise) ─────
  // The blind content index carries TWO coupled artefacts under the index key
  // story: `text_encrypted` (the `encrypt()`-string-as-UTF-8 Bytes shape) AND
  // `search_tokens` (HMAC-SHA256 under an HKDF subkey derived from the ACTIVE
  // key). Rotating the master key changes that subkey, so a plain Bytes rotation
  // of the text alone would leave the tokens hashed under the OLD subkey and
  // search would silently miss the row. This dedicated block re-encrypts the
  // text AND re-tokenises from the decrypted plaintext under the NEW subkey in
  // the same update (P2-D7). Bounded id-cursor batches — the text is capped but
  // still a blob, so an unbounded findMany is avoided. Idempotent: rows already
  // on the active key are skipped, so an interrupted run resumes safely.
  {
    const result: RotationResult = {
      table: "DocumentContentIndex",
      field: "textEncrypted",
      scanned: 0,
      rotated: 0,
      errors: 0,
    };
    let cursor: string | null = null;
    // v1.27.33 (Document vault P4) — re-encrypt the string-shaped BYTEA into a
    // fresh Uint8Array under the active key. Shared by `textEncrypted` and the
    // nullable sibling `verbatimTextEncrypted` (same codec).
    const reEncryptBytes = (asString: string): Uint8Array => {
      const reEnc = encrypt(decrypt(asString));
      const encoded = Buffer.from(reEnc, "utf8");
      const nextBytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
      nextBytes.set(encoded);
      return nextBytes;
    };
    for (;;) {
      const rows = await prisma.documentContentIndex.findMany({
        select: { id: true, textEncrypted: true, verbatimTextEncrypted: true },
        orderBy: { id: "asc" },
        take: 100,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        result.scanned++;
        const buf = row.textEncrypted as Uint8Array | null;
        if (!buf || buf.byteLength === 0) continue;
        const asString = Buffer.from(buf).toString("utf8");
        if (!shouldRotate(asString)) continue;
        try {
          const plaintext = decrypt(asString);
          const nextBytes = reEncryptBytes(asString);
          const searchTokens = tokeniseAndHash(plaintext);
          // The "verbatimTextEncrypted" column (nullable; written together with
          // "textEncrypted" so it shares the same key) rotates in the same
          // update when present.
          const verbatimBuf = row.verbatimTextEncrypted as Uint8Array | null;
          const verbatimNext =
            verbatimBuf && verbatimBuf.byteLength > 0
              ? reEncryptBytes(Buffer.from(verbatimBuf).toString("utf8"))
              : undefined;
          await prisma.documentContentIndex.update({
            where: { id: row.id },
            data: {
              textEncrypted: nextBytes,
              searchTokens,
              ...(verbatimNext ? { verbatimTextEncrypted: verbatimNext } : {}),
            },
          });
          result.rotated++;
        } catch (err) {
          result.errors++;
          console.error(
            `[DocumentContentIndex.textEncrypted] row ${row.id}: ${(err as Error).message}`,
          );
        }
      }
      cursor = rows[rows.length - 1]!.id;
      if (rows.length < 100) break;
    }
    results.push(result);
  }

  // ───── Document preview thumbnails (Bytes column) ─────
  // The small JPEG preview, stored as the `encrypt()`-string-as-UTF-8 Bytes
  // shape (base64 of the JPEG) — the same codec as the content index — so the
  // shared Bytes walk re-encrypts it under the active key. NOT NULL, so every
  // thumbnail row rotates.
  results.push(
    await rotateBytesColumn(
      "DocumentThumbnail",
      "thumbnailEncrypted",
      prisma.documentThumbnail,
    ),
  );

  console.log("\n=== Rotation summary ===");
  let totalRotated = 0;
  let totalErrors = 0;
  for (const r of results) {
    console.log(
      `${r.table}.${r.field}: scanned=${r.scanned} rotated=${r.rotated} errors=${r.errors}`,
    );
    totalRotated += r.rotated;
    totalErrors += r.errors;
  }
  console.log(`\nTOTAL rotated=${totalRotated} errors=${totalErrors}`);
  await prisma.$disconnect();
  process.exit(totalErrors > 0 ? 3 : 0);
}

main().catch(async (err) => {
  console.error("Rotation failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
