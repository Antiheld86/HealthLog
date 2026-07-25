/**
 * GET /api/fhir/metadata — FHIR R4 `CapabilityStatement`.
 *
 * Declares the read-only REST face: the resource types served, the `read` +
 * `search-type` interactions on each, the search parameters honoured
 * (`_count`, `_offset`), the `Patient-everything` operation, and the
 * `application/fhir+json` format. Static — no per-user data — but still gated
 * behind the `fhir:read` scope so the whole `/api/fhir` tree answers
 * uniformly. Read-only: no write interactions are advertised.
 *
 * Every entry here is backed by a route. `FHIR_REST_RESOURCE_TYPES` is the one
 * catalogue the resource entries derive from, and each type in it has both a
 * `/{type}` search route and a `/{type}/{id}` read route; the operation is
 * routed at `/api/fhir/Patient/$everything`. A statement that advertises an
 * interaction a client cannot reach is worse than one that stays quiet.
 */
import type { NextRequest } from "next/server";

import packageJson from "../../../../../package.json";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  FHIR_READ_SCOPE,
  FHIR_REST_RESOURCE_TYPES,
  FHIR_SEARCH_PARAMS,
  fhirJsonResponse,
} from "@/lib/fhir/rest";

export const GET = apiHandler(async (request: NextRequest) => {
  await requireAuth(FHIR_READ_SCOPE);
  annotate({ action: { name: "fhir.metadata.read" } });

  // Same resolution order as `/api/version`: the image build arg wins so a
  // deployed instance names its release, with the package version as the
  // local-dev fallback.
  const version =
    process.env.NEXT_PUBLIC_APP_VERSION?.trim() || packageJson.version;

  const capability = {
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    description:
      "Read-only HL7 FHIR R4 face over a single HealthLog account's own health record.",
    software: { name: "HealthLog", version },
    // `cpb-2` — a `kind: "instance"` statement SHALL describe the instance it
    // speaks for. The URL is the deployment answering this request, not a
    // hardcoded host: a self-hosted instance is reachable at its own origin
    // and nowhere else.
    implementation: {
      description: "HealthLog self-hosted instance",
      url: new URL("/api/fhir", request.nextUrl.origin).toString(),
    },
    fhirVersion: "4.0.1",
    format: ["application/fhir+json"],
    rest: [
      {
        mode: "server",
        documentation:
          "Read-only access to the authenticated user's own health record.",
        // `cpb-9` — one entry per resource type. The Patient entry carries the
        // `$everything` operation alongside its interactions rather than
        // appearing a second time.
        resource: FHIR_REST_RESOURCE_TYPES.map((type) => ({
          type,
          interaction: [{ code: "read" }, { code: "search-type" }],
          searchParam: FHIR_SEARCH_PARAMS.map((name) => ({
            name,
            type: "number",
          })),
          ...(type === "Patient"
            ? {
                operation: [
                  {
                    name: "everything",
                    definition:
                      "http://hl7.org/fhir/OperationDefinition/Patient-everything",
                  },
                ],
              }
            : {}),
        })),
      },
    ],
  };

  return fhirJsonResponse(capability);
});
