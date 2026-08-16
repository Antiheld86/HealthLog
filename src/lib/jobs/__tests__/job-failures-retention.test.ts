import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  JOB_FAILURE_WINDOW_HOURS,
  PG_BOSS_FAILED_ROW_AVAILABILITY_HOURS,
} from "@/lib/jobs/job-failures";

const PG_BOSS_ROOT = join(process.cwd(), "node_modules/pg-boss");

describe("pg-boss failed-row ledger retention", () => {
  it("pins the installed source assumptions behind the 72-hour reader", () => {
    const packageJson = JSON.parse(
      readFileSync(join(PG_BOSS_ROOT, "package.json"), "utf8"),
    ) as { version: string };
    const plans = readFileSync(join(PG_BOSS_ROOT, "dist/plans.js"), "utf8");

    expect(packageJson.version).toBe("12.27.0");
    expect(plans).toContain("retention_seconds: FORTEEN_DAYS");
    expect(plans).toContain("deletion_seconds: SEVEN_DAYS");
    expect(plans).toContain(
      "completed_on + deletion_seconds * interval '1s' < now()",
    );
    expect(JOB_FAILURE_WINDOW_HOURS).toBeLessThan(
      PG_BOSS_FAILED_ROW_AVAILABILITY_HOURS,
    );
  });
});
