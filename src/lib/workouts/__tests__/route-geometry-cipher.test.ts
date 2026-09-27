import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";

const addWarning = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning }),
}));

import { _resetCryptoCacheForTests, encryptBytes } from "@/lib/crypto";
import {
  decryptRouteGeometry,
  encryptRouteGeometry,
  readRouteGeometry,
} from "../route-geometry-cipher";

const TRACK = {
  type: "LineString",
  coordinates: [
    [13.4012, 52.5201, 34.5],
    [13.4051, 52.5233, 36],
  ],
};

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", "d".repeat(64));
  _resetCryptoCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  _resetCryptoCacheForTests();
});

describe("route geometry cipher", () => {
  it("round-trips a track and keeps no coordinate readable in the sealed bytes", () => {
    const sealed = encryptRouteGeometry(TRACK);
    expect(Buffer.from(sealed).toString("latin1")).not.toContain("52.5201");
    expect(decryptRouteGeometry(sealed)).toEqual(TRACK);
  });

  it("prefers the ciphertext, falls back to the legacy column, and is null for neither", () => {
    const sealed = encryptRouteGeometry(TRACK);
    expect(
      readRouteGeometry({
        geometry: { stale: true },
        geometryEncrypted: sealed,
      }),
    ).toEqual(TRACK);
    expect(
      readRouteGeometry({ geometry: TRACK, geometryEncrypted: null }),
    ).toBe(TRACK);
    expect(readRouteGeometry({ geometry: null, geometryEncrypted: null })).toBe(
      null,
    );
  });

  it("does not open a value sealed for another purpose", () => {
    const other = encryptBytes(Buffer.from(JSON.stringify(TRACK)));
    expect(() => decryptRouteGeometry(new Uint8Array(other))).toThrow();
  });

  it("reads a ciphertext that does not open as no track, with a warning, never the legacy column", () => {
    addWarning.mockClear();
    const sealed = encryptRouteGeometry(TRACK);
    sealed[sealed.byteLength - 1] ^= 0xff;
    expect(
      readRouteGeometry({ geometry: TRACK, geometryEncrypted: sealed }),
    ).toBeNull();
    expect(addWarning).toHaveBeenCalledTimes(1);
    expect(String(addWarning.mock.calls[0][0])).toContain(
      "workout route decrypt failed",
    );
  });
});
