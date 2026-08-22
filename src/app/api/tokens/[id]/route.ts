import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import { isApiGloballyEnabled } from "@/lib/app-settings";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * Revoke an API token.
 *
 * Still gated on the instance-wide API switch, where the sibling LIST is not.
 * The reasoning for the split lives in `../route.ts`: the list answers which
 * credentials exist on the caller's own account and is never the unsafe half,
 * while this one mutates the token surface the operator has switched off.
 */
export const DELETE = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();
    annotate({ action: { name: "tokens.revoke" } });

    if (!(await isApiGloballyEnabled())) {
      return apiError("API is globally disabled", 403);
    }

    const { id } = await params;
    const token = await prisma.apiToken.findUnique({ where: { id } });

    if (!token || token.userId !== user.id) {
      return apiError("Token not found", 404);
    }

    await prisma.apiToken.update({
      where: { id },
      data: { revoked: true },
    });

    return apiSuccess({ revoked: true });
  },
);
