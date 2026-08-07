/**
 * The managed-profile surface, from a static render.
 *
 * ## What an SSR render can prove here, and what it cannot
 *
 * It can prove that a control exists, that the sentence which qualifies it
 * sits beside it in document order, that a list renders one row per profile,
 * and — because the section is composed rather than routed — that the whole
 * card is present for an owner and absent for a delegate. It CANNOT prove that
 * what the form posts reaches the server: there is no click here, so the
 * submit path never runs and every assertion below stays green with the form
 * wired to a constant. That half belongs to `tests/integration/
 * managed-profile-surface.test.ts` (the real routes) and to the browser
 * journey in `e2e/v137-sharing-managed-profiles.spec.ts`.
 *
 * The unit environment is `node`: no jsdom, no testing-library. The pure
 * exports (`displayNameIssue`, `createManagedProfileErrorKey`,
 * `managedProfilesOf`) are where the decisions live, and they are pinned
 * directly for that reason.
 *
 * ## The reachability legs are legs, not reasoning
 *
 * `/settings/access` is an ACTOR surface — grant management is the one thing a
 * delegate must have no reach into — and `access` classifies `personal`, so
 * the prediction is that a Guardian inside a profile and an adult MANAGE
 * delegate both get the refusal panel instead. That is asserted rather than
 * argued: `auth-shell.tsx` and `settings-shell.tsx` decide reachability above
 * every component in this file, and Plan 13 shipped a destination that was
 * admitted and unreachable because the prediction was not checked.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import { ApiError } from "@/lib/api/api-fetch";
import type { AccountAccessEntry } from "@/lib/sharing/account-access-view";
import type { GrantList } from "@/lib/queries/use-account-grants";
import type { ManagedProfileGuardian } from "@/lib/queries/use-managed-profiles";

/** The account payload, as the cards under test read it. */
const authRef: {
  value: {
    accounts: AccountAccessEntry[];
    active: AccountAccessEntry | null;
  };
} = { value: { accounts: [], active: null } };

vi.mock("@/hooks/use-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-auth")>();
  return {
    ...actual,
    useAuth: () => ({
      user: {
        id: "guardian",
        username: "guardian",
        timezone: "Europe/Berlin",
        accountAccess: {
          accounts: authRef.value.accounts,
          active: authRef.value.active,
          canSwitch: authRef.value.accounts.length > 0,
        },
      },
      isLoading: false,
      isAuthenticated: true,
      isAuthUnknown: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

function grantList(partial: Partial<GrantList> = {}): GrantList {
  return { given: [], received: [], retentionDays: 365, ...partial };
}

vi.mock("@/lib/queries/use-account-grants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/use-account-grants")>();
  return {
    ...actual,
    useAccountGrants: () => ({
      data: grantList(),
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useRecordActivity: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useInviteGrant: () => idle(),
    useAcceptGrant: () => idle(),
    useRevokeGrant: () => idle(),
    useRenounceGrant: () => idle(),
  };
});

/** The roster read, as each profile row sees it. */
const rosterRef: { value: ManagedProfileGuardian[] | undefined } = {
  value: [],
};
/** The deletion mutation, idle unless a case says otherwise. */
const deleteRef = { value: idle() };

vi.mock("@/lib/queries/use-managed-profiles", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/use-managed-profiles")>();
  return {
    ...actual,
    useCreateManagedProfile: () => idle(),
    useDeleteManagedProfile: () => deleteRef.value,
    useManagedProfileGuardians: () => ({
      data: rosterRef.value,
      isLoading: false,
      isError: rosterRef.value === undefined,
      refetch: vi.fn(),
    }),
  };
});

vi.mock("@/hooks/use-account-switch", () => ({
  useAccountSwitch: () => ({ mutate: vi.fn(), isPending: false }),
}));

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

function failed(error: unknown, variables: string): FakeMutation {
  return { ...idle(), isError: true, error, variables };
}

function guardian(
  partial: Partial<ManagedProfileGuardian> = {},
): ManagedProfileGuardian {
  return {
    grantId: "g1",
    account: { id: "acct-1", username: "guardian", displayName: "Alex" },
    state: "ACTIVE",
    invitedAt: "2026-01-02T10:00:00.000Z",
    acceptedAt: "2026-01-02T11:00:00.000Z",
    ...partial,
  };
}

import { AccessSection } from "@/components/settings/access-section";
import { RecordSettingsSectionGate } from "@/components/settings/record-settings-section-gate";
import {
  createManagedProfileErrorKey,
  displayNameIssue,
} from "../managed-profile-create-form";
import {
  activeGuardianCount,
  deleteProfileBody,
  managedProfilesOf,
} from "../managed-profile-card";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

/** The section as the settings page actually mounts it: behind the gate. */
function renderGatedSection(): string {
  return render(
    <RecordSettingsSectionGate section="access">
      <AccessSection />
    </RecordSettingsSectionGate>,
  );
}

function entry(partial: Partial<AccountAccessEntry> = {}): AccountAccessEntry {
  return {
    accountId: "p1",
    username: "managed-abc",
    displayName: "Managed record",
    access: "write",
    level: "manage",
    recordKind: "managed",
    sections: null,
    canWrite: true,
    ...partial,
  };
}

beforeEach(() => {
  authRef.value = { accounts: [], active: null };
  rosterRef.value = [guardian()];
  deleteRef.value = idle();
});

describe("the managed-profile card, in the shared-access section", () => {
  it("renders inside the section, after the invitation card", () => {
    const html = renderGatedSection();
    expect(html).toContain('data-slot="managed-profile-card"');
    // Reading order: the invitation is the first act, this is the second, and
    // the standing state of both follows. A card that drifted below the
    // activity feed would still contain every string this file asserts.
    expect(html.indexOf('data-slot="grant-invite-card"')).toBeLessThan(
      html.indexOf('data-slot="managed-profile-card"'),
    );
    expect(html.indexOf('data-slot="managed-profile-card"')).toBeLessThan(
      html.indexOf('data-slot="grants-given-card"'),
    );
  });

  it("says the record has no login and that the creator looks after it", () => {
    const html = renderGatedSection();
    // The two facts somebody is consenting to. A rewrite that keeps the form
    // and drops either sentence should fail here.
    expect(html).toContain("It has no login and no e-mail address");
    expect(html).toContain("you become its first guardian");
  });

  it("collects the four fields the route accepts and nothing else", () => {
    const html = renderGatedSection();
    for (const slot of [
      "managed-profile-name",
      "managed-profile-dob",
      "managed-profile-locale",
      "managed-profile-create-submit",
    ]) {
      expect(html, slot).toContain(`data-slot="${slot}"`);
    }
    // The timezone control is the shared picker, which labels itself.
    expect(html).toContain('id="managed-profile-timezone"');
    // Six languages offered, which is the route's enum exactly.
    const options =
      /<select[^>]*data-slot="managed-profile-locale"[\s\S]*?<\/select>/
        .exec(html)?.[0]
        .match(/<option/g) ?? [];
    expect(options).toHaveLength(6);
  });

  it("lists the profiles this account looks after, and only those", () => {
    authRef.value = {
      accounts: [
        entry(),
        entry({
          accountId: "a1",
          username: "housemate",
          displayName: "Jo",
          recordKind: "shared",
        }),
      ],
      active: null,
    };
    const html = renderGatedSection();
    expect(html).toContain('data-managed-profile-id="p1"');
    // An adult who shared their own record is not a profile anybody looks
    // after, and offering a delete control for one would be the same mistake
    // one level up.
    expect(html).not.toContain('data-managed-profile-id="a1"');
    expect(html.match(/data-slot="managed-profile-row"/g)).toHaveLength(1);
  });
});

describe("who can reach the section at all", () => {
  it("renders for an unswitched owner", () => {
    const html = renderGatedSection();
    expect(html).toContain('data-slot="managed-profile-card"');
    expect(html).not.toContain("shared-record-settings-unavailable-title");
  });

  it("does not render for a Guardian inside the profile they look after", () => {
    // Grant management is the one surface a delegate must have no reach into,
    // and a Guardian acting AS the profile is a delegate for this purpose.
    authRef.value = { accounts: [entry()], active: entry() };
    const html = renderGatedSection();
    expect(html).toContain("shared-record-settings-unavailable-title");
    expect(html).not.toContain('data-slot="managed-profile-card"');
    expect(html).not.toContain('data-slot="grant-invite-card"');
  });

  it("does not render for an adult delegate holding MANAGE", () => {
    const adult = entry({
      accountId: "a1",
      username: "housemate",
      displayName: "Jo",
      recordKind: "shared",
    });
    authRef.value = { accounts: [adult], active: adult };
    const html = renderGatedSection();
    expect(html).toContain("shared-record-settings-unavailable-title");
    expect(html).not.toContain('data-slot="managed-profile-card"');
  });
});

describe("what the form decides before it sends", () => {
  it("treats a whitespace-only name as empty, because the route does", () => {
    // The route trims and then requires 1..80. A client that did not trim
    // would offer to send a name the server reads as absent.
    expect(displayNameIssue("   ")).toBe("recordSharing.managed.nameRequired");
    expect(displayNameIssue("")).toBe("recordSharing.managed.nameRequired");
    expect(displayNameIssue("  Managed record  ")).toBeNull();
  });

  it("holds the route's own 80-character bound", () => {
    expect(displayNameIssue("x".repeat(80))).toBeNull();
    expect(displayNameIssue("x".repeat(81))).toBe(
      "recordSharing.managed.nameTooLong",
    );
    // And trailing space does not push a valid name over the edge.
    expect(displayNameIssue(`${"x".repeat(80)}   `)).toBeNull();
  });

  it("routes the step-up gate to its own sentence, not to a failure", () => {
    // Every route in this family resolves `requireFreshMfa`, so for anybody
    // with a second factor this is the FIRST answer, not an error. Told as a
    // failure it sends somebody looking for a problem with what they typed.
    expect(
      createManagedProfileErrorKey(
        new ApiError("refused", 401, { errorCode: "auth.stepup.required" }),
      ),
    ).toBe("recordSharing.managed.errorStepUp");
    expect(createManagedProfileErrorKey(new ApiError("refused", 422))).toBe(
      "recordSharing.managed.errorInvalid",
    );
    expect(createManagedProfileErrorKey(new ApiError("refused", 500))).toBe(
      "recordSharing.managed.errorFailed",
    );
    // Not an `ApiError` means no response came back at all.
    expect(createManagedProfileErrorKey(new TypeError("Failed to fetch"))).toBe(
      "recordSharing.managed.errorOffline",
    );
    // The four are distinct, so a resolver returning one key for everything
    // fails here rather than passing each row above by accident.
    expect(
      new Set(
        [401, 422, 500].map((s) =>
          createManagedProfileErrorKey(new ApiError("refused", s)),
        ),
      ).size,
    ).toBe(3);
  });

  it("keeps a refused creation's fields, and clears them only on success", () => {
    // A static render cannot press the button, so the claim is made about the
    // code path: every reset lives inside `onSuccess`. A reset that migrated
    // into `onError` would wipe a typed name on a failure the person is being
    // asked to retry.
    const source = readForm();
    const start = source.indexOf("onSuccess:");
    const split = source.indexOf("onError:", start);
    expect(start).toBeGreaterThan(-1);
    expect(split).toBeGreaterThan(start);
    const onSuccess = source.slice(start, split);
    const onError = source.slice(split);
    expect(onSuccess).toContain("setCreated");
    expect(onError).toContain("createManagedProfileErrorKey");
    for (const reset of [
      'setDisplayName("")',
      'setDateOfBirth("")',
      "setLocale(actorLocale)",
      "setTimezone(browserTimezone())",
    ]) {
      expect(onSuccess, reset).toContain(reset);
      expect(onError, reset).not.toContain(reset);
    }
  });
});

describe("ending a managed profile", () => {
  it("offers a confirmed delete on the profile's own row", () => {
    authRef.value = { accounts: [entry()], active: null };
    const html = renderGatedSection();
    expect(html).toContain('data-slot="managed-profile-delete"');
    // The mobile tap floor UI-STANDARDS §11 asks of an inline action.
    expect(html).toMatch(
      /data-slot="managed-profile-delete"[^>]*class="[^"]*min-h-11/,
    );
  });

  it("withholds the control until the roster has answered", () => {
    // The confirm copy states how many people lose the record, and that number
    // comes from the roster. A control that existed before the read would put
    // the sentence's presence at the mercy of which request landed first —
    // the defect the retention disclosure already paid for once.
    authRef.value = { accounts: [entry()], active: null };
    rosterRef.value = undefined;
    const html = renderGatedSection();
    expect(html).toContain('data-managed-profile-id="p1"');
    expect(html).not.toContain('data-slot="managed-profile-delete"');
  });

  it("announces a refused deletion on the row it was refused for", () => {
    authRef.value = {
      accounts: [entry(), entry({ accountId: "p2", displayName: "Second" })],
      active: null,
    };
    deleteRef.value = failed(
      new ApiError("refused", 404, {
        errorCode: "managed_profile.not_found",
      }),
      "p1",
    );
    const html = renderGatedSection();

    expect(html).toContain('data-slot="grant-action-error"');
    expect(html).toContain('data-grant-error-for="p1"');
    // Not painted onto the profile that did not fail.
    expect(html).not.toContain('data-grant-error-for="p2"');
    expect(html.match(/data-slot="grant-action-error"/g)).toHaveLength(1);
    // Specific, not the generic "could not be deleted".
    expect(html).toContain("That profile is not there any more");
    // Retryable, and the row keeps its control.
    expect(html).toContain('data-slot="grant-action-retry"');
    expect(html).toContain('data-slot="managed-profile-delete"');
  });

  it("shows nothing at all while the deletion is idle", () => {
    authRef.value = { accounts: [entry()], active: null };
    expect(renderGatedSection()).not.toContain(
      'data-slot="grant-action-error"',
    );
  });
});

describe("what the confirmation says before it deletes", () => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    params ? `${key}(${JSON.stringify(params)})` : key;
  const tCount = (
    base: string,
    count: number,
    params?: Record<string, string | number>,
  ): string => `${base}:${count}(${JSON.stringify(params)})`;

  it("names what goes, how many people lose it, and the way out", () => {
    const body = deleteProfileBody({
      t,
      tCount,
      name: "Managed record",
      activeGuardians: 2,
    });
    expect(body).toContain(
      'recordSharing.managed.deleteBody({"name":"Managed record"})',
    );
    expect(body).toContain("recordSharing.managed.deleteGuardians:2");
    // The delete route emits no last-Guardian refusal, because deleting IS the
    // way out of the floor. The copy says so rather than duplicating a refusal
    // this route never sends.
    expect(body).toContain("recordSharing.managed.deleteFloorNote");
  });

  it("counts the guardians who actually hold the record", () => {
    // A pending invitation confers nothing, and the server counts the same
    // way. Counting it would tell somebody two people lose the record when
    // one does.
    expect(
      activeGuardianCount([
        guardian(),
        guardian({ grantId: "g2", state: "PENDING", acceptedAt: null }),
      ]),
    ).toBe(1);
    expect(activeGuardianCount([])).toBe(0);
    expect(activeGuardianCount(undefined)).toBe(0);
  });
});

describe("which accounts count as profiles looked after", () => {
  it("keeps the managed entries and drops the rest", () => {
    const managed = entry();
    const shared = entry({ accountId: "a1", recordKind: "shared" });
    expect(managedProfilesOf([managed, shared])).toEqual([managed]);
    expect(managedProfilesOf(undefined)).toEqual([]);
  });
});

function readForm(): string {
  return readFileSync(
    join(
      process.cwd(),
      "src/components/settings/access/managed-profile-create-form.tsx",
    ),
    "utf8",
  );
}
