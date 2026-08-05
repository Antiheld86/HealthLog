export const RELEASE_JOURNEYS = [
  {
    name: "adult-full-read-scoped-read-write-and-manage",
    contract: "inventory-only",
  },
  {
    name: "manage-mutation-activity-and-fenced-settings",
    contract: "inventory-only",
  },
  {
    name: "managed-profile-two-guardian-lifecycle",
    contract: "inventory-only",
  },
  {
    name: "two-guardian-two-record-notification-delivery",
    contract: "inventory-only",
  },
  {
    name: "revoked-manage-idempotency-replay",
    contract: "inventory-only",
  },
  {
    name: "delegate-provider-no-egress-owner-positive",
    contract: "inventory-only",
  },
  {
    name: "durable-import-actor-attribution",
    contract: "inventory-only",
  },
  {
    name: "legacy-client-compatibility",
    contract: "inventory-only",
  },
] as const;

export const ACCESSIBILITY_STATES = [
  { name: "success", contract: "inventory-only" },
  { name: "empty", contract: "inventory-only" },
  { name: "loading", contract: "inventory-only" },
  { name: "error", contract: "inventory-only" },
  { name: "refusal", contract: "inventory-only" },
] as const;
