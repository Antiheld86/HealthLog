/**
 * (issue #775) Memory preflight for the Apple Health import. The
 * streaming parse keeps memory bounded, so the preflight is generous —
 * it exists to refuse only the truly impossible combination (a tiny
 * pinned heap against a huge declared export) with an actionable
 * reason, instead of letting the worker die mid-parse and leave the
 * job stuck in a running state.
 */
import { describe, expect, it } from "vitest";

import {
  IMPORT_MEMORY_PREFLIGHT_BASE_BYTES,
  IMPORT_MEMORY_PREFLIGHT_XML_DIVISOR,
  INSUFFICIENT_MEMORY_REASON_PREFIX,
  importMemoryPreflightReason,
} from "../apple-health-import-worker";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("importMemoryPreflightReason", () => {
  it("passes a large real-world export against any default heap", () => {
    // A 3 GiB export.xml (238 MB export.zip scale) against a 1 GiB
    // default heap — the reported self-hoster setup — must NOT be
    // refused: the streaming parse carries it.
    expect(importMemoryPreflightReason(3 * GIB, 1 * GIB)).toBeNull();
  });

  it("passes the largest extractable export against the default heap", () => {
    // 8 GiB is the archive-level extraction cap; the model needs
    // ~320 MiB for it, far below any default heap.
    expect(importMemoryPreflightReason(8 * GIB, 1 * GIB)).toBeNull();
  });

  it("refuses when the pinned heap cannot carry the declared export", () => {
    const reason = importMemoryPreflightReason(8 * GIB, 256 * MIB);
    expect(reason).not.toBeNull();
    expect(reason).toMatch(
      new RegExp(`^${INSUFFICIENT_MEMORY_REASON_PREFIX}: `),
    );
    // The reason must be actionable for the operator: name the knob.
    expect(reason).toContain("NODE_OPTIONS=--max-old-space-size=");
    // And honest about the numbers involved.
    expect(reason).toContain("8192 MiB uncompressed");
    expect(reason).toContain("256 MiB");
  });

  it("scales the requirement with the declared XML size", () => {
    const declared = 4 * GIB;
    const required =
      IMPORT_MEMORY_PREFLIGHT_BASE_BYTES +
      Math.ceil(declared / IMPORT_MEMORY_PREFLIGHT_XML_DIVISOR);
    expect(importMemoryPreflightReason(declared, required)).toBeNull();
    expect(importMemoryPreflightReason(declared, required - 1)).not.toBeNull();
  });

  it("stays comfortably under the 1000-char failureReason column slice", () => {
    const reason = importMemoryPreflightReason(8 * GIB, 1);
    expect(reason).not.toBeNull();
    expect((reason as string).length).toBeLessThan(500);
  });
});
