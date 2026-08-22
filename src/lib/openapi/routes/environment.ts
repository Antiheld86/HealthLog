/**
 * OpenAPI route table — the environmental-context overview (`GET /api/environment`).
 *
 * The route has served the module's settings surface and the native client
 * since the environment module shipped, and it was absent from the registry
 * entirely: `pnpm openapi:check` compares the registry against the YAML and
 * never compares the ROUTE TREE against the registry, so a route that was
 * never registered drifted without a single check going red.
 *
 * Only the overview lives here. The sibling writes under `/api/environment/*`
 * (home, travel, geocode, backfill) are a separate surface and stay
 * unpublished until they are reviewed on their own terms.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 */
import { z } from "zod/v4";
import type { ZodOpenApiObject } from "zod-openapi";

import { dataEnvelope, moduleDisabledResponse, stdResponses } from "./shared";

const environmentHome = z
  .object({
    lat: z.number().describe("Coarse home latitude."),
    lon: z.number().describe("Coarse home longitude."),
    label: z
      .string()
      .nullable()
      .describe("Operator- or user-chosen place name; null when never set."),
    timezone: z
      .string()
      .describe(
        "IANA zone the home's day keys are anchored to — the stored `homeTimezone` when one exists, else the account's display timezone. Never null: the resolution falls back rather than omitting.",
      ),
    since: z.iso
      .datetime({ offset: true })
      .nullable()
      .describe(
        "Effective-from instant of the current home. The settings surface labels the home with it and prefills the backfill start from it. Null when the home was set before the column existed.",
      ),
  })
  .meta({
    id: "EnvironmentHome",
    description:
      "The account's coarse home location. Present only when BOTH `homeLat` and `homeLon` are stored — a half-set home reads as no home at all.",
  });

const environmentTravelLocation = z
  .object({
    id: z.string().describe("Travel-override row id (cuid)."),
    startDate: z
      .string()
      .describe(
        "Inclusive first day of the override, `YYYY-MM-DD`. A date STRING, not a timestamp: the row is anchored to the home timezone's day key, so there is no instant to report.",
      ),
    endDate: z
      .string()
      .describe("Inclusive last day of the override, `YYYY-MM-DD`."),
    lat: z.number(),
    lon: z.number(),
    label: z.string().describe("Place name for the override; never null."),
  })
  .meta({
    id: "EnvironmentTravelLocation",
    description:
      "One travel override: the days on which the environmental fetch reads a different place than the home. Newest range first.",
  });

const environmentOverviewResponse = z
  .object({
    home: environmentHome.nullable(),
    travel: z
      .array(environmentTravelLocation)
      .describe("Every stored travel override, `startDate` descending."),
    context: z
      .object({
        days: z
          .number()
          .int()
          .describe("Stored daily observations for this account."),
        latestDate: z
          .string()
          .nullable()
          .describe(
            "Day key of the newest stored observation, `YYYY-MM-DD`; null when none exists.",
          ),
        latestFetchedAt: z.iso
          .datetime({ offset: true })
          .nullable()
          .describe(
            "When that newest observation was fetched; null when none exists.",
          ),
      })
      .describe("Coverage summary over the stored daily observations."),
    lastFetchFailure: z
      .object({
        lastFailedAt: z.iso
          .datetime({ offset: true })
          .describe("When the newest exhausted-retry failure gave up."),
        failures: z
          .number()
          .int()
          .describe(
            "Failures for this account on the queue inside the window.",
          ),
      })
      .nullable()
      .describe(
        "Non-null when the account's background environmental fetch has exhausted its retries recently. A day count on its own cannot tell an empty module from a broken one, which is how a job failing on every run since the module shipped could render as `0 days recorded` and nothing else. Deliberately carries NO error text — that message is written for an operator and can name internals. Null also when there is no queue to ask.",
      ),
    attribution: z
      .string()
      .describe(
        "Upstream attribution string the client must render beside the data.",
      ),
  })
  .meta({
    id: "EnvironmentOverviewResponse",
    description:
      "The environmental-context module overview: the account's coarse home, its travel overrides, how much daily observation data is stored, whether the background fetch is failing, and the upstream attribution.",
  });

export const environmentPaths: NonNullable<ZodOpenApiObject["paths"]> = {
  "/api/environment": {
    get: {
      tags: ["Environment"],
      summary: "Environmental-context module overview",
      description:
        "Returns the account's coarse home location, its travel overrides, a summary of the stored daily observations (count + newest day), whether the background fetch has been failing, and the upstream attribution string. Read-only; no outbound fetch runs on this path. Module-gated on `environment` — a disabled module answers 403 `module.disabled` even for a valid Bearer token, and the client hides the whole surface rather than retrying. `userId` is narrowed from the session or the Bearer token, never a body or query field. Cookie or Bearer auth; the caller is always resolved as themselves, so this read cannot be delegated to a shared record.",
      responses: {
        "200": {
          description: "The module overview.",
          content: {
            "application/json": {
              schema: dataEnvelope(
                environmentOverviewResponse,
                "EnvironmentOverviewEnvelope",
              ),
            },
          },
        },
        ...moduleDisabledResponse,
        ...stdResponses,
      },
    },
  },
};
