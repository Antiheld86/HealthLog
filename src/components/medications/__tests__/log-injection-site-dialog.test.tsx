/**
 * v1.11.5 — `<LogInjectionSiteDialog>` controlled-submit coverage.
 *
 * The dialog used to dismiss optimistically the instant Confirm fired —
 * before the parent's PATCH resolved and with no pending state. This suite
 * pins the controlled-dialog contract:
 *
 *   1. The dialog SSRs its skip / confirm footer (Confirm disabled until a
 *      site is picked).
 *   2. The confirm handler awaits the (possibly async) `onConfirm`, holding
 *      a `submitting` state, and `onOpenChange` refuses to close while a
 *      request is in flight.
 *
 * Project convention is SSR-only component tests (`renderToStaticMarkup`,
 * no `@testing-library/react`) plus source-string structural assertions for
 * the interactive plumbing an SSR mount can't exercise.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

// The Radix Dialog portals at runtime, so its body never materialises in
// static markup. Collapse the primitives to plain wrappers (same trick as
// the dose-history dialog suite) so the footer is reachable.
vi.mock("@/components/ui/dialog", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    Dialog: ({
      open,
      children,
    }: {
      open: boolean;
      children: React.ReactNode;
    }) => (open ? <div data-slot="mock-dialog">{children}</div> : null),
    DialogContent: Pass,
    DialogDescription: Pass,
    DialogFooter: Pass,
    DialogHeader: Pass,
    DialogTitle: Pass,
  };
});

const { LogInjectionSiteDialog } = await import("../log-injection-site-dialog");

function render(node: React.ReactNode, locale: "en" | "de" = "en"): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

const src = readFileSync(
  resolve(__dirname, "../log-injection-site-dialog.tsx"),
  "utf8",
);

describe("<LogInjectionSiteDialog>", () => {
  it("renders the skip / confirm footer with Confirm gated on a selection", () => {
    const html = render(
      <LogInjectionSiteDialog
        open
        medicationName="Mounjaro"
        allowedInjectionSites={[]}
        globalExcludedInjectionSites={[]}
        history={[]}
        onConfirm={vi.fn()}
        onSkip={vi.fn()}
      />,
    );
    expect(html).toContain("Save site");
    expect(html).toContain("Skip");
    // Confirm starts disabled (no site selected yet).
    expect(html).toMatch(/Save site/);
    expect(html).toContain("disabled");
  });

  it("awaits onConfirm behind a submitting guard and re-enables in finally", () => {
    expect(src).toContain(
      "const [submitting, setSubmitting] = useState(false)",
    );
    expect(src).toMatch(
      /async function handleConfirm\(\) \{[\s\S]*setSubmitting\(true\)[\s\S]*await onConfirm\(selected\)[\s\S]*finally \{[\s\S]*setSubmitting\(false\)/,
    );
  });

  it("refuses to close the dialog while a request is in flight", () => {
    expect(src).toMatch(
      /onOpenChange=\{\(next\) => \{[\s\S]*if \(submitting\) return;[\s\S]*if \(!next\) onSkip\(\)/,
    );
  });

  it("disables both footer buttons and shows a spinner while submitting", () => {
    expect(src).toMatch(/onClick=\{onSkip\} disabled=\{submitting\}/);
    expect(src).toContain("selected === null || submitting");
    expect(src).toContain("aria-busy={submitting || undefined}");
    expect(src).toContain("Loader2");
  });

  it("accepts an async onConfirm in its prop contract", () => {
    expect(src).toContain(
      "onConfirm: (site: InjectionSiteKey) => void | Promise<void>",
    );
  });
});
