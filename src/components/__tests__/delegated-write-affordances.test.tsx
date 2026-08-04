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
 *   - `TodayHero` passing `onDismiss` / `onAction` unconditionally → the rail
 *     legs go red, printing the dismiss control and the check-in buttons.
 *   - `VorsorgeDashboardCard` dropping its `canManage` bail → the mark-done
 *     leg goes red.
 *   - `EpisodeDocumentsCard` dropping its `canManage` bail → the link +
 *     upload leg goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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
      // The episode-documents card renders only for an account with the
      // vault switched on; every other surface here ignores the map.
      modules: { inboundDocuments: true },
      accountAccess: mockAccessRef.value,
    },
    isAuthenticated: true,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

// The Vorsorge summary pushes to the check-in page for a screening reminder.
// Nothing below clicks, so a stub router is enough to let it mount.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

// Never resolves inside the synchronous render, so every query below stays
// pending and each component paints its own loading branch. The controls this
// file is about live outside that branch.
vi.mock("@/lib/api/api-fetch", () => ({
  apiGet: () => new Promise(() => {}),
  apiPost: () => new Promise(() => {}),
  apiPut: () => new Promise(() => {}),
  apiPatch: () => new Promise(() => {}),
  apiDelete: () => new Promise(() => {}),
}));

import { DeleteButton } from "@/components/data-list/delete-button";
import { SelectionActionBar } from "@/components/data-list/selection-action-bar";
import { MedicationCardMenu } from "@/components/medications/medication-card-menu";
import { MedicationIntakeActions } from "@/components/medications/card-parts/medication-intake-actions";
import { visibleCaptureKinds } from "@/components/layout/capture-picker";
import { TodayHero } from "@/components/daily/today-hero";
import { VorsorgeDashboardCard } from "@/components/measurement-reminders/vorsorge-dashboard-card";
import { EpisodeDocumentsCard } from "@/components/documents/episode-documents-card";
import { queryKeys } from "@/lib/query-keys";
import type { DailyDigest } from "@/lib/daily/digest";
import type { MeasurementReminder } from "@/hooks/use-measurement-reminders";

function render(
  access: AccountAccess,
  node: React.ReactNode,
  /**
   * Seed the cache a query-backed component reads, so it paints its populated
   * branch inside a synchronous render instead of its skeleton. Cheaper and
   * truer than mocking the hook: the component under test is the real one.
   */
  seed?: (client: QueryClient) => void,
): string {
  mockAccessRef.value = access;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(queryClient);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale="en">{node}</I18nProvider>
    </QueryClientProvider>,
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

/* -------------------------------------------------------------------------- */
/* The Today rail                                                             */
/* -------------------------------------------------------------------------- */

const DIGEST: DailyDigest = {
  generatedAt: "2026-08-03T06:00:00.000Z",
  phase: "final",
  sleepPending: false,
  score: null,
  topSignal: null,
  briefingLead: "A steady week so far.",
  line: "A steady week so far.",
  justIn: null,
  reactionLine: null,
  worthALook: [
    {
      kind: "milestone",
      itemKey: "milestone:steps-10k",
      title: "Ten thousand steps",
      actions: [],
    },
    {
      kind: "coach_checkin",
      title: "Still worth keeping?",
      actions: [
        {
          labelKey: "daily.action.checkinKeep",
          intent: "coach.plan.keep:plan-1",
        },
        {
          labelKey: "daily.action.viewCheckups",
          intent: "checkup.view",
          href: "/checkups",
        },
      ],
    },
  ],
};

describe("the Today rail's mutating affordances", () => {
  const node = <TodayHero digest={DIGEST} />;

  it("offers the dismiss and the check-in answer in the caller's own record", () => {
    const html = render(OWN_RECORD, node);
    expect(html).toContain('data-slot="priority-card-dismiss"');
    expect(html).toContain("Keep it");
  });

  it("withholds both inside somebody else's record, at either level", () => {
    // Dismissing an observation and answering a coach check-in are neither of
    // them an admitted create, and both write through routes that resolve the
    // CALLER — so a delegate tapping either would file it against their own
    // record if the route allowed it, and gets a 403 because it does not.
    for (const access of [READ_ONLY, WRITABLE]) {
      const html = render(access, node);
      expect(html).not.toContain('data-slot="priority-card-dismiss"');
      expect(html).not.toContain("Keep it");
      // The rail itself stays: reading what is worth a look is the point of
      // opening somebody's record, and the navigation action survives with it.
      expect(html).toContain('data-slot="today-hero-rail"');
      expect(html).toContain('href="/checkups"');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Vorsorge                                                                   */
/* -------------------------------------------------------------------------- */

const REMINDER: MeasurementReminder = {
  id: "rem-1",
  label: "Dental check-up",
  measurementType: null,
  intervalDays: 180,
  rrule: null,
  anchorDate: null,
  endsOn: null,
  origin: "VORSORGE",
  notifyHour: 9,
  location: null,
  nextDueAt: "2026-08-10T09:00:00.000Z",
  lastSatisfiedAt: null,
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("the Vorsorge summary's mark-done", () => {
  const node = <VorsorgeDashboardCard />;
  const seed = (client: QueryClient) =>
    client.setQueryData(queryKeys.measurementReminders(), [REMINDER]);

  it("is offered in the caller's own record", () => {
    const html = render(OWN_RECORD, node, seed);
    expect(html).toContain("Dental check-up");
    expect(html).toContain("Done");
  });

  it("is absent inside somebody else's record, at either level", () => {
    // `/checkups` already withheld this exact action; the dashboard summary
    // offering it was the inconsistency that showed nobody had asked.
    for (const access of [READ_ONLY, WRITABLE]) {
      const html = render(access, node, seed);
      expect(html).toContain("Dental check-up");
      expect(html).not.toContain("Done");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Documents on an illness episode                                            */
/* -------------------------------------------------------------------------- */

describe("linking a document to an illness episode", () => {
  const node = <EpisodeDocumentsCard episodeId="ep-1" />;

  it("offers the link and the upload in the caller's own record", () => {
    const html = render(OWN_RECORD, node);
    expect(html).toContain(">Link<");
    expect(html).toContain("Upload");
  });

  it("offers neither inside somebody else's record, at either level", () => {
    // Both write through `POST /api/documents/inbound/bulk`, which the vault
    // gates on the same answer throughout — the episode side of the same link
    // had no gate at all, and the upload deep-linked to a page whose own
    // upload control is already withheld.
    for (const access of [READ_ONLY, WRITABLE]) {
      const html = render(access, node);
      expect(html).not.toContain(">Link<");
      expect(html).not.toContain("Upload");
      // The card itself stays — reading the episode's documents is a read.
      expect(html).toContain('data-slot="episode-documents-card"');
    }
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
