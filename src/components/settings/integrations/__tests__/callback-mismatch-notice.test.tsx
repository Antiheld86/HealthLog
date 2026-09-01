/**
 * `<CallbackMismatchNotice>` renders from the callback URL it is HANDED, not
 * from anything it reads itself. The origin the browser is on comes through
 * `useSyncExternalStore`, whose server snapshot is deliberately `null` (the
 * server cannot know the browser origin, and a notice that flips at hydration
 * would flash). A static render therefore never shows it; to exercise the
 * client path here the hook is replaced with its client snapshot and a bare
 * `window.location.origin` is provided.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: <T,>(
      _subscribe: (onChange: () => void) => () => void,
      getSnapshot: () => T,
    ): T => getSnapshot(),
  };
});

import { I18nProvider } from "@/lib/i18n/context";
import { CallbackMismatchNotice } from "../setup-guide-link";

const BROWSER_ORIGIN = "https://health.example";

function render(callbackUrl: string | null) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <CallbackMismatchNotice provider="WHOOP" callbackUrl={callbackUrl} />
    </I18nProvider>,
  );
}

describe("<CallbackMismatchNotice>", () => {
  const priorWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = {
      location: { origin: BROWSER_ORIGIN },
    };
  });

  afterEach(() => {
    if (priorWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = priorWindow;
    }
  });

  it("renders the warning when the configured callback origin differs from the browser origin", () => {
    const html = render("https://edge.example/api/whoop/callback");
    expect(html).toContain("WHOOP");
    expect(html).toContain("https://edge.example");
    expect(html).toContain(BROWSER_ORIGIN);
    expect(html).toContain("differs from this app address");
  });

  it("renders nothing when the callback origin matches the browser origin", () => {
    expect(render(`${BROWSER_ORIGIN}/api/whoop/callback`)).toBe("");
  });

  it("renders nothing when the server could not produce a callback URL", () => {
    expect(render(null)).toBe("");
  });

  it("renders nothing for a callback URL that is not absolute", () => {
    // The pre-fix client bundle produced exactly this shape and the notice
    // stayed silent; it still must, rather than throwing out of the card.
    expect(render("/api/whoop/callback")).toBe("");
  });
});
