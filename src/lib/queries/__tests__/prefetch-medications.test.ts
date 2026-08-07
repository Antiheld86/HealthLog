import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/pwa/query-client-options";
import { queryKeys } from "@/lib/query-keys";
import {
  __resetRecordScopeForTests,
  setRecordScope,
} from "@/lib/query-keys/record-scope";
import { prefetchMedicationsList } from "../prefetch-medications";

function envelopeResponse(data: unknown): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  __resetRecordScopeForTests();
  vi.unstubAllGlobals();
});

describe("prefetchMedicationsList", () => {
  it("does not park an aborted shared-record preload in the own-record cache", async () => {
    setRecordScope("shared-record");
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_path: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
    });

    prefetchMedicationsList(client, controller.signal);
    controller.abort();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    setRecordScope(null);

    expect(client.getQueryData(queryKeys.medications())).toBeUndefined();
    expect(
      client.getQueryData(queryKeys.medicationComplianceSummary()),
    ).toBeUndefined();
  });

  it("passes a lifecycle signal to both record reads", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn().mockResolvedValue(envelopeResponse([]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new QueryClient({
      defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
    });

    prefetchMedicationsList(client, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      signal: controller.signal,
    });
  });
});
