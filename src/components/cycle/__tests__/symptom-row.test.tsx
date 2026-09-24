/**
 * Selecting a symptom must not move anything on the sheet (#1001 follow-up).
 *
 * The intensity selector used to appear inline beside a symptom chip in a
 * wrapping row, so a selection widened the chip and pushed the chips after it
 * along, sometimes out from under the finger reaching for the intensity. A
 * symptom is now one row with its intensity beside it, and the intensity's
 * space is laid out whether or not it is shown. What the test pins is exactly
 * that: the selected and unselected row render the same boxes, the intensity
 * group is present in both, and only its visibility and the colours change.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Droplet } from "lucide-react";

vi.mock("../use-cycle", () => ({
  useDeleteCustomSymptom: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { SymptomRow } from "../log-day-sheet";

function render(active: boolean, severity: number | null = null): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SymptomRow
        symptomKey="cramps"
        icon={Droplet}
        label="Cramps"
        active={active}
        severity={severity}
        onToggle={() => {}}
        onSeverity={() => {}}
      />
    </I18nProvider>,
  );
}

/** The markup with every class and state attribute removed: the box tree. */
function skeleton(html: string): string {
  return html
    .replace(/ class="[^"]*"/g, "")
    .replace(/ (aria-[a-z]+|data-active|disabled|tabindex)(="[^"]*")?/g, "");
}

function severityGroup(html: string): string {
  const m = /<div[^>]*data-slot="cycle-symptom-severity"[^>]*>/.exec(html);
  if (!m) throw new Error("no severity group rendered");
  return m[0];
}

describe("<SymptomRow>", () => {
  it("lays out the same boxes whether or not the symptom is selected", () => {
    expect(skeleton(render(true, 2))).toBe(skeleton(render(false)));
  });

  it("reserves the intensity's space while hidden, and reveals it in place", () => {
    const idle = severityGroup(render(false));
    const picked = severityGroup(render(true));
    expect(idle).toContain("invisible");
    expect(idle).toContain('aria-hidden="true"');
    expect(picked).not.toContain("invisible");
    expect(picked).not.toContain("aria-hidden");
  });

  it("keeps the intensity optional and out of reach until the symptom is picked", () => {
    const idle = render(false);
    // Four levels exist in both states, none of them focusable while hidden.
    expect(idle.match(/aria-label="Severity \d of 4"/g)).toHaveLength(4);
    expect(idle.match(/tabindex="-1"/g)).toHaveLength(4);
    const picked = render(true);
    expect(picked).not.toContain('tabindex="-1"');
    expect(picked.match(/aria-pressed="true"/g)).toHaveLength(1);
  });
});
