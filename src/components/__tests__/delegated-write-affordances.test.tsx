/**
 * What a delegate is offered, rendered rather than described.
 *
 * v1.36.0 shipped sharing read-only and gated it only in the application
 * chrome. Every feature surface still painted its add button, and a delegate
 * who tapped one met a 403 from a server that was right to refuse. These
 * render the real controls to markup and assert the paint, on the three
 * capability states a session can be in.
 *
 * The suite is SSR-only (`@testing-library/react` is not a dependency here),
 * which bounds what it can prove: it holds the RENDER, never the click. A
 * control that is absent here cannot be tapped, and that is the whole property
 * — but a control that is present here is not proven to work, and a submit
 * path is not proven at all. That leg lives in `e2e/account-sharing.spec.ts`.
 *
 * Mutation checks, run:
 *   - `useRecordCapabilities` returning `canAdd: true` unconditionally → the
 *     read-only legs for the intake row and the card menu go red.
 *   - `DeleteButton` dropping its `canManage` bail → "no row delete inside
 *     somebody else's record" goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { AccountAccess } from "@/lib/sharing/account-access-view";

const OWNER = {
  accountId: "acct-owner",
  username: "owner",
  displayName: "Margarethe",
  access: "read" as const,
  canWrite: false,
};

const OWN_RECORD: AccountAccess = {
  accounts: [OWNER],
  active: null,
  canSwitch: true,
};
const READ_ONLY: AccountAccess = {
  accounts: [OWNER],
  active: OWNER,
  canSwitch: true,
};
const WRITABLE: AccountAccess = {
  accounts: [OWNER],
  active: { ...OWNER, access: "write", canWrite: true },
  canSwitch: true,
};

const mockAccessRef: { value: AccountAccess } = { value: OWN_RECORD };

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      id: "delegate",
      username: "delegate",
      email: null,
      role: "USER",
      avatarUrl: null,
      modules: {},
      accountAccess: mockAccessRef.value,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { DeleteButton } from "@/components/data-list/delete-button";
import { SelectionActionBar } from "@/components/data-list/selection-action-bar";
import { MedicationCardMenu } from "@/components/medications/medication-card-menu";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { visibleCaptureKinds } from "@/components/layout/capture-picker";

function render(access: AccountAccess, node: React.ReactNode): string {
  mockAccessRef.value = access;
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("row delete", () => {
  const node = (
    <DeleteButton onConfirm={() => {}} title="Delete?" description="Gone." />
  );

  it("renders in the caller's own record", () => {
    expect(render(OWN_RECORD, node)).toContain("<button");
  });

  it("is absent inside somebody else's record, at both levels", () => {
    // Not disabled. A greyed bin still claims the row is the delegate's to
    // remove, and it is not — at either grant level, including for a row the
    // delegate entered themselves.
    expect(render(READ_ONLY, node)).toBe("");
    expect(render(WRITABLE, node)).toBe("");
  });
});

describe("bulk selection bar", () => {
  const node = (
    <SelectionActionBar
      count={3}
      onClear={() => {}}
      onConfirmDelete={() => {}}
      isDeleting={false}
      confirmTitle="Delete 3?"
      confirmBody="Gone."
    />
  );

  it("renders in the caller's own record", () => {
    expect(render(OWN_RECORD, node)).toContain(
      'data-slot="selection-action-bar"',
    );
  });

  it("is absent inside somebody else's record", () => {
    expect(render(WRITABLE, node)).toBe("");
  });
});

describe("marking a dose", () => {
  const node = (
    <MedicationIntakeActions intakeLoading={null} onRecordIntake={() => {}} />
  );

  it("is offered to a delegate who may write", () => {
    // The verb the delegation was written for: somebody looking after a
    // parent marks the morning dose taken.
    expect(render(WRITABLE, node)).toContain("<button");
  });

  it("is absent for a read-only delegate", () => {
    expect(render(READ_ONLY, node)).toBe("");
  });

  it("is offered in the caller's own record", () => {
    expect(render(OWN_RECORD, node)).toContain("<button");
  });
});

describe("the medication card menu", () => {
  const node = (
    <MedicationCardMenu
      onEdit={() => {}}
      onOpenHistory={() => {}}
      onLogSideEffect={() => {}}
    />
  );

  it("renders its trigger in the caller's own record", () => {
    expect(render(OWN_RECORD, node)).toContain("<button");
  });

  it("keeps a trigger for a delegate who may write", () => {
    // One item survives for them — noting a side effect — so the menu stays.
    expect(render(WRITABLE, node)).toContain("<button");
  });

  it("disappears entirely for a read-only delegate", () => {
    // Every item in it is owner work, so the trigger goes with them rather
    // than opening onto an empty sheet.
    expect(render(READ_ONLY, node)).toBe("");
  });
});

describe("the capture picker's kinds", () => {
  const ALL = ["measurement", "medication", "mood", "water"] as const;

  it("offers everything in the caller's own record", () => {
    expect(
      visibleCaptureKinds({ canAdd: true, canManage: true }, true, [...ALL]),
    ).toEqual(["measurement", "medication", "mood", "water"]);
  });

  it("offers a delegate only what the delegation admits", () => {
    // A reading and a dose are admitted verbs. A mood entry and a glass of
    // water are not, and the server refuses them under a switch.
    expect(
      visibleCaptureKinds({ canAdd: true, canManage: false }, true, [...ALL]),
    ).toEqual(["measurement", "medication"]);
  });

  it("offers a read-only delegate nothing", () => {
    expect(
      visibleCaptureKinds({ canAdd: false, canManage: false }, true, [...ALL]),
    ).toEqual([]);
  });

  it("still honours the module gate for the owner", () => {
    expect(
      visibleCaptureKinds({ canAdd: true, canManage: true }, false, [...ALL]),
    ).toEqual(["measurement", "medication", "mood"]);
  });
});
