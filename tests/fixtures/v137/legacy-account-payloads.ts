export interface LegacyAccountPayloadFixture {
  readonly name:
    "whole-read" | "whole-write" | "manage-as-write" | "scoped-fail-closed";
  readonly access: "read" | "write";
  readonly level: "read" | "write" | "manage";
  readonly sections: readonly string[] | null;
  readonly canWrite: boolean;
  readonly recordKind: "shared" | "managed";
  readonly legacyDecoder: "allow" | "deny";
}

export const LEGACY_ACCOUNT_PAYLOADS = [
  {
    name: "whole-read",
    access: "read",
    level: "read",
    sections: null,
    canWrite: false,
    recordKind: "shared",
    legacyDecoder: "allow",
  },
  {
    name: "whole-write",
    access: "write",
    level: "write",
    sections: null,
    canWrite: true,
    recordKind: "shared",
    legacyDecoder: "allow",
  },
  {
    name: "manage-as-write",
    access: "write",
    level: "manage",
    sections: null,
    canWrite: true,
    recordKind: "managed",
    legacyDecoder: "allow",
  },
  {
    name: "scoped-fail-closed",
    access: "read",
    level: "read",
    sections: ["measurements"],
    canWrite: false,
    recordKind: "shared",
    legacyDecoder: "deny",
  },
] as const satisfies readonly LegacyAccountPayloadFixture[];
