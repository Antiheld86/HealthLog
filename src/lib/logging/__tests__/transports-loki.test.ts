/**
 * Loki shipping (#947 follow-up): the endpoint forms an operator types, the
 * dial path a private Loki needs, the floor no configuration opens, and the
 * stderr notice that replaces the silent catch.
 *
 * Two layers. The mocked-`safeFetch` block pins what the transport asks for
 * and what it says when that fails. The loopback block runs the real
 * `safeFetch` against a real HTTP server on 127.0.0.1, which is the case the
 * public-host pin used to refuse: an address that is not public at all.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLoggingConfig } from "../config";
import type { WideEvent } from "../types";

const safeFetchMock = vi.hoisted(() => vi.fn());
const useRealSafeFetch = vi.hoisted(() => ({ value: false }));

vi.mock("@/lib/safe-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/safe-fetch")>();
  return {
    ...actual,
    safeFetch: (...args: Parameters<typeof actual.safeFetch>) =>
      useRealSafeFetch.value
        ? actual.safeFetch(...args)
        : safeFetchMock(...args),
  };
});

import { SafeFetchError } from "@/lib/safe-fetch";
import {
  _resetLokiTransportForTests,
  emitEvent,
  flushLokiBuffer,
  LOKI_FAILURE_NOTICE_INTERVAL_MS,
  resolveLokiPushTarget,
} from "../transports";

const USERNAME = "loki-user";
const PASSWORD = "s3cret-loki-password";
const BASIC = Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64");

function makeEvent(): WideEvent {
  return {
    timestamp: new Date().toISOString(),
    duration_ms: 1,
    request_id: "req-loki",
    trace_id: "trace-loki",
    level: "info",
    kind: "http",
    service: "healthlog",
    environment: "test",
  };
}

let stderrLines: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function configure(endpoint: string, withAuth = true): void {
  vi.stubEnv("LOKI_ENDPOINT", endpoint);
  vi.stubEnv("LOKI_USERNAME", withAuth ? USERNAME : "");
  vi.stubEnv("LOKI_PASSWORD", withAuth ? PASSWORD : "");
  resetLoggingConfig();
}

function buffer(count: number): void {
  for (let i = 0; i < count; i++) emitEvent(makeEvent());
}

beforeEach(() => {
  _resetLokiTransportForTests();
  safeFetchMock.mockReset();
  useRealSafeFetch.value = false;
  stderrLines = [];
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderrLines.push(String(chunk));
      return true;
    });
  stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetLoggingConfig();
  _resetLokiTransportForTests();
});

describe("resolveLokiPushTarget", () => {
  it.each([
    ["http://loki:3100", "http://loki:3100/loki/api/v1/push"],
    ["http://loki:3100/", "http://loki:3100/loki/api/v1/push"],
    ["http://loki:3100/loki/api/v1/push", "http://loki:3100/loki/api/v1/push"],
    ["http://loki:3100/loki/api/v1/push/", "http://loki:3100/loki/api/v1/push"],
    [
      "https://logs.example.com/tenant-a",
      "https://logs.example.com/tenant-a/loki/api/v1/push",
    ],
    [
      "https://logs.example.com/tenant-a/loki/api/v1/push",
      "https://logs.example.com/tenant-a/loki/api/v1/push",
    ],
    ["  http://10.0.0.5:3100  ", "http://10.0.0.5:3100/loki/api/v1/push"],
  ])("%s pushes to %s", (endpoint, expected) => {
    const resolved = resolveLokiPushTarget(endpoint);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.target.url).toBe(expected);
  });

  it("approves exactly the endpoint origin, private addresses included", () => {
    const resolved = resolveLokiPushTarget("http://192.168.1.20:3100/");
    expect(resolved).toEqual({
      ok: true,
      target: {
        url: "http://192.168.1.20:3100/loki/api/v1/push",
        origin: "http://192.168.1.20:3100",
      },
    });
  });

  it.each([
    "http://169.254.169.254",
    "http://169.254.10.1:3100",
    "http://0.0.0.0:3100",
    "http://[fe80::1]:3100",
  ])("refuses the never-grantable host %s", (endpoint) => {
    const resolved = resolveLokiPushTarget(endpoint);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe("never_grantable");
  });

  it.each([
    "loki:3100",
    "ftp://loki:3100",
    "http://user:pw@loki:3100",
    "http://loki:3100?token=abc",
  ])("refuses the malformed endpoint %s", (endpoint) => {
    const resolved = resolveLokiPushTarget(endpoint);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toBe("invalid_endpoint");
      expect(resolved.shown).not.toContain("pw");
      expect(resolved.shown).not.toContain("abc");
    }
  });
});

describe("flushLokiBuffer — dial path", () => {
  it("dials a private endpoint as an operator-approved origin, not through the public pin", async () => {
    configure("http://10.0.0.5:3100/loki/api/v1/push");
    safeFetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    buffer(2);

    await flushLokiBuffer();

    expect(safeFetchMock).toHaveBeenCalledTimes(1);
    const [url, init, opts] = safeFetchMock.mock.calls[0];
    expect(url).toBe("http://10.0.0.5:3100/loki/api/v1/push");
    expect(init.headers.Authorization).toBe(`Basic ${BASIC}`);
    expect(opts.operatorApprovedPrivateOrigin).toBe("http://10.0.0.5:3100");
    expect(opts.requirePublicHost).toBeUndefined();
    expect(JSON.parse(init.body).streams[0].values).toHaveLength(2);
    expect(stderrLines).toEqual([]);
  });

  it("never dials a metadata endpoint and says why", async () => {
    configure("http://169.254.169.254:3100");
    buffer(3);

    await flushLokiBuffer();

    expect(safeFetchMock).not.toHaveBeenCalled();
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("never_grantable");
    expect(stderrLines[0]).toContain("3 events dropped");
  });
});

describe("flushLokiBuffer — failures reach stderr, once per window", () => {
  it("reports a non-2xx answer with origin, status and dropped count", async () => {
    configure("https://logs.example.com/loki/api/v1/push/loki/api/v1/push");
    safeFetchMock.mockResolvedValue(
      new Response("404 page not found", { status: 404 }),
    );
    buffer(4);

    await flushLokiBuffer();

    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("https://logs.example.com");
    expect(stderrLines[0]).toContain("HTTP 404");
    expect(stderrLines[0]).toContain("4 events dropped");
  });

  it("reports a thrown error by class and socket code, never by message", async () => {
    configure("http://loki.lan:3100");
    const cause = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    safeFetchMock.mockRejectedValue(
      new SafeFetchError(
        `safeFetch network error: http://${USERNAME}:${PASSWORD}@loki.lan`,
        "network",
        { cause },
      ),
    );
    buffer(1);

    await flushLokiBuffer();

    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("http://loki.lan:3100");
    expect(stderrLines[0]).toContain("network ECONNREFUSED");
    expect(stderrLines[0]).toContain("1 event dropped");
  });

  it("writes one line per reason per window and carries the suppressed count forward", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    configure("http://loki.lan:3100");
    safeFetchMock.mockImplementation(
      async () => new Response(null, { status: 503 }),
    );

    for (let i = 0; i < 5; i++) {
      buffer(2);
      await flushLokiBuffer();
      vi.advanceTimersByTime(5_000);
    }
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain("2 events dropped");

    // A different reason is not muted by the first one's window.
    safeFetchMock.mockImplementationOnce(
      async () => new Response(null, { status: 401 }),
    );
    buffer(1);
    await flushLokiBuffer();
    expect(stderrLines).toHaveLength(2);
    expect(stderrLines[1]).toContain("HTTP 401");

    vi.advanceTimersByTime(LOKI_FAILURE_NOTICE_INTERVAL_MS);
    buffer(2);
    await flushLokiBuffer();
    expect(stderrLines).toHaveLength(3);
    expect(stderrLines[2]).toContain("HTTP 503");
    // Four suppressed batches of two plus this batch of two.
    expect(stderrLines[2]).toContain("10 events dropped");
  });

  it("never prints the credentials or the basic-auth header", async () => {
    configure("http://loki.lan:3100");
    safeFetchMock.mockResolvedValueOnce(new Response(null, { status: 403 }));
    safeFetchMock.mockRejectedValueOnce(
      new SafeFetchError(`failed with Basic ${BASIC} ${PASSWORD}`, "timeout"),
    );
    buffer(1);
    await flushLokiBuffer();
    buffer(1);
    await flushLokiBuffer();

    expect(stderrLines).toHaveLength(2);
    const all = stderrLines.join("");
    expect(all).not.toContain(PASSWORD);
    expect(all).not.toContain(USERNAME);
    expect(all).not.toContain(BASIC);
  });

  it("stays silent on success", async () => {
    configure("http://loki.lan:3100");
    safeFetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    buffer(1);
    await flushLokiBuffer();
    expect(stderrLines).toEqual([]);
  });

  it("does not feed its own notice back into the Loki buffer", async () => {
    configure("http://loki.lan:3100");
    safeFetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    buffer(1);
    await flushLokiBuffer();
    expect(stderrLines).toHaveLength(1);

    // Nothing was buffered by the failure, so the next flush has nothing
    // to send.
    safeFetchMock.mockClear();
    await flushLokiBuffer();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});

describe("flushLokiBuffer — real dial to a loopback Loki", () => {
  let server: Server;
  let received: Array<{ url: string; auth: string | undefined }>;
  let status: number;

  beforeEach(async () => {
    useRealSafeFetch.value = true;
    received = [];
    status = 204;
    server = createServer((req, res) => {
      received.push({ url: req.url ?? "", auth: req.headers.authorization });
      req.resume();
      req.on("end", () => {
        res.statusCode = status;
        res.end();
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function endpoint(path = ""): string {
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}${path}`;
  }

  it("delivers to a non-public address given as the full push URL", async () => {
    configure(endpoint("/loki/api/v1/push"));
    buffer(1);

    await flushLokiBuffer();

    expect(received).toEqual([
      { url: "/loki/api/v1/push", auth: `Basic ${BASIC}` },
    ]);
    expect(stderrLines).toEqual([]);
  });

  it("reports the 404 a wrong path produces instead of swallowing it", async () => {
    status = 404;
    configure(endpoint("/wrong"));
    buffer(2);

    await flushLokiBuffer();

    expect(received).toHaveLength(1);
    expect(received[0].url).toBe("/wrong/loki/api/v1/push");
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toContain(`${endpoint()} failed (HTTP 404)`);
  });
});
