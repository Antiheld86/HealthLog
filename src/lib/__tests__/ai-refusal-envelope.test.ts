/**
 * The AI refusal envelope: one shape for every reason, and every code a
 * shipped client branches on kept as it was.
 *
 * The table below is the contract. A change to it is a change a native client
 * has to be told about, so it is spelled out literally rather than derived
 * from the code under test; renaming a code, or moving a reason to a
 * different status, turns this red by name.
 *
 * Mutation check: changing the `check_failed` status to 500 in
 * `src/lib/ai/capabilities/refusal.ts`, or renaming `ai.record.notPermitted`
 * in `types.ts`, fails the table; dropping the `AiUnavailableError` branch
 * from `apiHandler` fails the envelope case with a 500.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/auth/session", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/auth/hmac", () => ({ hashToken: vi.fn() }));
vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/logging/transports", () => ({ emitIfSampled: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({ get: () => null })),
  cookies: vi.fn(async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  })),
}));

import { apiHandler } from "@/lib/api-handler";
import { AiUnavailableError, aiRefusal } from "@/lib/ai/capabilities/refusal";
import {
  AI_CAPABILITIES,
  AI_CAPABILITY_KEYS,
  AI_UNAVAILABLE_REASONS,
  type AiUnavailableReason,
} from "@/lib/ai/capabilities/types";

/** reason → [status, errorCode] for a capability on the `briefing` switch. */
const CONTRACT: Record<AiUnavailableReason, [number, string]> = {
  check_failed: [503, "ai.unavailable"],
  operator_disabled: [403, "assistant.disabled.briefing"],
  not_permitted_for_record: [403, "ai.record.notPermitted"],
  module_disabled: [403, "module.disabled"],
  user_disabled: [403, "module.disabled"],
  no_provider: [422, "ai.provider.none"],
  consent_required: [403, "consent.ai.required"],
};

describe("the refusal table", () => {
  it("covers every reason", () => {
    expect(Object.keys(CONTRACT).sort()).toEqual(
      [...AI_UNAVAILABLE_REASONS].sort(),
    );
  });

  for (const reason of AI_UNAVAILABLE_REASONS) {
    it(`${reason} → ${CONTRACT[reason].join(" ")}`, () => {
      const { status, meta } = aiRefusal("briefing", reason);
      expect([status, meta.errorCode]).toEqual(CONTRACT[reason]);
      expect(meta.capability).toBe("briefing");
      expect(meta.reason).toBe(reason);
    });
  }

  it("names each capability's own switch in the operator code", () => {
    for (const key of AI_CAPABILITY_KEYS) {
      expect(aiRefusal(key, "operator_disabled").meta.errorCode).toBe(
        `assistant.disabled.${AI_CAPABILITIES[key].operatorSwitch}`,
      );
    }
  });

  it("keeps the code shipped clients know for the Coach", () => {
    expect(aiRefusal("coach", "operator_disabled").meta.errorCode).toBe(
      "assistant.disabled.coach",
    );
  });

  it("reports an operator-disabled module as module.disabled, naming it", () => {
    expect(
      aiRefusal("workoutInsights", "operator_disabled", "workouts"),
    ).toEqual({
      status: 403,
      meta: {
        errorCode: "module.disabled",
        capability: "workoutInsights",
        reason: "operator_disabled",
        module: "workouts",
      },
    });
  });

  it("names the module behind a module or opt-out refusal", () => {
    expect(aiRefusal("statusText", "user_disabled", "insights").meta).toEqual({
      errorCode: "module.disabled",
      capability: "statusText",
      reason: "user_disabled",
      module: "insights",
    });
  });

  it("lets a route keep its own typed no-provider code and status", () => {
    const { status, meta } = aiRefusal("documentAi", "no_provider", null, {
      errorCode: "documents.inbound.providerUnsupported",
    });
    expect(status).toBe(422);
    expect(meta.errorCode).toBe("documents.inbound.providerUnsupported");
    const custom = aiRefusal("medicationExtract", "no_provider", null, {
      errorCode: "ai.provider.none",
      status: 503,
    });
    expect(custom.status).toBe(503);
  });
});

describe("apiHandler renders it", () => {
  it("as { data: null, error, meta } with the refusal's status", async () => {
    const route = apiHandler(
      async (_request: NextRequest): Promise<Response> => {
        throw new AiUnavailableError("coach", "consent_required");
      },
    );
    const res = await route(
      new NextRequest("http://localhost/api/test", { method: "POST" }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      data: unknown;
      error: string;
      meta: Record<string, unknown>;
    };
    expect(body.data).toBeNull();
    expect(typeof body.error).toBe("string");
    expect(body.meta).toEqual({
      errorCode: "consent.ai.required",
      capability: "coach",
      reason: "consent_required",
    });
  });

  it("with a 503 when the capability could not be resolved", async () => {
    const route = apiHandler(
      async (_request: NextRequest): Promise<Response> => {
        throw new AiUnavailableError("briefing", "check_failed");
      },
    );
    const res = await route(
      new NextRequest("http://localhost/api/test", { method: "GET" }),
    );
    expect(res.status).toBe(503);
    expect(
      ((await res.json()) as { meta: { errorCode: string } }).meta.errorCode,
    ).toBe("ai.unavailable");
  });
});
