import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pushDeleteMany: vi.fn(),
  eventDeleteMany: vi.fn(),
  authorizationDeleteMany: vi.fn(),
  meta: {} as Record<string, unknown>,
}));

vi.mock("../shared", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getWorkerPrisma: () => ({
    pushAttempt: { deleteMany: h.pushDeleteMany },
    notificationEvent: { deleteMany: h.eventDeleteMany },
    notificationEgressAuthorization: { deleteMany: h.authorizationDeleteMany },
  }),
}));

vi.mock("@/lib/logging/background", () => ({
  withBackgroundEvent: async (
    _name: string,
    fn: (evt: {
      addMeta: (key: string, value: unknown) => void;
      addWarning: (warning: string) => void;
    }) => Promise<unknown>,
  ) =>
    fn({
      addMeta: (key, value) => {
        h.meta[key] = value;
      },
      addWarning: vi.fn(),
    }),
}));

import { handlePushAttemptCleanup } from "../cleanup-handlers";

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(h.meta)) delete h.meta[key];
  h.pushDeleteMany.mockResolvedValue({ count: 3 });
  h.eventDeleteMany.mockResolvedValue({ count: 5 });
  h.authorizationDeleteMany.mockResolvedValue({ count: 7 });
});

describe("notification retention", () => {
  it("prunes notification ledgers with the canonical bounded attempt retention", async () => {
    await handlePushAttemptCleanup([]);

    expect(h.pushDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    });
    expect(h.eventDeleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    });
    expect(h.authorizationDeleteMany).toHaveBeenCalledWith({
      where: { authorizedAt: { lt: expect.any(Date) } },
    });
    expect(h.meta.push_attempt_cleanup_deleted).toBe(3);
    expect(h.meta.notification_event_cleanup_deleted).toBe(5);
    expect(h.meta.notification_egress_authorization_cleanup_deleted).toBe(7);
  });
});
