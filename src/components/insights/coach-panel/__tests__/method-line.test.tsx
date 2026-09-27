import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { CoachMethodLine } from "../method-line";

function render(node: React.ReactNode, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{node}</I18nProvider>,
  );
}

describe("<CoachMethodLine>", () => {
  it("renders nothing without a method", () => {
    expect(render(<CoachMethodLine method={null} />)).toBe("");
    expect(render(<CoachMethodLine method={{ entries: [], text: "" }} />)).toBe(
      "",
    );
  });

  it("renders the server text as a muted meta line", () => {
    const html = render(
      <CoachMethodLine
        method={{
          entries: [{ domain: "bp", window: "last90days", count: 142 }],
          text: "Blood pressure, last 90 days: 142 readings",
        }}
      />,
    );
    expect(html).toContain('data-slot="coach-method-line"');
    expect(html).toContain("text-muted-foreground text-xs");
    expect(html).toContain("How this was worked out:");
    expect(html).toContain("Blood pressure, last 90 days: 142 readings");
  });

  it("labels the line in the reader's locale", () => {
    const html = render(
      <CoachMethodLine method={{ entries: [], text: "Blutdruck" }} />,
      "de",
    );
    expect(html).toContain("Wie das ermittelt wurde:");
  });
});
