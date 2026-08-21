/**
 * The Coach's conversations, with both backup ends in one file.
 *
 * Same arrangement as `reminders-backup.ts`, `visits-backup.ts` and
 * `vaccinations-backup.ts`, for the same reason: a reader asking "is this
 * carried at both ends?" answers it here, and a reader who greps only the
 * restore ROUTE gets a false negative because the route delegates.
 *
 * Three models ride: the conversation, its messages, and the join naming which
 * vault documents a conversation was grounded in. All three sat on the
 * coverage-pending register, where the entry for the messages read "the largest
 * volume of free text an account owns after its documents". A restore without
 * this section hands back an account whose Coach has never spoken to it.
 *
 * ## Three things this file is careful about
 *
 * **The fence flag is the important field.** `documentScoped` is a PERMANENT
 * marker: it goes true when a conversation is created through the fenced
 * endpoint or gets its first document, and no code path anywhere sets it back
 * to false — not detaching every document, not deleting the document. A
 * conversation whose history may contain document-derived text must never
 * regain the tool loop. So it is carried verbatim and restored verbatim. A
 * restore that let it default to false would hand the tool loop back to exactly
 * the conversations the fence exists to keep away from it, and nothing in the
 * interface would look wrong afterwards. It is the one field here where losing
 * the value is a security regression rather than lost history.
 *
 * **Ids are carried in both modes**, as the reminders are, and for the same
 * kind of reason: a message addresses its conversation, an attachment addresses
 * both a conversation and a document, and the Coach's facts, plans and
 * reminders carry a `sourceConversationId` that has to land somewhere real.
 *
 * **The prose follows the contract every other encrypted column here uses.** A
 * disaster-recovery payload carries the stored ciphertext verbatim as base64,
 * because the same instance's key reads it back unchanged. A portable export
 * decrypts it, because a portable export exists to be readable by the person
 * who owns it, exactly as it already decrypts medication notes, mood notes and
 * document summaries. There is no third mode where a person's own words are
 * withheld from their own export.
 *
 * ## The one reference that needs care
 *
 * `CoachConversationDocument.documentId` addresses a vault document, which is
 * restored by the route BEFORE this section runs. A DR payload carries every
 * document, so the reference always resolves. A portable payload never reaches
 * a restore at all while the account has documents — the route refuses it
 * ahead of the wipe, because document ciphertext is not in the file — so an
 * attachment cannot survive into a restore whose document is missing. That
 * leaves the hand-edited or truncated file, and there the row is dropped and
 * REPORTED rather than invented, the same answer the ledger gives for a
 * reminder it cannot find.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

import { decryptFromBytes, encryptToBytes } from "@/lib/ai/coach/bytes-codec";
import {
  recordUnknownKeys,
  type RestoreSkipLog,
} from "@/lib/export/restore-skips";

export interface CoachBackupOptions {
  purpose?: "portable-export" | "disaster-recovery";
}

/**
 * One turn. `role` is the app-side pair "user" | "assistant", stored as a
 * plain string rather than an enum, so it travels as written.
 */
export interface CoachMessageBackupEntry {
  id: string;
  role: string;
  /** Ciphertext as base64. Present on a disaster-recovery payload only. */
  contentEncrypted?: string;
  /** Plaintext. Present on a portable payload only. */
  content?: string;
  metricSourceJson: string | null;
  providerType: string | null;
  promptVersion: string | null;
  tokensUsed: number | null;
  model: string | null;
  createdAt: string;
}

/** Which vault document a conversation was grounded in. */
export interface CoachConversationDocumentBackupEntry {
  documentId: string;
  addedAt: string;
}

export interface CoachConversationBackupEntry {
  /** Always carried: messages, attachments and the Coach's own facts, plans
   *  and reminders all address a conversation by it. */
  id: string;
  title: string;
  /**
   * The permanent fence marker. Carried and restored verbatim; see the file
   * header for why letting this default is a security regression and not a
   * cosmetic one.
   */
  documentScoped: boolean;
  /** Rolling summary of elided older turns. Same codec as a message. */
  summaryEncrypted?: string | null;
  summary?: string | null;
  summaryUpdatedAt: string | null;
  summaryTurnCount: number;
  createdAt: string;
  updatedAt: string;
  messages: CoachMessageBackupEntry[];
  attachments: CoachConversationDocumentBackupEntry[];
}

export interface CoachBackupSection {
  coachConversations: CoachConversationBackupEntry[];
}

export interface CoachBackupCounts {
  coachConversations: number;
  coachMessages: number;
  coachConversationDocuments: number;
}

/**
 * Every restorable `CoachConversation` scalar plus its two child relations.
 *
 * Named rather than inlined so a structural test can read the field list, and
 * so a column added to the model shows up as a diff here rather than as a
 * silent omission from the file.
 */
const COACH_CONVERSATION_BACKUP_SELECT = {
  id: true,
  title: true,
  documentScoped: true,
  summaryEncrypted: true,
  summaryUpdatedAt: true,
  summaryTurnCount: true,
  createdAt: true,
  updatedAt: true,
  messages: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      encryptedContent: true,
      metricSourceJson: true,
      providerType: true,
      promptVersion: true,
      tokensUsed: true,
      model: true,
      createdAt: true,
    },
  },
  attachments: {
    orderBy: { addedAt: "asc" },
    select: { documentId: true, addedAt: true },
  },
} satisfies Prisma.CoachConversationSelect;

/**
 * Decrypt for a reader, or say plainly that this one turn could not be read.
 *
 * A single row encrypted under a key the instance has since dropped must not
 * take the export down with it: the rest of the transcript is still the
 * person's, and a thrown error would cost them all of it. The placeholder is
 * deliberately a sentence rather than an empty string, because an empty string
 * reads as "they said nothing here" and that is not what happened.
 */
function decryptTurnSoft(bytes: Uint8Array | null): string | null {
  if (!bytes) return null;
  try {
    return decryptFromBytes(bytes);
  } catch {
    return "[unreadable: encrypted with a key this instance no longer holds]";
  }
}

export async function buildCoachBackupSection(
  prisma: Pick<PrismaClient, "coachConversation">,
  userId: string,
  options: CoachBackupOptions = {},
): Promise<CoachBackupSection> {
  const disasterRecovery = options.purpose === "disaster-recovery";

  const rows = await prisma.coachConversation.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: COACH_CONVERSATION_BACKUP_SELECT,
  });

  return {
    coachConversations: rows.map((row) => ({
      id: row.id,
      title: row.title,
      documentScoped: row.documentScoped,
      ...(disasterRecovery
        ? {
            summaryEncrypted: row.summaryEncrypted
              ? Buffer.from(row.summaryEncrypted).toString("base64")
              : null,
          }
        : { summary: decryptTurnSoft(row.summaryEncrypted) }),
      summaryUpdatedAt: row.summaryUpdatedAt?.toISOString() ?? null,
      summaryTurnCount: row.summaryTurnCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      messages: row.messages.map((message) => ({
        id: message.id,
        role: message.role,
        ...(disasterRecovery
          ? {
              contentEncrypted: Buffer.from(message.encryptedContent).toString(
                "base64",
              ),
            }
          : { content: decryptTurnSoft(message.encryptedContent) ?? "" }),
        metricSourceJson: message.metricSourceJson,
        providerType: message.providerType,
        promptVersion: message.promptVersion,
        tokensUsed: message.tokensUsed,
        model: message.model,
        createdAt: message.createdAt.toISOString(),
      })),
      attachments: row.attachments.map((attachment) => ({
        documentId: attachment.documentId,
        addedAt: attachment.addedAt.toISOString(),
      })),
    })),
  };
}

/** Row counts for the audit trail, mirroring the other section counters. */
export function countCoachBackupSection(
  section: CoachBackupSection,
): CoachBackupCounts {
  return {
    coachConversations: section.coachConversations.length,
    coachMessages: section.coachConversations.reduce(
      (total, conversation) => total + conversation.messages.length,
      0,
    ),
    coachConversationDocuments: section.coachConversations.reduce(
      (total, conversation) => total + conversation.attachments.length,
      0,
    ),
  };
}

/** Counts the Coach restore wiped, for the audit trail. */
export interface CoachRestoreCleared {
  coachConversations: number;
  coachMessages: number;
  coachConversationDocuments: number;
}

/**
 * The slice of a parsed backup this restore consumes.
 *
 * Required rather than optional: the payload schema defaults the key, so every
 * caller already satisfies this, and one that stops satisfying it fails to
 * compile instead of quietly restoring nothing.
 */
export interface CoachRestoreInput {
  coachConversations: RestoredCoachConversation[];
}

/**
 * What the parser hands over, which is looser than what the builder writes.
 *
 * The wire schema defaults or leaves optional every field an older file might
 * not carry, so the restore reads that shape rather than the builder's. The
 * one field kept strictly required is `documentScoped`: a file that does not
 * state the fence must not be silently re-fenced to the permissive value, and
 * making it optional here would let exactly that compile.
 */
type OptionalNullable<T> = { [K in keyof T]?: T[K] | undefined };

export type RestoredCoachMessage = Pick<
  CoachMessageBackupEntry,
  "id" | "role" | "createdAt"
> &
  OptionalNullable<
    Pick<
      CoachMessageBackupEntry,
      | "contentEncrypted"
      | "content"
      | "metricSourceJson"
      | "providerType"
      | "promptVersion"
      | "tokensUsed"
      | "model"
    >
  >;

export type RestoredCoachConversation = Pick<
  CoachConversationBackupEntry,
  "id" | "title" | "documentScoped" | "createdAt" | "updatedAt"
> &
  OptionalNullable<
    Pick<
      CoachConversationBackupEntry,
      "summaryEncrypted" | "summary" | "summaryUpdatedAt" | "summaryTurnCount"
    >
  > & {
    messages: RestoredCoachMessage[];
    attachments: CoachConversationDocumentBackupEntry[];
  };

/**
 * Re-create the account's Coach conversations, turns and document links.
 *
 * Delete-then-recreate inside the caller's transaction, matching every other
 * section. Messages and attachments cascade from the conversation, so deleting
 * the conversations is enough to empty them — they are counted first anyway, so
 * the cleared numbers are truthful rather than "whatever the cascade took".
 *
 * MUST be called AFTER the vault documents are restored: an attachment carries
 * a `documentId` that is a foreign key against them, and running earlier would
 * make every attachment unresolvable.
 *
 * `documentIds` is the set of documents the restore actually put back, passed
 * in rather than re-queried so this stays a pure function of the transaction it
 * was handed. An attachment naming anything outside it is dropped and reported.
 */
export async function restoreCoachData(
  tx: Prisma.TransactionClient,
  ownerId: string,
  payload: CoachRestoreInput,
  documentIds: ReadonlySet<string>,
  skips: RestoreSkipLog,
): Promise<CoachRestoreCleared> {
  const [clearedMessages, clearedAttachments] = await Promise.all([
    tx.coachMessage.count({ where: { conversation: { userId: ownerId } } }),
    tx.coachConversationDocument.count({
      where: { conversation: { userId: ownerId } },
    }),
  ]);
  const clearedConversations = await tx.coachConversation.deleteMany({
    where: { userId: ownerId },
  });

  for (const conversation of payload.coachConversations) {
    await tx.coachConversation.create({
      data: {
        id: conversation.id,
        userId: ownerId,
        title: conversation.title,
        // Verbatim. See the file header: this is the one field whose loss is a
        // security regression rather than a gap in the history.
        documentScoped: conversation.documentScoped,
        summaryEncrypted: resolveSummaryBytes(conversation),
        summaryUpdatedAt: conversation.summaryUpdatedAt
          ? new Date(conversation.summaryUpdatedAt)
          : null,
        summaryTurnCount: conversation.summaryTurnCount ?? 0,
        createdAt: new Date(conversation.createdAt),
        updatedAt: new Date(conversation.updatedAt),
        messages: {
          create: conversation.messages.map((message) => ({
            id: message.id,
            role: message.role,
            encryptedContent: resolveTurnBytes(message),
            metricSourceJson: message.metricSourceJson ?? null,
            providerType: message.providerType ?? null,
            promptVersion: message.promptVersion ?? null,
            tokensUsed: message.tokensUsed ?? null,
            model: message.model ?? null,
            createdAt: new Date(message.createdAt),
          })),
        },
      },
    });
  }

  // The attachments go in a second pass so a dropped document reference costs
  // one link rather than the conversation that held it.
  const droppedDocumentRefs: string[] = [];
  for (const conversation of payload.coachConversations) {
    const writable = conversation.attachments.filter((attachment) => {
      if (documentIds.has(attachment.documentId)) return true;
      droppedDocumentRefs.push(attachment.documentId);
      return false;
    });
    if (writable.length === 0) continue;
    await tx.coachConversationDocument.createMany({
      data: writable.map((attachment) => ({
        conversationId: conversation.id,
        documentId: attachment.documentId,
        addedAt: new Date(attachment.addedAt),
      })),
    });
  }
  recordUnknownKeys(
    skips,
    "coachAttachment",
    [...new Set(droppedDocumentRefs)],
    droppedDocumentRefs,
  );

  return {
    coachConversations: clearedConversations.count,
    coachMessages: clearedMessages,
    coachConversationDocuments: clearedAttachments,
  };
}

/**
 * A turn's stored bytes, whichever end of the contract the file came from.
 *
 * A disaster-recovery file carries ciphertext that decodes straight back into
 * the column. A portable file carries plaintext, which has to be encrypted on
 * the way in — the target instance's key, not the source's, which is the whole
 * point of a portable file being portable.
 */
function resolveTurnBytes(
  message: RestoredCoachMessage,
): Uint8Array<ArrayBuffer> {
  if (message.contentEncrypted !== undefined) {
    return decodeBase64(message.contentEncrypted);
  }
  return encryptToBytes(message.content ?? "");
}

function resolveSummaryBytes(
  conversation: RestoredCoachConversation,
): Uint8Array<ArrayBuffer> | null {
  if (conversation.summaryEncrypted !== undefined) {
    return conversation.summaryEncrypted === null
      ? null
      : decodeBase64(conversation.summaryEncrypted);
  }
  // A portable file with no summary and one with an empty summary are the same
  // thing to a reader, and neither should write a zero-byte ciphertext.
  return conversation.summary ? encryptToBytes(conversation.summary) : null;
}

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength));
  bytes.set(decoded);
  return bytes;
}
