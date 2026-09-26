import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/context";

/**
 * v1.39.3 — the admin AI card names the deprecated
 * `ALLOW_LOCAL_AI_PRIVATE_HOSTS=true` and gives the exact
 * `AI_PRIVATE_ORIGINS` line to set instead, built from the origins the server
 * reports in use. Absent when the server reports no such grant.
 */

const state = vi.hoisted(() => ({ data: null as null | object }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: state.data }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { AiServerKeySection } from "../ai-server-key-section";

function render(): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <AiServerKeySection />
    </I18nProvider>,
  );
}

const base = {
  hasKey: false,
  keyPreview: null,
  model: "gpt-4o",
  baseUrl: "https://api.openai.com/v1",
};

describe("<AiServerKeySection> deprecated private-host notice", () => {
  it("shows the exact line to set, with every origin in use", () => {
    state.data = {
      ...base,
      legacyPrivateHostGrant: {
        originsInUse: ["http://10.0.0.5:11434", "http://gateway.lan:4000"],
      },
    };
    const html = render();
    expect(html).toContain('data-slot="admin-ai-legacy-private-hosts"');
    expect(html).toContain("is deprecated");
    expect(html).toContain(
      "AI_PRIVATE_ORIGINS=&quot;http://10.0.0.5:11434,http://gateway.lan:4000&quot;",
    );
  });

  it("says the setting can go when no saved URL needs it", () => {
    state.data = { ...base, legacyPrivateHostGrant: { originsInUse: [] } };
    const html = render();
    expect(html).toContain("you can remove ALLOW_LOCAL_AI_PRIVATE_HOSTS now");
    expect(html).not.toContain("admin-ai-legacy-private-hosts-line");
  });

  it("is absent when the server reports no deprecated grant", () => {
    state.data = { ...base, legacyPrivateHostGrant: null };
    expect(render()).not.toContain("admin-ai-legacy-private-hosts");
  });
});
