import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";

vi.mock("@/lib/queries/use-account-grants", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queries/use-account-grants")>();
  return {
    ...actual,
    useInviteGrant: () => ({ mutate: vi.fn(), isPending: false }),
  };
});

import { GrantInviteCard, endOfDayIso } from "../grant-invite-card";

/**
 * The lapse date, at both ends.
 *
 * `expiresAt` was accepted by the invite route, stored, and annotated on from
 * the day the grant model shipped, while the card sent a hardcoded `null`. A
 * release note said an invitation could carry a lapse date and no one could
 * set one. That is the two-ended failure this repository keeps rediscovering,
 * so both ends are pinned here: the control exists in the rendered form, and
 * the value it produces is the END of the chosen day rather than the midnight
 * that starts it.
 *
 * Project convention is SSR-only, no `@testing-library/react`; the mapping is
 * exported so its contract can be pinned without a click, and the submit path
 * is covered by the sharing browser spec.
 */
function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("grant invitation lapse date", () => {
  it("offers a date control on the invitation form", () => {
    const html = render(<GrantInviteCard />);
    expect(html).toContain('data-slot="grant-invite-expires"');
    expect(html).toContain('type="date"');
  });

  it("maps a chosen day to the end of that day, not its midnight", () => {
    const iso = endOfDayIso("2026-09-30");
    expect(iso).not.toBeNull();
    const end = new Date(iso as string);
    // Read back in the same zone the mapping used, so the assertion holds
    // wherever the suite runs rather than only under the pinned UTC clock.
    expect(end.getFullYear()).toBe(2026);
    expect(end.getMonth()).toBe(8);
    expect(end.getDate()).toBe(30);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
  });

  it("treats an empty field as no lapse date", () => {
    expect(endOfDayIso("")).toBeNull();
  });

  it("refuses a value that is not a date rather than sending an invalid instant", () => {
    expect(endOfDayIso("not-a-date")).toBeNull();
  });
});
