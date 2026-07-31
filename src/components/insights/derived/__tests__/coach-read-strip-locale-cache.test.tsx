import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { I18nProvider } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import type { CoachReadStripData } from "@/lib/insights/derived/coach-read-shape";

/**
 * A cached strip belongs to ONE language.
 *
 * The strip's second line is prose the server writes in the reader's language.
 * The browser cache used to key it by metric alone, so after a language switch
 * the page re-used the sentence written for the previous language and the
 * server-side fix would have been invisible to anyone who switched rather than
 * reloaded. `/api/analytics` carries the same warning in its own cache key.
 *
 * Both entries are seeded, so a key that has stopped separating them shows up
 * as the WRONG sentence rather than as an empty page — a test that only proved
 * "the other locale misses" would also pass if the key stopped matching
 * anything at all.
 */

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { timezone: "UTC", dateOfBirth: null, gender: null },
    isAuthenticated: true,
  }),
}));

// The strip paints nothing until it is client-mounted (React #418).
vi.mock("@/hooks/use-mounted", () => ({ useMounted: () => true }));

import { CoachReadStrip } from "../coach-read-strip";

const GERMAN_NOTE =
  "Wenn die Symptomstärke höher liegt, scheint die Schlafdauer am Folgetag " +
  "nach bisheriger Datenlage eher niedriger auszufallen — ein Muster, das " +
  "Beachtung verdient, keine Ursache.";
const ENGLISH_NOTE =
  "Higher symptom severity looks like it goes with lower next-day sleep " +
  "duration in your data, on the evidence so far — a pattern worth watching, " +
  "not a cause.";

function payload(note: string): CoachReadStripData {
  return {
    baseline: null,
    learning: true,
    driver: { note, behaviour: "symptom severity", outcome: "sleep duration" },
  };
}

const METRIC = "SLEEP_DURATION";

/**
 * One client holding BOTH languages' entries — the state a person is in the
 * instant after switching language on a page they had already loaded.
 */
function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    queryKeys.insightsCoachRead(METRIC, "de"),
    payload(GERMAN_NOTE),
  );
  client.setQueryData(
    queryKeys.insightsCoachRead(METRIC, "en"),
    payload(ENGLISH_NOTE),
  );
  return client;
}

function renderStrip(client: QueryClient, locale: "de" | "en"): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <CoachReadStrip metricType={METRIC} unit="h" />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe("CoachReadStrip — a cached strip is not served to another language", () => {
  it("reads the German entry for a German reader", () => {
    const markup = renderStrip(seededClient(), "de");
    expect(markup).toContain(GERMAN_NOTE);
    expect(markup).not.toContain(ENGLISH_NOTE);
  });

  it("reads the English entry for an English reader", () => {
    const markup = renderStrip(seededClient(), "en");
    expect(markup).toContain(ENGLISH_NOTE);
    expect(markup).not.toContain(GERMAN_NOTE);
  });

  it("does not carry one language's cached sentence into the other on a switch", () => {
    // One client, both renders — exactly what a language switch does to a page
    // that is already warm.
    const client = seededClient();
    const german = renderStrip(client, "de");
    const english = renderStrip(client, "en");

    expect(german).toContain(GERMAN_NOTE);
    expect(english).toContain(ENGLISH_NOTE);
    expect(english).not.toContain(GERMAN_NOTE);
  });
});
