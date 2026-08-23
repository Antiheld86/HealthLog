/**
 * OpenAPI route table — paths that were published and are gone.
 *
 * Part of the OpenAPI route table; aggregated in `./index.ts`.
 *
 * These are the only published paths with no route module behind them, and
 * that is the point: a client generated from this contract sees the path, sees
 * that its single response is 410, and gets the removing version and the
 * replacement in the description rather than discovering all of it from a
 * silent 404 in production. Every operation is generated from
 * `RETIRED_ROUTES`, so the spec cannot claim a retirement the server does not
 * answer, or miss one it does.
 *
 * `deprecated: true` is the closest thing OpenAPI has to a tombstone. It is
 * imprecise — the word means "still works, stop using it", and these do not
 * work — but it is what makes a generator emit a warning at the call site,
 * which is the behaviour worth having. The description says the exact truth
 * that the flag only approximates. Neither the route-coverage guard nor the
 * security-declaration guard keys off the flag, so setting it changes nothing
 * else.
 *
 * `security: []` because the 410 needs no credential: the proxy answers before
 * any handler and never looks at the request's cookies or Authorization
 * header. Publishing these as authenticated would tell a client to present a
 * credential in order to be told the path is gone. The reason is recorded in
 * `openapi-security-declaration-guard.test.ts` alongside the other opt-outs.
 */
import type { ZodOpenApiObject } from "zod-openapi";

import {
  RETIRED_ROUTE_ERROR_CODE,
  RETIRED_ROUTES,
  type RetiredRoute,
} from "@/lib/http/retired-routes";

import { errorEnvelope } from "./shared";

function goneOperation(route: RetiredRoute, method: string) {
  const replacement = route.replacedBy
    ? `Use \`${route.replacedBy}\` instead.`
    : "There is no replacement; the capability is gone rather than moved.";

  return {
    security: [],
    deprecated: true,
    tags: ["Retired"],
    summary: `${method} ${route.path} — removed in v${route.removedIn}`,
    description:
      `Removed in v${route.removedIn}. Every request to this path answers 410 Gone, whatever the method and whatever credential it carries. ${replacement}\n\n` +
      `${route.reason}\n\n` +
      "Retiring a path is deliberate, so the answer says so rather than leaving a client to read a 404 as a broken deployment and retry forever. Treat 410 as terminal: drop the call, degrade the surface that depended on it, and do not offer a retry.",
    responses: {
      "410": {
        description:
          `The path was removed in v${route.removedIn} and will not answer again. ` +
          `\`meta.errorCode\` = \`${RETIRED_ROUTE_ERROR_CODE}\`, \`meta.removedIn\` carries the version, and \`meta.replacedBy\` carries the replacement path or null.`,
        content: { "application/json": { schema: errorEnvelope } },
      },
    },
  };
}

export const retiredPaths: NonNullable<ZodOpenApiObject["paths"]> =
  Object.fromEntries(
    RETIRED_ROUTES.map((route) => [
      route.path,
      Object.fromEntries(
        route.methods.map((method) => [
          method.toLowerCase(),
          goneOperation(route, method),
        ]),
      ),
    ]),
  );
