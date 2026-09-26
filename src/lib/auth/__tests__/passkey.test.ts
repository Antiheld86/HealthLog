/**
 * v1.4.43 W13 L-3 — Zod-narrowed `verifyAuthentication` boundary.
 *
 * Before the fix, the route passed a parsed JSON body through a raw
 * `as AuthenticationResponseJSON` cast straight into
 * `verifyAuthenticationResponse`. The SimpleWebAuthn verifier owned
 * shape validation downstream, but a future refactor reading
 * `typedResponse.id` BEFORE calling the verifier would crash on
 * `undefined.id`. The Zod schema in front of the verifier closes
 * that comprehensively — a malformed body now throws here with a
 * structured error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    authChallenge: {
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
    },
    passkey: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
  generateAuthenticationOptions: vi.fn(),
  // The verifier should NEVER be invoked on a malformed body — that's
  // the whole point of the Zod boundary.
  verifyAuthenticationResponse: vi.fn(async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  })),
}));

import { verifyAuthentication } from "../passkey";
import { prisma } from "@/lib/db";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";

const VALID_BODY = {
  id: "credId123",
  rawId: "credId123",
  response: {
    clientDataJSON: "AAAA",
    authenticatorData: "BBBB",
    signature: "CCCC",
  },
  clientExtensionResults: {},
  type: "public-key",
};

beforeEach(() => {
  vi.mocked(prisma.$queryRaw).mockResolvedValue([
    { challenge: "challenge", user_id: null },
  ] as never);
  vi.mocked(prisma.authChallenge.findUnique).mockResolvedValue({
    id: "ch-1",
    challenge: "challenge",
    expiresAt: new Date(Date.now() + 60_000),
  } as never);
  vi.mocked(prisma.authChallenge.delete).mockResolvedValue({} as never);
  vi.mocked(prisma.passkey.findUnique).mockResolvedValue({
    id: "pk-1",
    userId: "user-1",
    credentialId: "credId123",
    credentialPublicKey: new Uint8Array([1, 2, 3]),
    counter: BigInt(0),
    transports: ["internal"],
  } as never);
  vi.mocked(prisma.passkey.update).mockResolvedValue({} as never);
  vi.mocked(verifyAuthenticationResponse).mockReset();
  vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  } as never);
});

describe("verifyAuthentication — Zod boundary (L-3)", () => {
  it("accepts a well-formed AuthenticationResponseJSON body", async () => {
    const out = await verifyAuthentication("ch-1", VALID_BODY);
    expect(out.verification.verified).toBe(true);
    expect(out.passkey.userId).toBe("user-1");
    expect(verifyAuthenticationResponse).toHaveBeenCalledTimes(1);
  });

  it("rejects a body missing the `id` field before reaching the verifier", async () => {
    const malformed = { ...VALID_BODY, id: undefined };
    await expect(verifyAuthentication("ch-1", malformed)).rejects.toThrow(
      /Malformed passkey authentication response/,
    );
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("rejects a body with the wrong `type` literal", async () => {
    const malformed = { ...VALID_BODY, type: "not-a-public-key" };
    await expect(verifyAuthentication("ch-1", malformed)).rejects.toThrow(
      /Malformed passkey authentication response/,
    );
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("rejects a body missing the nested `response.clientDataJSON`", async () => {
    const malformed = {
      ...VALID_BODY,
      response: { ...VALID_BODY.response, clientDataJSON: undefined },
    };
    await expect(verifyAuthentication("ch-1", malformed)).rejects.toThrow(
      /Malformed passkey authentication response/,
    );
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("rejects an empty object as a request body", async () => {
    await expect(verifyAuthentication("ch-1", {})).rejects.toThrow(
      /Malformed passkey authentication response/,
    );
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("rejects a null body", async () => {
    await expect(verifyAuthentication("ch-1", null)).rejects.toThrow(
      /Malformed passkey authentication response/,
    );
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("accepts a body with extra unknown fields (forward-compatibility)", async () => {
    // SimpleWebAuthn's interface is permissive about future
    // authenticator-attachment / extension-result additions; the Zod
    // schema must not reject unknown keys at the top level.
    const extended = { ...VALID_BODY, futureField: "ignored" };
    const out = await verifyAuthentication("ch-1", extended);
    expect(out.verification.verified).toBe(true);
  });
});

/**
 * "Last used" is a security-page fact people act on: a passkey that reads
 * "never used" invites deletion. The column is only ever written here, on a
 * verified assertion, so the stamp and the counter bump must stay one write.
 * The read half is pinned in
 * `src/app/api/auth/passkeys/__tests__/route.test.ts`.
 */
describe("verifyAuthentication — last-used stamp", () => {
  // The file-level `beforeEach` re-arms the mocks but does not clear their
  // call history, so the write assertions below need a clean ledger.
  beforeEach(() => {
    vi.mocked(prisma.passkey.update).mockClear();
  });

  it("stamps lastUsedAt alongside the counter on a verified assertion", async () => {
    const before = Date.now();
    await verifyAuthentication("ch-1", VALID_BODY);

    expect(prisma.passkey.update).toHaveBeenCalledTimes(1);
    const call = vi.mocked(prisma.passkey.update).mock.calls[0][0];

    expect(call.where).toEqual({ id: "pk-1" });
    expect(call.data?.counter).toBe(BigInt(1));

    const stamped = call.data?.lastUsedAt;
    expect(stamped).toBeInstanceOf(Date);
    expect((stamped as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("does not stamp lastUsedAt when the assertion fails", async () => {
    vi.mocked(verifyAuthenticationResponse).mockResolvedValue({
      verified: false,
    } as never);

    await verifyAuthentication("ch-1", VALID_BODY);

    expect(prisma.passkey.update).not.toHaveBeenCalled();
  });
});
