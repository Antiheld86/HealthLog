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
 * (`admitDocumentSourceCaller`). With the list unset it answers 200
 * `available: false` rather than 404, because this is the one read the client
 * makes to decide whether to show the picker at all.
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
  const refused = await admitDocumentSourceCaller(auth, { needsList: false });
  if (refused) return refused;

  annotate({ action: { name: "documents.sources.status" } });

  if (!documentSourcesAvailable()) {
    const off: DocumentSourcesStatusDto = {
      available: false,
      allowedOrigins: [],
      connections: [],
    };
    return apiSuccess(off);
  }

  const rows = await listConnections(auth.user.id);
  const status: DocumentSourcesStatusDto = {
    available: true,
    allowedOrigins: listedDocumentSourceOrigins(),
    connections: rows.map(toConnectionDto),
  };
  return apiSuccess(status);
});
