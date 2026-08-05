/**
 * Provider work keeps the record subject and initiating authority together.
 *
 * A shared-record mutation can invalidate a generated assessment. The queue
 * boundary must therefore refuse delegate work before it is admitted and the
 * worker must refuse it again if an invalid payload reaches dispatch. These
 * cases exercise both boundaries with the live record resolver and grants.
 */
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

const send = vi.fn(async () => "provider-origin-job");

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
    })),
  };
});

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: vi.fn(() => ({ send })),
}));

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

import {
  ACCOUNT_SELECTOR_HEADER,
  apiHandler,
  requireRecordAuth,
} from "@/lib/api-handler";
import { hashToken } from "@/lib/auth/hmac";
import {
  providerCredentialPolicy,
  type ProviderWorkAuthority,
} from "@/lib/sharing/provider-work-authority";
import { enqueueStatusGeneration } from "@/lib/jobs/insight-status-generate-shared";
import { runInsightStatusGenerate } from "@/lib/jobs/insight-status-generate";

const PROVIDER_ORIGIN_KEY = "provider-origin-test-key";
let tokenNumber = 0;

async function createUser(id: string, managed = false): Promise<void> {
  await getPrismaClient().user.create({
    data: {
      id,
      username: `provider-${id}`,
      email: `provider-${id}@example.test`,
      role: "USER",
      ...(managed ? { managedProfileAt: new Date() } : {}),
    },
  });
}

async function mintToken(userId: string): Promise<string> {
  const raw = `${PROVIDER_ORIGIN_KEY}-${tokenNumber++}`.padEnd(28, "0");
  await getPrismaClient().apiToken.create({
    data: {
      userId,
      name: "provider-origin-test",
      tokenHash: hashToken(raw),
      permissions: ["*"],
    },
  });
  return raw;
}

async function grantManage(input: {
  id: string;
  recordUserId: string;
  actorUserId: string;
}): Promise<void> {
  await getPrismaClient().accountGrant.create({
    data: {
      id: input.id,
      grantorId: input.recordUserId,
      granteeId: input.actorUserId,
      access: "MANAGE",
      acceptedAt: new Date(Date.now() - 60_000),
    },
  });
}

const enqueueFromSharedMutation: (request: NextRequest) => Promise<Response> =
  apiHandler(async () => {
    const { user } = await requireRecordAuth("manage", "medications");
    await enqueueStatusGeneration({
      userId: user.id,
      metric: "weight",
      locale: "en",
    });
    return NextResponse.json({ data: { queued: true }, error: null });
  });

function runMutation(): Promise<Response> {
  return enqueueFromSharedMutation(
    new NextRequest("http://localhost/api/test/provider-origin", {
      method: "POST",
    }),
  );
}

function authority(input: ProviderWorkAuthority): ProviderWorkAuthority {
  return input;
}

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  send.mockClear();
  tokenNumber = 0;
});

describe("sharing provider origin", () => {
  it("enqueues and dispatches an owner-origin mutation as the positive control", async () => {
    await createUser("provider-owner");
    headerJar.set(
      "authorization",
      `Bearer ${await mintToken("provider-owner")}`,
    );

    const response = await runMutation();

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]![1] as {
      authority: ProviderWorkAuthority;
      userId: string;
    };
    expect(payload.userId).toBe("provider-owner");
    expect(payload.authority).toEqual(
      authority({
        origin: "owner",
        recordUserId: "provider-owner",
        actorUserId: "provider-owner",
        grantId: null,
      }),
    );

    const generate = vi.fn().mockResolvedValue(undefined);
    await runInsightStatusGenerate(payload, { weight: generate });

    expect(generate).toHaveBeenCalledWith("provider-owner", {
      locale: "en",
      force: true,
    });
  });

  it("enqueues and dispatches no provider work for a delegate, including a mutation-to-red payload", async () => {
    await createUser("provider-record");
    await createUser("provider-delegate");
    await grantManage({
      id: "provider-delegated-grant",
      recordUserId: "provider-record",
      actorUserId: "provider-delegate",
    });
    headerJar.set(
      "authorization",
      `Bearer ${await mintToken("provider-delegate")}`,
    );
    headerJar.set(ACCOUNT_SELECTOR_HEADER, "provider-record");

    const response = await runMutation();

    expect(response.status).toBe(200);
    expect(send).not.toHaveBeenCalled();

    const generate = vi.fn().mockResolvedValue(undefined);
    await runInsightStatusGenerate(
      {
        userId: "provider-record",
        metric: "weight",
        locale: "en",
        authority: authority({
          origin: "delegate",
          recordUserId: "provider-record",
          actorUserId: "provider-delegate",
          grantId: "provider-delegated-grant",
        }),
      },
      { weight: generate },
    );

    expect(generate).not.toHaveBeenCalled();
  });

  it("keeps a managed-profile Guardian on operator/default provider configuration", () => {
    const guardian = authority({
      origin: "guardian",
      recordUserId: "managed-record",
      actorUserId: "guardian-actor",
      grantId: "guardian-grant",
    });

    expect(providerCredentialPolicy(guardian)).toBe("operator-default");
    expect(
      providerCredentialPolicy(
        authority({
          origin: "delegate",
          recordUserId: "adult-record",
          actorUserId: "adult-delegate",
          grantId: "adult-grant",
        }),
      ),
    ).toBe("deny");
  });
});
