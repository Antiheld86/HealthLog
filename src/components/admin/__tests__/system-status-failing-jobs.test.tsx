import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import { FailingJobsCard } from "../system-status-section";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

describe("FailingJobsCard", () => {
  it("renders named exhausted-retry failures from failingJobs", () => {
    const html = render(
      <FailingJobsCard
        failingJobs={{
          windowHours: 72,
          queues: [
            {
              queue: "environment-fetch",
              failures: 2,
              lastFailedAt: "2026-07-28T12:00:00.000Z",
              lastError: "upstream unavailable",
            },
          ],
        }}
      />,
    );

    expect(html).toContain("environment-fetch");
    expect(html).toContain("2 failures");
    expect(html).toContain("upstream unavailable");
    expect(html).toContain('data-testid="failing-jobs-list"');
  });

  it("distinguishes an unavailable queue ledger from an empty one", () => {
    const unavailable = render(<FailingJobsCard failingJobs={null} />);
    const empty = render(
      <FailingJobsCard failingJobs={{ windowHours: 72, queues: [] }} />,
    );

    expect(unavailable).toContain("No job queue to read");
    expect(unavailable).not.toContain('data-testid="failing-jobs-none"');
    expect(empty).toContain('data-testid="failing-jobs-none"');
    expect(empty).toContain("No job has failed in the last 72 hours.");
  });
});
