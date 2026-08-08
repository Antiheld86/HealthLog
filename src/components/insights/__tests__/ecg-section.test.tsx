import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * `<EcgSection>` — the list of recorded strips.
 *
 * The load-bearing behaviour under test:
 *   - data-availability gating: the section un-mounts entirely when the user
 *     has no recordings or while the payload is in flight;
 *   - the reading cap: a device that records every morning accumulates
 *     hundreds of strips, and the list paints the most recent handful;
 *   - the device's verdict rides the timestamp as a tag, and a row that has
 *     a waveform opens the recording's own address.
 *
 * `useAuth` + TanStack Query are mocked and the assertions run through SSR
 * (the suite's node environment has no DOM), exactly like the sibling
 * `rhythm-events-card` test. `<EcgDetail>` has its own spec.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: vi.fn(() => ({ isAuthenticated: true, user: null })),
}));

const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
}));

const { EcgSection, ECG_LIST_LIMIT } = await import("../ecg-section");
type EcgRecordingListItem = import("../ecg-section").EcgRecordingListItem;

const IRREGULAR_REC: EcgRecordingListItem = {
  id: "ecg_1",
  recordedAt: "2026-06-01T09:15:00.000Z",
  durationSeconds: 30,
  samplingFrequency: 300,
  sampleCount: 9000,
  averageHeartRate: 72,
  lead: null,
  classification: "IRREGULAR",
  source: "WITHINGS",
  hasWaveform: true,
};

const NORMAL_REC: EcgRecordingListItem = {
  ...IRREGULAR_REC,
  id: "ecg_2",
  classification: "NOT_DETECTED",
};

function renderSection(
  data:
    { recordings: EcgRecordingListItem[]; hasRecordings: boolean } | undefined,
) {
  useQueryMock.mockReturnValue({ data, isLoading: false });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <EcgSection />
    </I18nProvider>,
  );
}

function countRows(html: string): number {
  return (html.match(/data-slot="ecg-row"/g) ?? []).length;
}

describe("<EcgSection>", () => {
  it("renders nothing before the payload resolves", () => {
    useQueryMock.mockReturnValue({ data: undefined, isLoading: true });
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <EcgSection />
      </I18nProvider>,
    );
    expect(html).toBe("");
  });

  it("renders nothing when the user has no recordings (data-availability gate)", () => {
    const html = renderSection({ recordings: [], hasRecordings: false });
    expect(html).toBe("");
  });

  it("renders one row per recording with the device result as a tag", () => {
    const html = renderSection({
      recordings: [IRREGULAR_REC, NORMAL_REC],
      hasRecordings: true,
    });
    expect(html).toContain('data-slot="ecg-card"');
    expect(html).toContain('data-slot="ecg-list"');
    expect(countRows(html)).toBe(2);
    expect(html).toContain("Atrial fibrillation detected");
    expect(html).toContain("No signs of atrial fibrillation");
    // The verdict sits beside the timestamp inside the row's own header
    // line, not on a line of its own beneath it.
    expect(html).toMatch(
      /<span[^>]*data-slot="ecg-row-result"[^>]*class="[^"]*rounded-full/,
    );
  });

  it("caps the list at the most recent handful", () => {
    // Eight strips in, five out — and the five are the ones the route
    // handed back first, which it orders `recordedAt desc`.
    const recordings = Array.from({ length: 8 }, (_, index) => ({
      ...NORMAL_REC,
      id: `ecg_${index}`,
      recordedAt: new Date(Date.UTC(2026, 5, 20 - index, 9, 15)).toISOString(),
    }));
    const html = renderSection({ recordings, hasRecordings: true });

    expect(ECG_LIST_LIMIT).toBe(5);
    expect(countRows(html)).toBe(ECG_LIST_LIMIT);
    for (const kept of recordings.slice(0, ECG_LIST_LIMIT)) {
      expect(html, `${kept.id} should be listed`).toContain(
        `/insights/ecg/${kept.id}`,
      );
    }
    for (const dropped of recordings.slice(ECG_LIST_LIMIT)) {
      expect(html, `${dropped.id} is past the cap`).not.toContain(
        `/insights/ecg/${dropped.id}`,
      );
    }
  });

  it("opens the recording's own address when it has a waveform", () => {
    const html = renderSection({
      recordings: [IRREGULAR_REC],
      hasRecordings: true,
    });
    expect(html).toContain('href="/insights/ecg/ecg_1"');
  });

  it("leaves a waveform-less recording unlinked", () => {
    const html = renderSection({
      recordings: [{ ...IRREGULAR_REC, hasWaveform: false }],
      hasRecordings: true,
    });
    expect(countRows(html)).toBe(1);
    expect(html).not.toContain('href="/insights/ecg/ecg_1"');
  });

  it("carries no intro paragraph and no disclaimer block", () => {
    // Both were removed: the page heading already says what the surface is,
    // and the device attribution on the detail page is where the "this is
    // the device's result" statement belongs.
    const html = renderSection({
      recordings: [IRREGULAR_REC],
      hasRecordings: true,
    });
    expect(html).not.toContain('data-slot="ecg-disclaimer"');
    expect(html).not.toContain("Single-lead ECG strips");
  });
});
