/**
 * A `@/lib/documents/provider-order` mock for the vault route suites.
 *
 * The suites steer the document pick through `resolveDocumentVisionProvider` /
 * `resolveDocumentTextProvider` (a `{ chain, pick }` per case). The routes call
 * the `require*` forms, which throw instead of returning an empty pick; these
 * are built on the two mocked resolvers so a case that returns no pick sees
 * the route answer the vault's own `documents.inbound.providerUnsupported`
 * 422, and a case that returns a `withheld` refusal sees it thrown.
 *
 * Use inside a factory, where only a dynamic import is allowed:
 *
 *   vi.mock("@/lib/documents/provider-order", async () =>
 *     (await import("@/__tests__/helpers/provider-order-mock")).providerOrderMock(),
 *   );
 */
import { vi } from "vitest";

import { AiUnavailableError } from "@/lib/ai/capabilities/refusal";

interface MockPick {
  pick: unknown;
  withheld?: AiUnavailableError | null;
}

async function required(resolved: Promise<MockPick> | MockPick) {
  const result = await resolved;
  if (result?.withheld) throw result.withheld;
  if (!result?.pick) {
    throw new AiUnavailableError("documentAi", "no_provider", null, {
      errorCode: "documents.inbound.providerUnsupported",
      status: 422,
    });
  }
  return result.pick;
}

export function providerOrderMock() {
  const resolveDocumentVisionProvider = vi.fn();
  const resolveDocumentTextProvider = vi.fn();
  return {
    resolveDocumentVisionProvider,
    resolveDocumentTextProvider,
    requireDocumentVisionProvider: vi.fn((userId: string) =>
      required(resolveDocumentVisionProvider(userId)),
    ),
    requireDocumentTextProvider: vi.fn((userId: string) =>
      required(resolveDocumentTextProvider(userId)),
    ),
  };
}

/** The capability gate, open. Pair with `vi.mock("@/lib/ai/capabilities/gate", …)`. */
export function openCapabilityGateMock() {
  return {
    requireAiCapability: vi.fn(async () => ({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    })),
    getAiCapability: vi.fn(async () => ({
      available: true,
      reason: null,
      onDeviceAllowed: true,
    })),
  };
}
