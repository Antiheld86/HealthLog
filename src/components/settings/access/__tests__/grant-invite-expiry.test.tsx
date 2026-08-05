import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  it("uses the shared date field on the invitation form", () => {
    const html = render(<GrantInviteCard />);
    expect(html).toContain('data-slot="grant-invite-expires"');
    expect(html).toContain('data-slot="date-field"');
    expect(html).not.toContain('type="date"');
  });

  it("maps a chosen day to the owner's local end of day", () => {
    expect(endOfDayIso("2026-03-29", "America/New_York")).toBe(
      "2026-03-30T03:59:59.999Z",
    );
    expect(endOfDayIso("2026-10-25", "Europe/Berlin")).toBe(
      "2026-10-25T22:59:59.999Z",
    );
  });

  it("treats an empty field as no lapse date", () => {
    expect(endOfDayIso("", "Europe/Berlin")).toBeNull();
  });

  it("refuses a value that is not a date rather than sending an invalid instant", () => {
    expect(endOfDayIso("not-a-date", "Europe/Berlin")).toBeNull();
  });

  it("announces retryable failures without clearing the invitation", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/settings/access/grant-invite-card.tsx",
      ),
      "utf8",
    );
    const onError = source.slice(
      source.indexOf("onError: (err) => setError"),
      source.indexOf(
        "    );\n  };",
        source.indexOf("onError: (err) => setError"),
      ),
    );

    expect(onError).toContain("setError(t(inviteErrorKey(err)))");
    expect(onError).not.toContain("setIdentifier");
    expect(onError).not.toContain("setExpiresOn");
    expect(source).toContain('role="alert"');
    expect(source).toContain(
      "invite.isPending || identifier.trim().length === 0",
    );
  });
});
