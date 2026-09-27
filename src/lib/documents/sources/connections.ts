/**
 * Reading a person's document-source connection, and the one place its token
 * is decrypted.
 *
 * {@link toConnectionDto} is the only shape a connection leaves the server in,
 * and it has no field that could carry the token: `hasToken` is the literal
 * `true`. {@link openConnection} decrypts the token for exactly one request to
 * the source and re-checks the stored origin against the operator's list on
 * the way, so a connection whose origin was removed from
 * `DOCUMENT_SOURCE_ORIGINS` answers `originNotAllowed` instead of dialling.
 */
import { decrypt } from "@/lib/crypto";
import { prisma } from "@/lib/db";

import { sourceClient, type SourceClient } from "./clients";
import { DocumentSourceError } from "./http";
import { evaluateSourceBaseUrl } from "./origins";
import type {
  DocumentPickerSystem,
  DocumentSourceConnectionDto,
} from "./types";

/** The columns a DTO or a request needs; never the whole row by accident. */
const CONNECTION_SELECT = {
  system: true,
  baseUrl: true,
  organizationId: true,
  tokenEncrypted: true,
  lastVerifiedAt: true,
} as const;

export interface StoredConnection {
  system: string;
  baseUrl: string;
  organizationId: string | null;
  tokenEncrypted: string;
  lastVerifiedAt: Date | null;
}

export function toConnectionDto(
  row: Omit<StoredConnection, "tokenEncrypted">,
): DocumentSourceConnectionDto {
  return {
    system: row.system as DocumentPickerSystem,
    baseUrl: row.baseUrl,
    organizationId: row.organizationId,
    hasToken: true,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    originAllowed: evaluateSourceBaseUrl(row.baseUrl).ok,
  };
}

export function listConnections(
  userId: string,
): Promise<Omit<StoredConnection, "tokenEncrypted">[]> {
  return prisma.documentSourceConnection.findMany({
    where: { userId },
    select: {
      system: true,
      baseUrl: true,
      organizationId: true,
      lastVerifiedAt: true,
    },
    orderBy: { system: "asc" },
  });
}

export function loadConnection(
  userId: string,
  system: DocumentPickerSystem,
): Promise<StoredConnection | null> {
  return prisma.documentSourceConnection.findUnique({
    where: { userId_system: { userId, system } },
    select: CONNECTION_SELECT,
  });
}

/**
 * A client for one of the person's stored connections, or the reason there is
 * none. Throws {@link DocumentSourceError}: `notConnected` when nothing is
 * stored for the system, `originNotAllowed` when the operator no longer lists
 * the stored origin.
 */
export async function openConnection(
  userId: string,
  system: DocumentPickerSystem,
): Promise<SourceClient> {
  const row = await loadConnection(userId, system);
  if (!row) throw new DocumentSourceError("notConnected");
  return clientFor(row);
}

/** A client for a row already in hand, with the origin re-checked. */
export function clientFor(row: StoredConnection): SourceClient {
  const verdict = evaluateSourceBaseUrl(row.baseUrl);
  if (!verdict.ok) throw new DocumentSourceError("originNotAllowed");
  return sourceClient({
    system: row.system as DocumentPickerSystem,
    origin: verdict.origin,
    baseUrl: verdict.baseUrl,
    organizationId: row.organizationId,
    token: decrypt(row.tokenEncrypted),
  });
}

/** Stamp a successful test. */
export async function markVerified(
  userId: string,
  system: DocumentPickerSystem,
): Promise<Date> {
  const at = new Date();
  await prisma.documentSourceConnection.updateMany({
    where: { userId, system },
    data: { lastVerifiedAt: at },
  });
  return at;
}
