import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

type Provider = "google_health" | "withings";
type UserStatus = "complete" | "partial" | "failed" | "parked" | "skipped";

type UserVerdict = {
  status: UserStatus;
  imported: number;
  downstreamFailed?: boolean;
  retryable?: boolean;
  reasonCode?: string;
};

type CohortFacts = {
  provider: Provider;
  outcome: "useful" | "clean_zero";
  total: number;
  users_synced: number;
  users_complete: number;
  users_partial: number;
  users_failed: number;
  users_parked: number;
  users_skipped: number;
  users_useful: number;
  users_clean_zero: number;
  users_retryable: number;
  downstream_failed: number;
  measurements_imported: number;
};

type CohortSubject = {
  foldIntegrationCohortOutcomes(input: {
    provider: Provider;
    verdicts: readonly UserVerdict[];
  }): { ok: true; did: CohortFacts };
};

function loadSubject(): Promise<CohortSubject> {
  return vi.importActual<CohortSubject>("@/lib/jobs/reminder/poll-cohort");
}

const googleHandlerSource = readFileSync(
  join(process.cwd(), "src/lib/jobs/reminder/google-health-sync.ts"),
  "utf8",
);
const googleSyncSource = readFileSync(
  join(process.cwd(), "src/lib/google-health/sync.ts"),
  "utf8",
);
const withingsHandlerSource = readFileSync(
  join(process.cwd(), "src/lib/jobs/reminder/withings-sync.ts"),
  "utf8",
);

describe("provider handlers use the truthful verdict fold", () => {
  it("does not discard Google Health's resolved failed verdict", () => {
    expect(googleSyncSource).not.toMatch(
      /syncUserGoogleHealth\(userId\)\.then\(\(r\)\s*=>\s*r\.imported\)/,
    );
    expect(googleHandlerSource).toMatch(/foldIntegrationCohortOutcomes/);
  });

  it("does not count every resolved Withings call as synced unconditionally", () => {
    expect(withingsHandlerSource).toMatch(/foldIntegrationCohortOutcomes/);
    expect(withingsHandlerSource).not.toMatch(
      /(?:syncUserMeasurements|syncUserActivity|syncUserSleep|syncUserEcg)[\s\S]{0,180}usersSynced\+\+/,
    );
  });
});

describe.each(["google_health", "withings"] as const)(
  "%s truthful integration cohort outcomes",
  (provider) => {
    it("classifies complete, partial, failed, parked, and skipped users separately", async () => {
      const { foldIntegrationCohortOutcomes } = await loadSubject();
      const outcome = foldIntegrationCohortOutcomes({
        provider,
        verdicts: [
          { status: "complete", imported: 3 },
          {
            status: "partial",
            imported: 2,
            downstreamFailed: true,
            retryable: true,
            reasonCode: "rollup_failed",
          },
          {
            status: "failed",
            imported: 0,
            retryable: true,
            reasonCode: "provider_unavailable",
          },
          {
            status: "parked",
            imported: 0,
            reasonCode: "reauth_required",
          },
          { status: "skipped", imported: 0, reasonCode: "not_configured" },
        ],
      });

      expect(outcome).toEqual({
        ok: true,
        did: {
          provider,
          outcome: "useful",
          total: 5,
          users_synced: 1,
          users_complete: 1,
          users_partial: 1,
          users_failed: 1,
          users_parked: 1,
          users_skipped: 1,
          users_useful: 2,
          users_clean_zero: 0,
          users_retryable: 2,
          downstream_failed: 1,
          measurements_imported: 5,
        },
      });
      expect(
        outcome.did.users_complete +
          outcome.did.users_partial +
          outcome.did.users_failed +
          outcome.did.users_parked +
          outcome.did.users_skipped,
      ).toBe(outcome.did.total);
    });

    it("counts a fully successful zero-write user as clean zero, not useful work", async () => {
      const { foldIntegrationCohortOutcomes } = await loadSubject();
      const outcome = foldIntegrationCohortOutcomes({
        provider,
        verdicts: [{ status: "complete", imported: 0 }],
      });

      expect(outcome.did).toMatchObject({
        provider,
        outcome: "clean_zero",
        total: 1,
        users_synced: 1,
        users_complete: 1,
        users_useful: 0,
        users_clean_zero: 1,
        measurements_imported: 0,
      });
    });

    it.each([
      ["failed", true],
      ["parked", false],
      ["skipped", false],
    ] as const)(
      "never counts a %s user as synced",
      async (status, retryable) => {
        const { foldIntegrationCohortOutcomes } = await loadSubject();
        const outcome = foldIntegrationCohortOutcomes({
          provider,
          verdicts: [{ status, imported: 0, retryable }],
        });

        expect(outcome.did.users_synced).toBe(0);
        expect(outcome.did[`users_${status}`]).toBe(1);
        expect(outcome.did.users_retryable).toBe(retryable ? 1 : 0);
      },
    );

    it("marks raw writes plus a rollup/downstream failure as partial and retryable", async () => {
      const { foldIntegrationCohortOutcomes } = await loadSubject();
      const outcome = foldIntegrationCohortOutcomes({
        provider,
        verdicts: [
          {
            status: "partial",
            imported: 7,
            downstreamFailed: true,
            retryable: true,
            reasonCode: "rollup_failed",
          },
        ],
      });

      expect(outcome.did).toMatchObject({
        outcome: "useful",
        users_synced: 0,
        users_partial: 1,
        users_retryable: 1,
        downstream_failed: 1,
        measurements_imported: 7,
      });
    });

    it("never emits per-user identifiers, PII, secrets, URLs, raw errors, or health values", async () => {
      const { foldIntegrationCohortOutcomes } = await loadSubject();
      const privateVerdict = {
        status: "failed",
        imported: 0,
        retryable: false,
        reasonCode: "provider_failed",
        userId: "user-private-123",
        email: "patient@example.test",
        accessToken: "secret-token",
        url: "https://provider.test/capability?token=secret",
        rawError: new Error("blood glucose=411"),
        healthValue: 411,
      } as UserVerdict;

      const serialized = JSON.stringify(
        foldIntegrationCohortOutcomes({
          provider,
          verdicts: [privateVerdict],
        }),
      );
      expect(serialized).not.toMatch(
        /user-private|patient@|secret-token|provider\.test|blood glucose|411|rawError|healthValue/i,
      );
    });

    it("folds a high-volume cohort into one fixed bounded scalar payload", async () => {
      const { foldIntegrationCohortOutcomes } = await loadSubject();
      const verdicts = Array.from({ length: 10_000 }, (_, index) => ({
        status: index % 2 === 0 ? ("complete" as const) : ("skipped" as const),
        imported: index % 2 === 0 ? 1 : 0,
      }));

      const outcome = foldIntegrationCohortOutcomes({ provider, verdicts });
      expect(Object.keys(outcome.did).sort()).toEqual(
        [
          "downstream_failed",
          "measurements_imported",
          "outcome",
          "provider",
          "total",
          "users_clean_zero",
          "users_complete",
          "users_failed",
          "users_parked",
          "users_partial",
          "users_retryable",
          "users_skipped",
          "users_synced",
          "users_useful",
        ].sort(),
      );
      expect(
        Object.values(outcome.did).every((value) => {
          return (
            typeof value === "string" ||
            (typeof value === "number" &&
              Number.isSafeInteger(value) &&
              value >= 0)
          );
        }),
      ).toBe(true);
      expect(JSON.stringify(outcome).length).toBeLessThan(1_024);
    });
  },
);
