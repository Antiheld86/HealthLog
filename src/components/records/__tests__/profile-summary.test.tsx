import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { ProfileSummary } from "../profile-summary";

describe("ProfileSummary", () => {
  it("renders bounded profile information without mutation controls", () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <ProfileSummary
          summary={{
            allergies: [{ substance: "Pollen", category: "OTHER" }],
            familyHistory: [
              { condition: "Hypertension", relationship: "PARENT" },
            ],
            facts: [{ label: "Smoking", value: "Never" }],
          }}
        />
      </I18nProvider>,
    );

    expect(html).toContain('data-slot="profile-summary"');
    expect(html).toContain("Pollen");
    expect(html).toContain("Hypertension");
    expect(html).toContain("Smoking");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });
});
