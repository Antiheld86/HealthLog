/**
 * A refused sharing action says what happened, stays on screen, and can be
 * tried again.
 *
 * ## The state this file exists to prevent
 *
 * Three of the four mutations on the shared-access panel had no failure
 * rendering at all. `accept`, `revoke` and `renounce` fired, the request came
 * back 409 or 410 or never left the machine, and the panel did nothing: the
 * dialog had already closed, the list did not change, and the only signal was
 * the absence of one. The two refusals that matter most were exactly the two
 * that arrived silently — an invitation that had lapsed, and the last Guardian
 * being told they may not walk away from a profile that would then have nobody
 * looking after it. Both are recoverable, and neither was recoverable if
 * nobody knew it had happened.
 *
 * ## Why the failure lives on the mutation and not in a `useState`
 *
 * A local `useState` set from `onError` is a second copy of a fact TanStack
 * already holds, and the copy is the thing that goes stale: a re-render from
 * an unrelated invalidation clears it, or a second failure overwrites the
 * first row's message onto another row. `isError` / `error` / `variables`
 * survive on the mutation until something explicitly resets it, and
 * `variables` is what says WHICH row failed. That is also what makes this file
 * possible — the panel's failure states are reachable from a static render,
 * with no click, because they are props rather than the result of an
 * interaction.
 *
 * ## What a static render can and cannot prove
 *
 * It proves the alert exists, is announced, is addressed to the right row,
 * carries content contrast rather than muted meta, sits beside a retry control
 * and leaves the row's own affordances in place. It does NOT prove the retry
 * button re-fires the mutation with the same argument — there is no click
 * here. That claim is the browser journey's, and the pure resolver below is
 * where the mapping from a refusal to a sentence is actually pinned.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { ApiError } from "@/lib/api/api-fetch";
import type { GrantList, GrantRow } from "@/lib/queries/use-account-grants";

const grantsRef: { value: GrantList } = { value: grantList() };

function grantList(partial: Partial<GrantList> = {}): GrantList {
  return { given: [], received: [], retentionDays: 365, ...partial };
}

/** A mutation as the panel sees one: idle unless a case says otherwise. */
interface FakeMutation {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  variables: string | undefined;
}

function idle(): FakeMutation {
  return {
    mutate: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    variables: undefined,
  };
}

function failed(error: unknown, grantId: string): FakeMutation {
  return { ...idle(), isError: true, error, variables: grantId };
}

const acceptRef = { value: idle() };
const revokeRef = { value: idle() };
const renounceRef = { value: idle() };

vi.mock("@/lib/queries/use-account-grants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/use-account-grants")>();
  return {
    ...actual,
    useAccountGrants: () => ({
      data: grantsRef.value,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useAcceptGrant: () => acceptRef.value,
    useRevokeGrant: () => revokeRef.value,
    useRenounceGrant: () => renounceRef.value,
  };
});

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({ mutate: vi.fn(), isPending: false }),
}));

import {
  grantActionErrorKey,
  type GrantAction,
} from "@/components/settings/access/grant-action-error";
import { inviteErrorKey } from "@/components/settings/access/grant-invite-card";
import { GrantsGivenCard } from "@/components/settings/access/grants-given-card";
import { GrantsReceivedCard } from "@/components/settings/access/grants-received-card";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

const BASE: GrantRow = {
  id: "g1",
  account: { id: "acct-1", username: "housemate", displayName: "Jo" },
  access: "MANAGE",
  scope: null,
  state: "ACTIVE",
  invitedAt: "2026-01-02T10:00:00.000Z",
  acceptedAt: "2026-01-02T11:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  revokedBy: null,
};

const PENDING: GrantRow = { ...BASE, state: "PENDING", acceptedAt: null };

function apiError(status: number, errorCode?: string): ApiError {
  return new ApiError("refused", status, errorCode ? { errorCode } : undefined);
}

function reset() {
  acceptRef.value = idle();
  revokeRef.value = idle();
  renounceRef.value = idle();
  grantsRef.value = grantList();
}

describe("what a refused sharing action says", () => {
  const cases: Array<{
    action: GrantAction;
    err: unknown;
    key: string;
    why: string;
  }> = [
    {
      action: "accept",
      err: apiError(410, "sharing.accept.expired"),
      key: "recordSharing.actionError.acceptExpired",
      why: "the invitation lapsed — the next step is to ask for a new one",
    },
    {
      action: "accept",
      err: apiError(410, "sharing.accept.revoked"),
      key: "recordSharing.actionError.acceptWithdrawn",
      why: "withdrawn is a different fact from lapsed, and has no next step",
    },
    {
      action: "accept",
      err: apiError(409, "sharing.accept.not_pending"),
      key: "recordSharing.actionError.acceptNotPending",
      why: "already accepted, most likely in another tab",
    },
    {
      action: "accept",
      err: apiError(404, "sharing.accept.not_found"),
      key: "recordSharing.actionError.acceptNotFound",
      why: "the row is gone",
    },
    {
      action: "accept",
      err: apiError(429),
      key: "recordSharing.actionError.rateLimited",
      why: "waiting is the recovery, so it must not read as a failure",
    },
    {
      action: "revoke",
      err: apiError(409, "managed_profile.guardian.required"),
      key: "recordSharing.actionError.lastGuardian",
      why: "the refusal a managed profile depends on, and it names a way out",
    },
    {
      action: "renounce",
      err: apiError(409, "managed_profile.guardian.required"),
      key: "recordSharing.actionError.lastGuardian",
      why: "the same refusal reached from the delegate's side",
    },
    {
      action: "revoke",
      err: apiError(409, "sharing.revoke.already_ended"),
      key: "recordSharing.actionError.alreadyEnded",
      why: "nothing to recover — the access is already closed",
    },
    {
      action: "renounce",
      err: apiError(409, "sharing.renounce.already_ended"),
      key: "recordSharing.actionError.alreadyEnded",
      why: "same, from the other side",
    },
    {
      action: "revoke",
      err: apiError(404, "sharing.revoke.not_found"),
      key: "recordSharing.actionError.notFound",
      why: "the row is gone",
    },
    {
      action: "accept",
      err: new TypeError("Failed to fetch"),
      key: "recordSharing.actionError.offline",
      why: "never reached the server — retrying is the whole recovery",
    },
    {
      action: "revoke",
      err: new TypeError("Failed to fetch"),
      key: "recordSharing.actionError.offline",
      why: "same, and the row is unchanged because nothing was sent",
    },
    {
      action: "renounce",
      err: new TypeError("Failed to fetch"),
      key: "recordSharing.actionError.offline",
      why: "same",
    },
    {
      action: "accept",
      err: apiError(500),
      key: "recordSharing.actionError.acceptFailed",
      why: "an unclassified failure still says which act failed",
    },
    {
      action: "revoke",
      err: apiError(500),
      key: "recordSharing.actionError.revokeFailed",
      why: "same",
    },
    {
      action: "renounce",
      err: apiError(500),
      key: "recordSharing.actionError.renounceFailed",
      why: "same",
    },
  ];

  for (const { action, err, key, why } of cases) {
    it(`${action}: ${why}`, () => {
      expect(grantActionErrorKey(err, action)).toBe(key);
    });
  }

  it("tells the refusals apart rather than collapsing them", () => {
    // The failure this table is written against is one message for
    // everything. Distinct codes must produce distinct sentences, and the
    // count is asserted so a resolver that returned one key for all of them
    // fails here rather than passing every row above by accident.
    const distinct = new Set(
      cases.map(({ err, action }) => grantActionErrorKey(err, action)),
    );
    expect(distinct.size).toBeGreaterThan(8);
  });
});

describe("a refused invitation keeps what was typed", () => {
  const INVITE_CARD = readFileSync(
    join(process.cwd(), "src/components/settings/access/grant-invite-card.tsx"),
    "utf8",
  );

  it("separates a request that never arrived from one the server refused", () => {
    // "The invitation could not be sent" invites somebody to change the form,
    // and after a dropped connection the form is fine.
    expect(inviteErrorKey(new TypeError("Failed to fetch"))).toBe(
      "recordSharing.invite.errorOffline",
    );
    expect(inviteErrorKey(apiError(404))).toBe(
      "recordSharing.invite.errorNoAccount",
    );
    expect(inviteErrorKey(apiError(409, "sharing.invite.duplicate"))).toBe(
      "recordSharing.invite.errorDuplicate",
    );
  });

  it("clears the form only where the invitation actually went", () => {
    // A static render cannot press the button, so the claim is made about the
    // code path instead: every field reset lives inside `onSuccess`. A reset
    // that migrated into `onError` — or out of the callbacks entirely — would
    // wipe a typed identifier and eight ticked sections on a failure the
    // person is being asked to retry.
    const start = INVITE_CARD.indexOf("onSuccess:");
    const split = INVITE_CARD.indexOf("onError:", start);
    // The options object ends at the first `      },` after the error arm, so
    // the slice stops at the mutation rather than running into the JSX below,
    // where a `setNarrowed(false)` on a radio would satisfy the matcher for
    // the wrong reason.
    const end = INVITE_CARD.indexOf("\n      },", split);
    const onSuccess = INVITE_CARD.slice(start, split);
    const onError = INVITE_CARD.slice(split, end);

    // Positive controls: both slices really contain the callback they name.
    expect(onSuccess).toContain("setInvited");
    expect(onError).toContain("inviteErrorKey");

    for (const reset of [
      'setIdentifier("")',
      'setExpiresOn("")',
      'setAccess("READ")',
      "setNarrowed(false)",
      "setSections([])",
    ]) {
      expect(onSuccess, reset).toContain(reset);
      expect(onError, reset).not.toContain(reset);
    }
  });
});

describe("the refusal stays on screen, addressed to its own row", () => {
  it("announces a refused acceptance and leaves the invitation acceptable", () => {
    reset();
    grantsRef.value = grantList({ received: [PENDING] });
    acceptRef.value = failed(apiError(410, "sharing.accept.expired"), "g1");

    const html = render(<GrantsReceivedCard />);

    // Announced, not merely printed.
    expect(html).toContain('data-slot="grant-action-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("That invitation has lapsed");
    // Addressed to the row it belongs to, so a second invitation below it
    // does not wear somebody else's failure.
    expect(html).toContain('data-grant-error-for="g1"');
    // The state survives: the row is still there and still offers the act.
    expect(html).toContain('data-grant-id="g1"');
    expect(html).toContain('data-slot="grant-accept"');
    // And there is a way to try again.
    expect(html).toContain('data-slot="grant-action-retry"');
  });

  it("does not paint the failure onto a row that did not fail", () => {
    reset();
    grantsRef.value = grantList({
      received: [PENDING, { ...PENDING, id: "g2" }],
    });
    acceptRef.value = failed(apiError(410, "sharing.accept.expired"), "g1");

    const html = render(<GrantsReceivedCard />);

    expect(html.match(/data-slot="grant-action-error"/g)).toHaveLength(1);
    expect(html).toContain('data-grant-error-for="g1"');
    expect(html).not.toContain('data-grant-error-for="g2"');
  });

  it("names the last-Guardian refusal and the way out of it", () => {
    reset();
    grantsRef.value = grantList({ given: [BASE] });
    revokeRef.value = failed(
      apiError(409, "managed_profile.guardian.required"),
      "g1",
    );

    const html = render(<GrantsGivenCard />);

    expect(html).toContain('data-slot="grant-action-error"');
    // The sentence has to carry the recovery. "Could not end access" is true
    // and useless; the owner needs to know a second guardian is the fix.
    expect(html).toContain("Add another guardian first");
    // The row keeps its control, so the owner can act on the advice and
    // return to the same button.
    expect(html).toContain('data-slot="grant-revoke"');
  });

  it("reaches the same refusal from the delegate's side", () => {
    reset();
    grantsRef.value = grantList({ received: [BASE] });
    renounceRef.value = failed(
      apiError(409, "managed_profile.guardian.required"),
      "g1",
    );

    const html = render(<GrantsReceivedCard />);

    expect(html).toContain('data-slot="grant-action-error"');
    expect(html).toContain("Add another guardian first");
    expect(html).toContain('data-slot="grant-renounce"');
  });

  it("keeps material copy in content contrast, not muted meta", () => {
    reset();
    grantsRef.value = grantList({ received: [PENDING] });
    acceptRef.value = failed(new TypeError("Failed to fetch"), "g1");

    const html = render(<GrantsReceivedCard />);
    const alert = /<[^>]*data-slot="grant-action-error"[^>]*>/.exec(html)?.[0];

    expect(alert).toBeDefined();
    // A refusal somebody has to act on is content. UI-STANDARDS §3 reserves
    // muted for meta, and a sentence nobody reads is a sentence nobody acts
    // on.
    expect(alert).toContain("text-destructive");
    expect(alert).not.toContain("text-muted-foreground");
  });

  it("shows nothing at all while every mutation is idle", () => {
    reset();
    grantsRef.value = grantList({ given: [BASE], received: [PENDING] });

    expect(render(<GrantsGivenCard />)).not.toContain(
      'data-slot="grant-action-error"',
    );
    expect(render(<GrantsReceivedCard />)).not.toContain(
      'data-slot="grant-action-error"',
    );
  });
});
