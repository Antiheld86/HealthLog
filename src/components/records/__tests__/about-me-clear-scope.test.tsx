/**
 * Anamnese "About me" note: the Clear control cannot take the allergy line.
 *
 * #159 — the panel moved from the account settings into the Anamnese as
 * `about-me-note-manager.tsx` (note) + `allergy-free-text-note.tsx` (the
 * free-text allergy line, under the structured AllergyManager). The scoped
 * clear is unchanged and stays pinned here.
 *
 * The control used to fire `save.mutate({ aboutMe: "", allergies: "" })` from
 * a bare `onClick`. One tap wiped a person's free-text note AND their
 * allergies — the entry a clinician reads first, stored in a column that is
 * overwritten in place, with no tombstone and no restore route. The toast it
 * raised said "About-me note cleared", so the copy had been describing the
 * intended behaviour all along; the payload was the thing that was wrong.
 *
 * Two properties are pinned here, and the first matters more than the second:
 *
 *   1. SCOPE. The request carries `aboutMe` and no `allergies` key at all.
 *      The PUT leaves an omitted field untouched by contract, so the payload
 *      cannot carry the allergy line away even if the dialog were removed
 *      again. A confirmation someone can delete is not a guarantee.
 *   2. GATE. Nothing goes out while the dialog is merely on screen. The
 *      destructive call reaches the control only as `onConfirm`, so a
 *      dismissed dialog leaves the request unmade — asserted here by
 *      rendering, checking no request was issued, and only then invoking the
 *      captured callback.
 *
 * `@testing-library/react` is not a dependency (SSR-only component tests), so
 * the dialog is not literally clicked. `ConfirmButton` is stubbed to capture
 * the props the panel hands it; that the real primitive routes `onConfirm`
 * through the dialog action alone is proved in
 * `src/components/ui/__tests__/confirm-button.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

type AboutMePayload = {
  aboutMe: string | null;
  conditions: string | null;
  allergies: string | null;
  coachFocus: string | null;
  pendingQuestions: string[];
  updatedAt: string;
  maxChars: number;
  fieldMaxChars: number;
};

// Hoisted, because `vi.mock`'s factory is lifted above the imports and may not
// close over a normal top-level binding. Typed with the real two-argument
// signature so `mock.calls[0]` is a tuple and the payload assertion below
// reads the second argument rather than `unknown[]`.
const { apiPut } = vi.hoisted(() => ({
  apiPut: vi.fn<(url: string, payload: unknown) => Promise<AboutMePayload>>(
    async () => ({
      aboutMe: null,
      conditions: null,
      allergies: "penicillin",
      coachFocus: null,
      pendingQuestions: [],
      updatedAt: "2026-07-26T00:00:00.000Z",
      maxChars: 4000,
      fieldMaxChars: 500,
    }),
  ),
}));

vi.mock("@/lib/api/api-fetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/api-fetch")>();
  return { ...actual, apiPut };
});

/** Captured props of every `<ConfirmButton>` the panel rendered. */
const confirmButtons: Record<string, unknown>[] = [];

vi.mock("@/components/ui/confirm-button", () => ({
  ConfirmButton: (props: Record<string, unknown>) => {
    confirmButtons.push(props);
    return (
      <button data-slot={String(props.slot)}>{String(props.label)}</button>
    );
  },
  ConfirmDialog: () => null,
}));

const { AboutMeNoteManager } = await import("../about-me-note-manager");
const { AllergyFreeTextNote } = await import("../allergy-free-text-note");

const STORED: AboutMePayload = {
  aboutMe: "Shift work, training for a half marathon.",
  conditions: null,
  allergies: "penicillin",
  coachFocus: null,
  pendingQuestions: [],
  updatedAt: "2026-07-26T00:00:00.000Z",
  maxChars: 4000,
  fieldMaxChars: 500,
};

function render(seed: Partial<typeof STORED> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.coachAboutMe(), { ...STORED, ...seed });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <AboutMeNoteManager />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  confirmButtons.length = 0;
  apiPut.mockClear();
});

describe("the Clear control is scoped to the note", () => {
  it("routes through the shared confirmation, not a bare button", () => {
    const html = render();
    expect(html).toContain('data-slot="settings-about-me-clear"');
    expect(confirmButtons).toHaveLength(1);
    expect(typeof confirmButtons[0].onConfirm).toBe("function");
  });

  it("hands the destroying call to the dialog, not to the control", () => {
    render();
    const props = confirmButtons[0];
    // The callback arrives ONLY as `onConfirm`. Anything that would let the
    // trigger act — an `onClick`, an `onSelect` — puts the request one tap
    // away again, which is the shape this whole change removed.
    expect(typeof props.onConfirm).toBe("function");
    for (const key of Object.keys(props)) {
      if (key === "onConfirm") continue;
      expect(key, "the trigger must carry no handler of its own").not.toMatch(
        /^on[A-Z]/,
      );
    }
    // And rendering it, on its own, asks the server for nothing.
    expect(apiPut).not.toHaveBeenCalled();
  });

  it("omits the allergies field entirely once confirmed", async () => {
    render();
    (confirmButtons[0].onConfirm as () => void)();
    await vi.waitFor(() => expect(apiPut).toHaveBeenCalledTimes(1));

    const [url, raw] = apiPut.mock.calls[0]!;
    const payload = raw as Record<string, unknown>;
    expect(url).toBe("/api/coach/about-me");
    expect(payload.aboutMe).toBe("");
    // Not "sent as the stored value" — absent. The route leaves an omitted
    // field alone, so absence is what protects the allergy line.
    expect(Object.keys(payload)).not.toContain("allergies");
    expect(payload.allergies).toBeUndefined();
  });

  it("says in its dialog that allergies are not touched", () => {
    render();
    expect(confirmButtons[0].body).toBe(
      "This removes the free-text note only. Your allergies and intolerances stay exactly as they are.",
    );
  });

  it("hides the control when there is no note, even with allergies stored", () => {
    const html = render({ aboutMe: null });
    expect(html).not.toContain('data-slot="settings-about-me-clear"');
    expect(confirmButtons).toHaveLength(0);
  });
});

describe("clearing allergies stays possible, in the field itself", () => {
  it("renders the allergy textarea, editable, carrying the stored value", () => {
    // Removing the field from the Clear payload only removes the untargeted
    // route. The targeted one has to still be there, or scoping the control
    // would have taken a capability away rather than a footgun. #159 — the
    // field lives in its own component under the structured allergy list now.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(queryKeys.coachAboutMe(), STORED);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <AllergyFreeTextNote />
        </I18nProvider>
      </QueryClientProvider>,
    );
    const field = html.slice(
      html.indexOf('data-testid="records-allergy-free-text"'),
    );
    const openTag = field.slice(0, field.indexOf(">"));
    expect(openTag).not.toContain("disabled");
    expect(html).toContain("penicillin");
  });
});
