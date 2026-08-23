/**
 * OpenAPI route table — server capabilities discovery, build identity, and the
 * operator's assistant feature matrix.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 * Schemas come from `src/lib/validations/*` where shared with the
 * runtime request parsing, so the wire contract stays single-source.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";
import { dataEnvelope, errorEnvelope, stdResponses } from "./shared";

// v1.10.2 — live capability / discovery response. Every list is sourced
// server-side from the canonical registry it documents, so the wire shape
// here is the contract; the runtime values are authoritative and never
// hand-duplicated. Used by the native client to gate its UI / decoder
// against what the server actually ships (retires the doc-vs-server
// enum-drift class).
const capabilitiesResponse = z
  .object({
    apiContractVersion: z
      .string()
      .describe("Running build version — mirrors GET /api/version `version`."),
    derivedMetricIds: z
      .array(z.string())
      .describe("Closed derived-metric id set (GET /api/insights/derived)."),
    vitalsBaselineTypes: z
      .array(z.string())
      .describe("MeasurementTypes the typical-range baseline engine supports."),
    layoutTileIds: z
      .array(z.string())
      .describe("Canonical insights layout tile-id set (English ids)."),
    metricStatusIds: z
      .array(z.string())
      .describe("Closed metric-status / assessment id set."),
    ingest: z
      .object({
        quantityTypes: z
          .array(
            z.object({
              type: z.string().describe("HealthLog MeasurementType."),
              hk: z.string().describe("HealthKit identifier."),
              unit: z.string().describe("Canonical DB unit."),
            }),
          )
          .describe("Accepted HealthKit quantity-sample mappings."),
        eventTypes: z
          .array(z.string())
          .describe(
            "MeasurementTypes for device-flagged EVENT-class HealthKit samples.",
          ),
        computedScores: z
          .array(z.string())
          .describe("Server-owned nightly composite score types."),
        writeAllowlist: z
          .array(z.string())
          .describe(
            "MeasurementSources a client may attribute on a write (others are server-owned).",
          ),
      })
      .describe("Ingest vocabularies the batch / single-write paths accept."),
    fhir: z
      .object({
        atcSystem: z.string().describe("WHO ATC CodeSystem URI."),
        snomedRoute: z.string().describe("SNOMED CT CodeSystem URI."),
        germanAtcDefaultLocales: z
          .array(z.string())
          .describe(
            "App locales that default the additive BfArM ATC coding on.",
          ),
        restBaseUrl: z
          .string()
          .describe("Base path of the read-only FHIR R4 REST face."),
        scopeMintable: z
          .boolean()
          .describe(
            "Whether a narrow Bearer token for the FHIR face can be obtained. Always false: no mint path grants the scope, so the face is reachable by the owner's cookie session or a wildcard device token only.",
          ),
        resourceTypes: z
          .array(z.string())
          .describe(
            "FHIR resource types the REST face serves (read + search).",
          ),
        operations: z
          .array(z.string())
          .describe("Whole-record operations exposed (e.g. $everything)."),
        searchParams: z
          .array(z.string())
          .describe(
            "Search parameters honoured uniformly across the search routes.",
          ),
      })
      .describe(
        "FHIR coding constants + the read-only REST face descriptor (v1.11).",
      ),
    share: z
      .object({
        supported: z
          .boolean()
          .describe("Whether clinician share links are served."),
        maxDays: z
          .number()
          .int()
          .describe(
            "Maximum lifetime of a share link, in days. No never-expiring share.",
          ),
        reportDownload: z
          .array(z.string())
          .describe(
            "Machine formats a share link serves as a download under its token, behind the same unlock as the page.",
          ),
        selectionVersion: z
          .number()
          .int()
          .describe("Version of the leaf-selection grammar this build speaks."),
        groups: z
          .array(
            z.object({
              id: z.string().describe("Group id."),
              leaves: z
                .array(z.string())
                .describe(
                  "Member leaf ids, in the order the panel renders them.",
                ),
              sensitive: z
                .boolean()
                .optional()
                .describe(
                  "Present and true only on the fenced tier: no single control may switch on more than one of its leaves.",
                ),
            }),
          )
          .describe(
            "Selection groups, in presentation order, each carrying its member leaf ids.",
          ),
        leaves: z
          .array(z.string())
          .describe(
            "Every leaf id a report selection may carry. Membership is inclusion; absence is exclusion.",
          ),
      })
      .describe("Clinician share-link surface descriptor."),
    retiredRoutes: z
      .array(
        z.object({
          path: z.string().describe("The path, as it was published."),
          removedIn: z
            .string()
            .describe("Release the removal shipped in, without the `v`."),
          replacedBy: z
            .string()
            .nullable()
            .describe(
              "Where the capability went, or null when it went nowhere.",
            ),
          reason: z
            .string()
            .describe("Why it was removed, in one sentence, in English."),
          methods: z
            .array(z.string())
            .describe(
              "The verbs the route exported before it was removed. Every verb answers 410 regardless — the path was retired, not a selection of methods on it.",
            ),
        }),
      )
      .describe(
        "Paths this server used to serve and no longer does. Each answers 410 Gone with `meta.errorCode` = `route.retired`. Read on launch so a client can drop the surface that depended on one before it makes the call, rather than learning from the failure.",
      ),
  })
  .meta({
    id: "CapabilitiesResponse",
    description:
      "Live id vocabularies + contract version. Every list is derived server-side from the canonical registry it documents, so it cannot drift from the values the routes actually accept/emit.",
  });

// v1.4.41 — the measurement categorisation overlay iOS reads on cold start
// to drive the HealthKit permission picker (one consent screen per
// category). Every value is sourced server-side from the canonical
// `MEASUREMENT_CATEGORIES` map, so the wire shape here is the contract.
const measurementCategoriesResponse = z
  .object({
    version: z
      .literal(1)
      .describe("Additive schema marker; assignments never reshuffle."),
    categories: z
      .array(
        z.object({
          id: z.string().describe("Category id (e.g. `vitals`)."),
          labelKey: z
            .string()
            .describe("i18n key for the category label (`categories.<id>`)."),
          order: z.number().int().describe("Stable display order."),
        }),
      )
      .describe("The ordered category list for the picker."),
    assignments: z
      .record(z.string(), z.string())
      .describe("MeasurementType → category id map."),
  })
  .meta({
    id: "MeasurementCategoriesResponse",
    description:
      "The measurement categorisation overlay: the ordered category list plus the MeasurementType → category assignments. Derived server-side from the canonical map; cached `public, max-age=600`.",
  });

// ── Build identity ───────────────────────────────────────────────────
// The route every deploy is verified against. `version` prefers the build-arg
// the release workflow injects over the package.json fallback, so a cached
// build layer cannot re-ship the previous release's version string.

const versionResponse = z
  .object({
    version: z
      .string()
      .describe(
        "The running build's version. From the image build arg when present, falling back to package.json for a local dev run.",
      ),
    buildSha: z
      .string()
      .nullable()
      .describe(
        "Short Git SHA baked at image build time. Null for a local dev run, which is how a client tells a released image from one.",
      ),
    builtAt: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe("ISO-8601 build timestamp. Null for a local dev run."),
    license: z.string(),
    repository: z.url(),
    changelog: z.url(),
    docs: z.url(),
    offlineGeoEnabled: z
      .boolean()
      .describe(
        "A GeoLite2-City database is present and in use. When false, login-IP geolocation falls back to the online provider named below — every login IP then leaves the host.",
      ),
    geoProviderHost: z
      .string()
      .describe(
        "Host of the online geolocation provider the fallback would use, so an operator surface names the real one instead of assuming the default.",
      ),
  })
  .meta({
    id: "VersionResponse",
    description:
      "The running build's identity plus the offline-geolocation state. Public — no authentication, no account data.",
  });

// ── Assistant feature flags ──────────────────────────────────────────

const assistantFlagsResponse = z
  .object({
    assistant: z
      .object({
        enabled: z
          .boolean()
          .describe("Master kill-switch for every assistant surface."),
        coach: z.boolean().describe("Coach drawer, chat stream, history."),
        briefing: z
          .boolean()
          .describe("Daily Briefing card and its recommendations."),
        insightStatus: z
          .boolean()
          .describe("Per-metric status cards on the insight sub-pages."),
        correlations: z
          .boolean()
          .describe("Correlation narration on the insights page."),
      })
      .describe(
        "The resolved matrix. The master is already applied: when `enabled` is false every sub-flag is false in this payload, so a client reads `coach` directly and never composes `enabled && coach`.",
      ),
  })
  .meta({
    id: "AssistantFlagsResponse",
    description:
      "The operator's assistant visibility matrix, resolved. Gates the server-routed AND the on-device assistant surfaces, so a client hides the surface end-to-end rather than degrading it.",
  });

// ── Update check ─────────────────────────────────────────────────────

const updateCheckResponse = z
  .object({
    status: z
      .enum(["up_to_date", "newer_available", "unknown"])
      .describe(
        "`unknown` is a normal outcome, not an error — it means the release feed could not be reached or read.",
      ),
    current: z.string().describe("The version this instance is running."),
    latest_tag: z
      .string()
      .optional()
      .describe("The newest published release tag. Absent when `unknown`."),
    html_url: z
      .url()
      .nullable()
      .optional()
      .describe("Release page to deep-link to. Only on `newer_available`."),
    published_at: z.iso
      .datetime({ offset: true })
      .nullable()
      .optional()
      .describe("When that release was published. Only on `newer_available`."),
    checked_at: z.iso
      .datetime({ offset: true })
      .optional()
      .describe("When the check ran. Absent when `unknown`."),
    reason: z
      .string()
      .optional()
      .describe(
        "Only on `unknown`: `network_error`, or `github_status_<code>` when the feed answered but not with a success.",
      ),
  })
  .meta({
    id: "UpdateCheckResponse",
    description:
      "Whether a newer release exists. The three states are carried in `status`; which of the optional fields are present follows from it.",
  });

export const metaPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/measurement-categories": {
    get: {
      tags: ["Meta"],
      summary: "Measurement categorisation overlay",
      description:
        "Returns the UI-side measurement categorisation as an HTTP contract: the ordered category list (id + i18n label key + order) plus the MeasurementType → category assignments. iOS reads this on cold start to drive the HealthKit permission picker (one consent screen per category) and caches it client-side (`Cache-Control: public, max-age=600`). Auth via cookie or Bearer (not admin); no PII.",
      responses: {
        "200": {
          description: "Categorisation overlay.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                measurementCategoriesResponse,
                "MeasurementCategoriesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  "/api/meta/capabilities": {
    get: {
      tags: ["Meta"],
      summary: "Live server capability / id-vocabulary discovery",
      description:
        "Returns the server's REAL id vocabularies (derived-metric ids, vitals-baseline types, layout tile-ids, metric-status ids, the HealthKit ingest mapping, the FHIR coding constants) plus the running API contract version. Every list is derived server-side from the canonical registry it documents, so a client can gate its UI / decoder against what the server actually ships rather than a hand-maintained copy. Auth via cookie or Bearer (not admin).",
      responses: {
        "200": {
          description: "Capability snapshot.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                capabilitiesResponse,
                "CapabilitiesEnvelope",
              ),
            },
          },
        },
        ...stdResponses,
      },
    },
  },
  // ── Appended: two discovery reads the registry never carried.
  "/api/version": {
    get: {
      // No credential: this operation is reachable before one exists.
      // The document-level default offers the Bearer token and the session
      // cookie as alternatives; an empty array is how OpenAPI says neither
      // is required. The list of paths allowed to say it lives in
      // `openapi-security-declaration-guard.test.ts`.
      security: [],
      tags: ["Meta"],
      summary: "The running build's version, and how it was built",
      description:
        "Public — no session, no token, no account data. This is the endpoint a deploy is verified against: after pushing a new image, read `version` plus `buildSha` on every target, because the `:latest` pull is the source of truth and a queued deploy status is not.\n\n" +
        "`buildSha` and `builtAt` are baked at image build time and are null for a local development run, which is how a client tells the two apart. `offlineGeoEnabled` and `geoProviderHost` describe where login-IP geolocation resolves: with the GeoLite2 databases present nothing leaves the host, and without them the named provider sees every login address.",
      responses: {
        "200": {
          description: "Build identity and offline-geolocation state.",
          content: {
            "application/json": {
              schema: dataEnvelope(versionResponse, "VersionEnvelope"),
            },
          },
        },
      },
    },
  },
  "/api/feature-flags": {
    get: {
      tags: ["Meta"],
      summary: "The operator's assistant feature matrix",
      description:
        "Which assistant surfaces this deployment offers. The master flag is applied server-side before the shape leaves the handler, so every sub-flag is already false when the master is off and a client never composes the two.\n\n" +
        "An ACTOR surface: it answers about the deployment, not about a record, so it keeps answering while the caller is acting on somebody else's — the Coach launcher and the assistant chrome are gated on it, and a refusal here would delete a piece of the shell rather than a piece of the data. A request that attaches the per-request account selector (the `AccountSelector` header parameter) is refused with 403 `sharing.not_permitted` rather than quietly answered.\n\n" +
        "Served with `Cache-Control: private, max-age=60`: an operator's toggle propagates within a minute, and the flag read stays off the hot mount path in the meantime.",
      responses: {
        "200": {
          description: "The resolved assistant matrix.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                assistantFlagsResponse,
                "AssistantFlagsEnvelope",
              ),
            },
          },
        },
        "403": {
          description:
            "A selector header was attached to an actor surface (`meta.errorCode` = `sharing.not_permitted`).",
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },

  "/api/version/check-updates": {
    get: {
      tags: ["Meta"],
      summary: "Check whether a newer release exists",
      description:
        "A server-side proxy for the project's public release feed. It exists because the production CSP allows almost nothing on `connect-src`, so a browser calling the feed directly is silently blocked — which is exactly how the first version of the “check for updates” button appeared to do nothing.\n\n" +
        "Authenticated (cookie or a wildcard Bearer token): there is no reason an anonymous caller should poll a third-party API through this instance. No credential is forwarded to the feed, so the request runs under the host's anonymous quota — roughly sixty an hour per address, shared by everyone on the instance.\n\n" +
        'It is deliberately hard to fail. A network error, an outage, or a rate-limited feed all return 200 with `status: "unknown"` and a machine-readable `reason`, so the UI can offer a retry instead of a red banner nobody can act on. The one genuine error is a feed that answers successfully with no version tag in it. Nothing is cached server-side; the client is expected to hold the result.',
      responses: {
        "200": {
          description:
            "Up to date, an update is available, or the check could not be completed.",
          content: {
            "application/json": {
              schema: dataEnvelope(updateCheckResponse, "UpdateCheckEnvelope"),
            },
          },
        },
        "502": {
          description:
            'The release feed answered but carried no version tag. Distinct from `status: "unknown"`, which covers not reaching it at all.',
          content: { "application/json": { schema: errorEnvelope } },
        },
        ...stdResponses,
      },
    },
  },
};
