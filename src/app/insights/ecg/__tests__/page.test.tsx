import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.30 (UX/IA audit H1) — `/insights/ecg` routed sub-page.
 *
 * The page reuses `<EcgSection>` (verbatim, `hideHeading` set so the shell
 * owns the heading) and self-gates to an empty state when the account has no
 * recordings. `useAuth` is mocked; the shared `insightsEcgList` cache is
 * pre-seeded so both the page probe and the section read the same payload.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true, user: null }),
}));

import InsightsEcgPage from "../page";

interface EcgRecord {
  id: string;
  recordedAt: string;
  durationSeconds: number | null;
  samplingFrequency: number;
  sampleCount: number;
  averageHeartRate: number | null;
  lead: string | null;
  classification: "IRREGULAR" | "NOT_DETECTED" | "INCONCLUSIVE" | null;
  source: string;
  hasWaveform: boolean;
}

function seededRecording(): EcgRecord {
  return {
    id: "rec-1",
    recordedAt: "2026-07-10T08:00:00.000Z",
    durationSeconds: 30,
    samplingFrequency: 300,
    sampleCount: 9000,
    averageHeartRate: 62,
    lead: null,
    classification: null,
    source: "withings",
    hasWaveform: true,
  };
}

function render(data: { recordings: EcgRecord[]; hasRecordings: boolean }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(queryKeys.insightsEcgList(), data);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <InsightsEcgPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("/insights/ecg page (H1)", () => {
  it("renders the EcgSection when recordings exist", () => {
    const html = render({
      recordings: [seededRecording()],
      hasRecordings: true,
    });
    expect(html).toContain('data-slot="ecg-section"');
    expect(html).toContain('data-slot="ecg-card"');
    // The shell owns the page heading (`<h1>`); the section's own
    // `<SectionHeading>` (`<h2>`) is suppressed via `hideHeading`.
    expect(html).toContain('id="insights-subpage-title"');
    expect(html).not.toContain("<h2");
  });

  it("carries no disclaimer paragraph above the list", () => {
    // Two muted lines used to lead this page — one from the shell's own
    // explainer slot and one hand-rolled beneath it, both saying HealthLog
    // does not read the curve. The page opens on the recordings now.
    const html = render({
      recordings: [seededRecording()],
      hasRecordings: true,
    });
    expect(html).not.toContain('data-slot="ecg-disclaimer"');
    expect(html).not.toContain("is not interpreted");
  });

  it("shows the empty state (no section) when the account has no recordings", () => {
    const html = render({ recordings: [], hasRecordings: false });
    expect(html).not.toContain('data-slot="ecg-section"');
    expect(html).toContain("No ECG recordings yet");
    // The empty-state CTA points at the integrations surface.
    expect(html).toContain('href="/settings/integrations"');
  });
});
