import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";

/**
 * `<EcgDetail>` — one recording, addressed by id.
 *
 * The non-diagnostic framing is the load-bearing part and it is unchanged by
 * the move to a route: the result shown is the DEVICE's, attributed to the
 * device, and a non-normal device result adds the "discuss with a clinician"
 * note while a normal one does not.
 *
 * What did change: the component reads by id rather than being handed a row
 * from the list, so a cold deep link works — the positive control below is
 * that a render with only an id in hand still paints the trace.
 */

const useQueryMock = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
}));

const { EcgDetail } = await import("../ecg-detail");
type EcgDetailResponse = import("../ecg-detail").EcgDetailResponse;

const DETAIL: EcgDetailResponse = {
  recordedAt: "2026-06-01T09:15:00.000Z",
  durationSeconds: 30,
  samplingFrequency: 300,
  averageHeartRate: 72,
  lead: null,
  classification: "IRREGULAR",
  source: "WITHINGS",
  samples: [0, 10, -5, 40, -20, 5, 0],
  decimated: true,
};

function renderDetail(detail: Partial<EcgDetailResponse> = {}) {
  useQueryMock.mockReturnValue({
    data: { ...DETAIL, ...detail },
    isLoading: false,
    isError: false,
  });
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <EcgDetail recordingId="ecg_1" />
    </I18nProvider>,
  );
}

describe("<EcgDetail> — non-diagnostic framing", () => {
  it("attributes the result to the recording device and draws the waveform", () => {
    const html = renderDetail();
    expect(html).toContain('data-slot="ecg-detail"');
    expect(html).toContain('data-slot="ecg-result"');
    // Load-bearing: the verdict is the device's, attributed to the device.
    expect(html).toContain("as reported by the recording device");
    expect(html).toContain("Atrial fibrillation detected");
    expect(html).toContain('data-slot="ecg-trace"');
  });

  it("adds the 'discuss with a clinician' note on a non-normal result", () => {
    const html = renderDetail();
    expect(html).toContain('data-slot="ecg-clinician-note"');
    expect(html).toContain("discuss this recording with a clinician");
  });

  it("adds the clinician note for an INCONCLUSIVE result", () => {
    const html = renderDetail({ classification: "INCONCLUSIVE" });
    expect(html).toContain('data-slot="ecg-clinician-note"');
  });

  it("does NOT add the clinician note for a normal (not-detected) result", () => {
    const html = renderDetail({ classification: "NOT_DETECTED" });
    expect(html).not.toContain('data-slot="ecg-clinician-note"');
    // The device attribution is still there.
    expect(html).toContain("as reported by the recording device");
  });

  it("shows a recoverable read failure instead of painting an empty recording", () => {
    useQueryMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <EcgDetail recordingId="ecg_1" />
      </I18nProvider>,
    );
    // The failure is a recoverable card, not a muted "no data" line.
    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain('data-slot="query-error-retry"');
    expect(html).not.toContain('data-slot="ecg-trace"');
  });
});
