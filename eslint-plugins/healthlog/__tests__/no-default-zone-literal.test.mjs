/**
 * Unit tests for the `healthlog/no-default-zone-literal` rule: the literal is
 * banned in application source, allowed in `src/lib/tz/` and in tests, and
 * the pending files are exempt until their owner switches them.
 */
import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../no-default-zone-literal.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("no-default-zone-literal", rule, {
  valid: [
    {
      code: 'import { DEFAULT_TIMEZONE } from "@/lib/tz/format"; const tz = user.timezone || DEFAULT_TIMEZONE;',
      filename: "/repo/src/app/api/insights/cards/route.ts",
    },
    {
      // The one definition.
      code: 'export const DEFAULT_TIMEZONE = "Europe/Berlin";',
      filename: "/repo/src/lib/tz/format.ts",
    },
    {
      // Fixtures pick a concrete zone on purpose.
      code: 'const TZ = "Europe/Berlin";',
      filename: "/repo/src/lib/insights/__tests__/graded-series.test.ts",
    },
    {
      // Comments are not checked.
      code: "// read on Europe/Berlin days before v1.39.3\nconst x = 1;",
      filename: "/repo/src/lib/insights/graded-series.ts",
    },
    {
      // Pending: owned by another change, switched at merge.
      code: 'const DEFAULT_TZ = "Europe/Berlin";',
      filename: "/repo/src/lib/medications/window-status.ts",
    },
    {
      code: 'const other = "America/New_York";',
      filename: "/repo/src/lib/insights/graded-series.ts",
    },
  ],
  invalid: [
    {
      code: 'const tz = user.timezone || "Europe/Berlin";',
      filename: "/repo/src/app/api/insights/cards/route.ts",
      errors: [{ messageId: "zoneLiteral" }],
    },
    {
      code: 'readDayAggregates({ timeZone: "Europe/Berlin" });',
      filename: "/repo/src/lib/insights/graded-series.ts",
      errors: [{ messageId: "zoneLiteral" }],
    },
    {
      code: "const label = `Date: ${todayKey} (Europe/Berlin)`;",
      filename: "/repo/src/lib/ai/prompts/pulse.ts",
      errors: [{ messageId: "zoneLiteral" }],
    },
    {
      code: '<input placeholder="Europe/Berlin" />',
      filename: "/repo/src/components/settings/timezone-picker.tsx",
      errors: [{ messageId: "zoneLiteral" }],
    },
  ],
});
