/**
 * External-id stability floor.
 *
 * The rejected cases are the shapes that provably cannot be an identity.
 * The accepted cases are every external-id shape this repository actually
 * receives — grepped out of the ingest routes, the batch contracts, the
 * OpenAPI examples and the existing fixtures. A false positive here costs
 * a working client its sync, so the accepted list is the real guard.
 */
import { describe, it, expect } from "vitest";

import {
  assertStableExternalId,
  classifyExternalId,
  isStableExternalId,
  unstableExternalIdMessage,
  unstableExternalIdMeta,
  unstableExternalIdShape,
  UNSTABLE_EXTERNAL_ID_REASON,
} from "@/lib/validations/external-id";
import { z } from "zod/v4";

describe("classifyExternalId — refused shapes", () => {
  it("refuses the object description that caused the live incident", () => {
    expect(classifyExternalId("<HKHealthConceptIdentifier: 0x12568db80>")).toBe(
      "object_description",
    );
  });

  it("refuses any <Class: 0xHEX> description, not just the one class", () => {
    for (const value of [
      "<NSObject: 0x600000c1a2b0>",
      "<SomeVendorType: 0X7FFEE3B0>",
      "<Foo: 0x1>",
      "<HKObject: 0x126b25160; type=bar>",
      "apple:<HKHealthConceptIdentifier: 0x11f47e3e0>",
    ]) {
      expect(classifyExternalId(value)).toBe("object_description");
    }
  });

  it("refuses a bare pointer value", () => {
    expect(classifyExternalId("0x12568db80")).toBe("pointer_address");
    expect(classifyExternalId("0XDEADBEEF")).toBe("pointer_address");
  });

  it("refuses an empty or whitespace-only id", () => {
    expect(classifyExternalId("")).toBe("blank");
    expect(classifyExternalId("   ")).toBe("blank");
    expect(classifyExternalId("\t\n ")).toBe("blank");
  });

  it("classifies a padded description after trimming", () => {
    expect(classifyExternalId("  <HKFoo: 0xabc123>  ")).toBe(
      "object_description",
    );
  });
});

describe("classifyExternalId — the id shapes this system actually receives", () => {
  // Every entry below is a shape that exists in this repository today:
  // the iOS batch contract, the Apple Health mirror, the Withings /
  // WHOOP / Oura / Fitbit / Polar sync paths, the CSV importer, and the
  // web client's own UUID mints.
  const accepted = [
    // HealthKit sample UUIDs (upper + lower case, hyphenated)
    "8AD2A9CB-3F0C-4E4D-9C1E-4B7E2A1D6F30",
    "3f0c4e4d-9c1e-4b7e-2a1d-6f30ad2a9cb1",
    // Un-hyphenated / compact ids
    "8AD2A9CB3F0C4E4D9C1E4B7E2A1D6F30",
    // The `stats:` aggregate contract (per-day + hourly bucket)
    "stats:HKQuantityTypeIdentifierStepCount:2026-07-25",
    "stats:HKQuantityTypeIdentifierActiveEnergyBurned:2026-07-25",
    "stats:HKQuantityTypeIdentifierHeartRate:2026-07-25T08:10:00Z",
    // Other structured prefix forms minted in this tree today
    "assessment:clx1a2b3c4d5e6f7g8h9",
    "withings:activity:clx1a2b3c4d5e6f7g8h9:2026-07-25:steps",
    "withings:sleep:clx1a2b3c4d5e6f7g8h9:998877:hr_average",
    "cycle:123456:strain",
    "sleep:0f3a8c2e-2b1d-4f5a-9c8e-1d2f3a4b5c6d:hrv_rmssd",
    "spo2:2026-07-25T03:12:00Z:unknown",
    "hkcycle:2026-07-25",
    "stats:steps:2026-07-25",
    "retired:clx1a2b3c4d5e6f7g8h9:hk-uuid-41",
    "hk-uuid-41",
    // Opaque vendor identifiers
    "1234567890",
    "clx1a2b3c4d5e6f7g8h9",
    "a3f5c9e1b7d2486fa0c3e5b7d9f1a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6",
    // Base64-ish blob
    "aGVhbHRobG9nOnNhbXBleQ==",
    // Platform type identifiers
    "HKQuantityTypeIdentifierStepCount",
    // Values that merely CONTAIN hex-looking text but are not pointers
    "0xygen-sample-1",
    "sample-0x12ab-tail",
    "not<angle>brackets",
    "<no-pointer-here>",
  ];

  it.each(accepted)("accepts %s", (value) => {
    expect(classifyExternalId(value)).toBeNull();
    expect(isStableExternalId(value)).toBe(true);
  });

  it("does not reject on length, spaces, or unusual characters alone", () => {
    expect(isStableExternalId("My Glucose Meter Export Row 41")).toBe(true);
    expect(isStableExternalId("a")).toBe(true);
    expect(isStableExternalId("ärztliche-messung-2026-07-25")).toBe(true);
  });
});

describe("messages", () => {
  it("names what is wrong and what to send instead", () => {
    expect(unstableExternalIdMessage("object_description")).toContain(
      "stable across app restarts",
    );
    expect(unstableExternalIdMessage("object_description")).toContain(
      "object description",
    );
    expect(unstableExternalIdMessage("pointer_address")).toContain(
      "memory address",
    );
    expect(unstableExternalIdMessage("blank")).toContain("must not be empty");
  });
});

describe("assertStableExternalId — object-level Zod check", () => {
  const schema = z
    .object({ externalId: z.string().max(128).optional() })
    .superRefine(assertStableExternalId);

  it("rejects an object description with the actionable message on the field", () => {
    const parsed = schema.safeParse({
      externalId: "<HKHealthConceptIdentifier: 0x12568db80>",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues).toHaveLength(1);
    expect(parsed.error.issues[0].path).toEqual(["externalId"]);
    expect(parsed.error.issues[0].message).toBe(
      unstableExternalIdMessage("object_description"),
    );
  });

  it("accepts a stable id and an absent id alike", () => {
    expect(
      schema.safeParse({ externalId: "stats:HKFoo:2026-07-25" }).success,
    ).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
  });
});

describe("wide-event helpers", () => {
  it("reads a top-level externalId off an unparsed body", () => {
    expect(unstableExternalIdShape({ externalId: "0xdeadbeef" })).toBe(
      "pointer_address",
    );
    expect(unstableExternalIdShape({ externalId: "uuid-1" })).toBeNull();
    expect(unstableExternalIdShape({ externalId: 42 })).toBeNull();
    expect(unstableExternalIdShape(null)).toBeNull();
    expect(unstableExternalIdShape("not-an-object")).toBeNull();
  });

  it("pins the meta shape and never carries the id itself", () => {
    expect(
      unstableExternalIdMeta("measurement.batch", [
        "object_description",
        "object_description",
        "pointer_address",
      ]),
    ).toEqual({
      external_id_rejected: 3,
      external_id_shapes: "object_description,pointer_address",
      external_id_surface: "measurement.batch",
    });
  });

  it("exposes one per-entry reason code for every batch surface", () => {
    expect(UNSTABLE_EXTERNAL_ID_REASON).toBe("unstable_external_id");
  });
});
