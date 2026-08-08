import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The floating bulk bar, pinned via single-pass static renders: a labelled
 * toolbar carrying the selected count and the bulk verbs (set type, link
 * condition, file against a visit, share, delete, clear). Each link menu only
 * renders when the account actually has something to link to — no dead
 * affordance on an account with no episodes, and none on an account with no
 * visits either.
 */
import { I18nProvider } from "@/lib/i18n/context";
import { DocumentBulkBar } from "../document-bulk-bar";

function render(
  episodes: { id: string; label: string }[],
  encounters: { id: string; label: string }[] = [
    { id: "v1", label: "Routine visit · 01/08/2026" },
  ],
) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DocumentBulkBar
        selectedCount={3}
        episodes={episodes}
        encounters={encounters}
        busy={false}
        onSetKind={() => {}}
        onLinkEpisode={() => {}}
        onLinkEncounter={() => {}}
        onShare={() => {}}
        onDelete={() => {}}
        onClear={() => {}}
      />
    </I18nProvider>,
  );
}

describe("<DocumentBulkBar>", () => {
  it("renders a labelled toolbar with count and the bulk verbs", () => {
    const html = render([{ id: "ep1", label: "Knee" }]);
    expect(html).toContain('data-slot="document-bulk-bar"');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain("3 selected");
    expect(html).toContain("Change type");
    expect(html).toContain("Link condition");
    expect(html).toContain("File against visit");
    expect(html).toContain('data-slot="document-bulk-share"');
    expect(html).toContain("Share");
    expect(html).toContain("Delete");
    expect(html).toContain("Clear selection");
  });

  it("omits the link-condition verb when the account has no episodes", () => {
    const html = render([]);
    expect(html).not.toContain("Link condition");
    expect(html).toContain("Change type");
  });

  it("omits the file-against-visit verb when the account has no visits", () => {
    const html = render([{ id: "ep1", label: "Knee" }], []);
    expect(html).not.toContain("File against visit");
    expect(html).not.toContain('data-slot="document-bulk-link-visit"');
    // The positive control: the neighbouring verb is still there, so the
    // assertion above is about the visit menu and not about an empty render.
    expect(html).toContain("Link condition");
  });
});
