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

  it("pins the queue defaults the data-backup window had to escape", () => {
    const plans = readFileSync(join(PG_BOSS_ROOT, "dist/plans.js"), "utf8");

    // These two lines are the whole story behind the weekly backup's "job
    // timed out": a pass with no send options gets fifteen minutes and two
    // redeliveries, so a snapshot that cannot finish in fifteen minutes gives
    // up 45 minutes later having never once completed. If a pg-boss upgrade
    // changes either default, `DATA_BACKUP_SEND_OPTIONS` deserves a re-read.
    expect(plans).toContain("expire_seconds: FIFTEEN_MINUTES");
    expect(plans).toContain("retry_limit: 2");
  });
});
