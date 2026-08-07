export type ExternalOrigin = "owner-request" | "delegated-request";
export type GrantState = "active" | "revoked" | "not-required";

export interface SecurityPrincipalFixture {
  readonly identities: {
    readonly actorUserId: string;
    readonly recordUserId: string;
    readonly recipientUserId: string;
  };
  readonly origin: ExternalOrigin;
  readonly grant: {
    readonly id: string | null;
    readonly state: GrantState;
  };
  readonly job: {
    readonly id: string;
    readonly origin: ExternalOrigin;
  };
}

export const SECURITY_PRINCIPALS = {
  activeDelegation: {
    identities: {
      actorUserId: "guardian-alpha",
      recordUserId: "managed-profile-alpha",
      recipientUserId: "guardian-beta",
    },
    origin: "delegated-request",
    grant: { id: "grant-active-alpha", state: "active" },
    job: { id: "job-active-alpha", origin: "delegated-request" },
  },
  revokedDelegation: {
    identities: {
      actorUserId: "guardian-alpha",
      recordUserId: "managed-profile-alpha",
      recipientUserId: "guardian-beta",
    },
    origin: "delegated-request",
    grant: { id: "grant-revoked-alpha", state: "revoked" },
    job: { id: "job-revoked-alpha", origin: "delegated-request" },
  },
  ownerProviderPositiveControl: {
    identities: {
      actorUserId: "owner-alpha",
      recordUserId: "owner-alpha",
      recipientUserId: "owner-alpha",
    },
    origin: "owner-request",
    grant: { id: null, state: "not-required" },
    job: { id: "job-owner-provider", origin: "owner-request" },
  },
  ownerIdempotencyPositiveControl: {
    identities: {
      actorUserId: "owner-beta",
      recordUserId: "owner-beta",
      recipientUserId: "owner-beta",
    },
    origin: "owner-request",
    grant: { id: null, state: "not-required" },
    job: { id: "job-owner-idempotency", origin: "owner-request" },
  },
} as const satisfies Record<string, SecurityPrincipalFixture>;
