import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { TagChip } from "../tag-chip";

describe("<TagChip>", () => {
  it("renders the neutral chip shape on the text-2xs token", () => {
    const html = renderToStaticMarkup(<TagChip>Glucose</TagChip>);
    expect(html).toContain("Glucose");
    expect(html).toContain('data-slot="tag-chip"');
    expect(html).toContain("bg-muted");
    expect(html).toContain("text-foreground");
    expect(html).toContain("rounded-full");
    expect(html).toContain("text-2xs");
    // The arbitrary value the three hand-copied sites carried is gone.
    expect(html).not.toContain("text-[0.6875rem]");
  });

  it("merges caller classes and forwards span props", () => {
    const html = renderToStaticMarkup(
      <TagChip className="ml-2" title="source label">
        Steps
      </TagChip>,
    );
    expect(html).toContain("ml-2");
    expect(html).toContain('title="source label"');
    // The base shape survives the merge.
    expect(html).toContain("rounded-full");
  });
});
