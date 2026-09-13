import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/api-fetch", () => ({ apiFetchRaw: vi.fn() }));

import { I18nProvider } from "@/lib/i18n/context";
import { TestConnectionButton } from "../test-connection-button";

function render(unsavedChanges?: boolean) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <TestConnectionButton
        endpoint="/api/settings/webhook/test"
        unsavedChanges={unsavedChanges}
      />
    </I18nProvider>,
  );
}

// The test route sends through the saved config. With an unsaved change on
// the card, a test would report on something other than what is on screen.
describe("TestConnectionButton with unsaved changes", () => {
  it("locks the button and says to save first", () => {
    const html = render(true);
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain('data-slot="test-connection-save-first"');
    expect(html).toContain(
      "Save your changes first. Test uses the saved settings.",
    );
  });

  it("stays usable and quiet when the form matches what is saved", () => {
    const html = render(false);
    expect(html).not.toMatch(/<button[^>]*disabled=""/);
    expect(html).not.toContain("test-connection-save-first");
  });
});
