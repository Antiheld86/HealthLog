/**
 * Document picker (#1038): which document archives this person can pick from.
 *
 * `available` says whether the operator listed any origin in
 * `DOCUMENT_SOURCE_ORIGINS`; `allowedOrigins` lists them so the settings card
 * can say which addresses will be accepted; `connections` are the person's own
 * saved connections, never with their token (`hasToken` is the literal true).
 * No request leaves the server here.
 *
 * Cookie-only and owner-only like every route under this path
 * (`admitDocumentSourceCaller`), but it needs neither the documents module nor
 * the list: with the list unset it answers 200 `available: false` (plus any
 * rows still stored, so they can be deleted) rather than 404, because this is
 * the one read the client makes to decide what to show.
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import {
  listConnections,
  toConnectionDto,
} from "@/lib/documents/sources/connections";
import {
  documentSourcesAvailable,
  listedDocumentSourceOrigins,
} from "@/lib/documents/sources/origins";
import type { DocumentSourcesStatusDto } from "@/lib/documents/sources/types";
import { admitDocumentSourceCaller } from "@/lib/documents/sources/route-support";
import { annotate } from "@/lib/logging/context";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const auth = await requireAuth();
  const refused = await admitDocumentSourceCaller(auth, {
    needsList: false,
    needsModule: false,
  });
  if (refused) return refused;

  annotate({ action: { name: "documents.sources.status" } });

  // Rows are listed even with the picker off: a connection whose origin the
  // operator removed (or whose list is gone) must stay visible so it can be
  // deleted. `originAllowed` is false for each of them then.
  const rows = await listConnections(auth.user.id);
  if (!documentSourcesAvailable()) {
    const off: DocumentSourcesStatusDto = {
      available: false,
      allowedOrigins: [],
      connections: rows.map(toConnectionDto),
    };
    return apiSuccess(off);
  }

  const status: DocumentSourcesStatusDto = {
    available: true,
    allowedOrigins: listedDocumentSourceOrigins(),
    connections: rows.map(toConnectionDto),
  };
  return apiSuccess(status);
});
