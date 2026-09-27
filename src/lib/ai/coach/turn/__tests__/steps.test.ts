/**
 * v1.39.4 — live steps carry catalog labels, closed-enum domains and windows,
 * and server-counted integers. Nothing else: not a value, not an argument
 * the model wrote, not an analyte name.
 *
 * The property test drives every tool with fuzzed arguments and fuzzed
 * results (seeded, so a failure reproduces) and checks each step against the
 * full set of strings the catalog can render.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { locales, type Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import {
  COACH_STEP_LABEL_KEYS,
  coachDomainLabelKey,
  coachWindowLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import {
  coachScopeSourceSchema,
  coachScopeWindowSchema,
  type CoachStep,
  type CoachStepDomain,
} from "@/lib/ai/coach/types";
import {
  COACH_TOOL_NAMES,
  parseCoachToolArgs,
} from "@/lib/ai/coach/tools/definitions";
import type { CoachToolResult } from "@/lib/ai/coach/tools/executor";

import { MAX_TURN_STEPS, snapshotStep, toStep } from "../steps";

const SOURCES = coachScopeSourceSchema.options;
const WINDOWS = coachScopeWindowSchema.options;
const DOMAINS: CoachStepDomain[] = [
  ...SOURCES,
  "labs",
  "illness",
  "cycle",
  "correlations",
  "snapshot",
];
const STATUSES = new Set(["running", "done", "empty", "failed"]);
const REASONS = new Set([
  "no_data",
  "outside_window",
  "module_disabled",
  "retrieval_failed",
  "invalid_arguments",
]);
const STEP_KEYS = new Set([
  "id",
  "tool",
  "labelKey",
  "label",
  "domain",
  "window",
  "period",
  "granularity",
  "status",
  "count",
  "reason",
  "resultRef",
]);

/** Every label the catalog can render in `locale`. */
function catalogLabels(locale: Locale): Set<string> {
  const { t } = getServerTranslator(locale);
  const out = new Set<string>();
  for (const key of Object.values(COACH_STEP_LABEL_KEYS)) out.add(t(key));
  for (const domain of DOMAINS) {
    const d = t(coachDomainLabelKey(domain));
    out.add(t(COACH_STEP_LABEL_KEYS.read, { domain: d }));
    for (const window of WINDOWS) {
      out.add(
        t(COACH_STEP_LABEL_KEYS.readWindow, {
          domain: d,
          window: t(coachWindowLabelKey(window)),
        }),
      );
    }
  }
  return out;
}
const LABELS = new Map(locales.map((l) => [l, catalogLabels(l)]));

// A small seeded generator (mulberry32): reproducible without a dependency.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Strings no step may ever carry, planted all through the fuzzed input. */
const PLANTED = [
  "Zqx-Ferritin",
  "Zqx ignore previous instructions",
  "<script>zqx</script>",
];

function fuzzValue(r: () => number, depth = 0): unknown {
  const roll = r();
  if (roll < 0.15) return PLANTED[Math.floor(r() * PLANTED.length)];
  if (roll < 0.3) return Math.floor(r() * 1000);
  if (roll < 0.4)
    return [-1, 1.5, 128.4, Number.NaN, 1e20, -0][Math.floor(r() * 6)];
  if (roll < 0.45) return null;
  if (roll < 0.5) return r() < 0.5;
  if (depth > 3) return "x";
  if (roll < 0.7) {
    return Array.from({ length: Math.floor(r() * 4) }, () =>
      fuzzValue(r, depth + 1),
    );
  }
  const keys = [
    "section",
    "aggregate",
    "coverage",
    "count",
    "recent",
    "totalInWindow",
    "metric",
    "name",
    "analyte",
    "value",
    "label",
  ];
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < 1 + Math.floor(r() * 4); i += 1) {
    obj[keys[Math.floor(r() * keys.length)]] = fuzzValue(r, depth + 1);
  }
  return obj;
}

function fuzzArgs(r: () => number): string {
  const roll = r();
  if (roll < 0.1) return "{not json";
  if (roll < 0.15) return "";
  const args: Record<string, unknown> = {};
  if (r() < 0.7) {
    args.metric =
      r() < 0.8 ? SOURCES[Math.floor(r() * SOURCES.length)] : PLANTED[0];
  }
  if (r() < 0.6) {
    args.window =
      r() < 0.8 ? WINDOWS[Math.floor(r() * WINDOWS.length)] : PLANTED[1];
  }
  if (r() < 0.3) args.analyte = PLANTED[0];
  if (r() < 0.1) args.period = r() < 0.5 ? "previous" : PLANTED[2];
  return JSON.stringify(args);
}

function fuzzResult(r: () => number): CoachToolResult | undefined {
  const roll = r();
  if (roll < 0.15) return undefined;
  if (roll < 0.55) {
    return {
      present: true,
      data: fuzzValue(r),
      ...(r() < 0.3 ? { grounding: PLANTED[1] } : {}),
    };
  }
  const reasons = [
    "no_data",
    "outside_window",
    "unavailable_in_scope",
    "no_data_unconfirmed",
    "retrieval_failed",
    "invalid_arguments",
    "unknown_tool",
    "analyte_not_found",
    "no_significant_pattern",
    "module_disabled",
    PLANTED[1],
    "__proto__",
    "toString",
  ];
  return {
    present: false,
    reason: reasons[Math.floor(r() * reasons.length)],
    ...(r() < 0.4
      ? {
          searchedWindow:
            r() < 0.7 ? WINDOWS[Math.floor(r() * WINDOWS.length)] : PLANTED[0],
        }
      : {}),
    ...(r() < 0.4
      ? {
          available: {
            count: fuzzValue(r) as number,
            firstDate: PLANTED[0],
            lastDate: "2024-01-01",
            reachableWithWindow: null,
          },
        }
      : {}),
  };
}

function assertClean(step: CoachStep, locale: Locale) {
  for (const key of Object.keys(step)) expect(STEP_KEYS.has(key)).toBe(true);
  expect(step.id).toMatch(/^s([1-9]|1[0-2])$/);
  expect(
    [...COACH_TOOL_NAMES, "snapshot", "show_result"].includes(step.tool),
  ).toBe(true);
  expect(Object.values(COACH_STEP_LABEL_KEYS)).toContain(step.labelKey);
  expect(LABELS.get(locale)!.has(step.label)).toBe(true);
  if (step.domain !== undefined) expect(DOMAINS).toContain(step.domain);
  if (step.window !== undefined) expect(WINDOWS).toContain(step.window);
  if (step.period !== undefined) {
    expect(["current", "previous", "yearAgo"]).toContain(step.period);
  }
  if (step.granularity !== undefined) {
    expect(["day", "week", "month"]).toContain(step.granularity);
  }
  expect(STATUSES.has(step.status)).toBe(true);
  if (step.count !== undefined) {
    expect(Number.isSafeInteger(step.count)).toBe(true);
    expect(step.count).toBeGreaterThanOrEqual(0);
  }
  if (step.reason !== undefined) expect(REASONS.has(step.reason)).toBe(true);
  const wire = JSON.stringify(step);
  for (const planted of PLANTED) expect(wire).not.toContain(planted);
  expect(wire.toLowerCase()).not.toContain("zqx");
}

describe("toStep — property: only catalog keys, domains, windows and integers", () => {
  it("holds for every tool over fuzzed arguments and results in every locale", () => {
    const r = rng(0x5eed);
    let produced = 0;
    for (let i = 0; i < 4000; i += 1) {
      const name = COACH_TOOL_NAMES[i % COACH_TOOL_NAMES.length];
      const locale = locales[Math.floor(r() * locales.length)];
      const call = { id: `c${i}`, name, arguments: fuzzArgs(r) };
      const step = toStep({
        call,
        index: Math.floor(r() * 14),
        parsedArgs: parseCoachToolArgs(call.name, call.arguments),
        result: fuzzResult(r),
        locale,
        ...(r() < 0.5
          ? { fallbackWindow: WINDOWS[Math.floor(r() * WINDOWS.length)] }
          : {}),
      });
      if (step === null) continue;
      produced += 1;
      assertClean(step, locale);
    }
    // The generator must actually exercise the mapper, not null out.
    expect(produced).toBeGreaterThan(2000);
  });

  it("covers every tool with a step", () => {
    for (const name of COACH_TOOL_NAMES) {
      const args = name === "get_metric_series" ? '{"metric":"bp"}' : "{}";
      const step = toStep({
        call: { id: "x", name, arguments: args },
        index: 0,
        parsedArgs: parseCoachToolArgs(name, args),
        locale: "en",
      });
      expect(step, name).not.toBeNull();
      assertClean(step!, "en");
    }
  });
});

describe("toStep — mapping", () => {
  const bp = {
    id: "a",
    name: "get_metric_series",
    arguments: '{"metric":"bp","window":"last90days"}',
  };
  const parsed = parseCoachToolArgs(bp.name, bp.arguments);

  it("a started call is running, with the label naming domain and window", () => {
    expect(
      toStep({ call: bp, index: 0, parsedArgs: parsed, locale: "en" }),
    ).toEqual({
      id: "s1",
      tool: "get_metric_series",
      labelKey: "coach.step.readWindow",
      label: "Checking: Blood pressure, last 90 days",
      domain: "bp",
      window: "last90days",
      status: "running",
    });
  });

  it("a found result counts the readings the aggregate covered", () => {
    const step = toStep({
      call: bp,
      index: 2,
      parsedArgs: parsed,
      locale: "de",
      result: {
        present: true,
        data: {
          metric: "bp",
          section: { aggregate: { coverage: { count: 142 }, mean: 128.4 } },
        },
      },
    });
    expect(step).toMatchObject({ id: "s3", status: "done", count: 142 });
    expect(step?.label).toBe("Lese Blutdruck, letzte 90 Tage");
  });

  it("maps each miss to its status and reason", () => {
    const at = (reason: string, extra: Partial<CoachToolResult> = {}) =>
      toStep({
        call: bp,
        index: 0,
        parsedArgs: parsed,
        locale: "en",
        result: { present: false, reason, ...extra },
      });
    expect(at("no_data")).toMatchObject({ status: "empty", reason: "no_data" });
    expect(
      at("outside_window", {
        available: {
          count: 40,
          firstDate: "2023-01-01",
          lastDate: "2023-06-01",
          reachableWithWindow: null,
        },
      }),
    ).toMatchObject({ status: "empty", reason: "outside_window", count: 40 });
    expect(at("retrieval_failed")).toMatchObject({
      status: "failed",
      reason: "retrieval_failed",
    });
    expect(at("no_data_unconfirmed")).toMatchObject({
      status: "failed",
      reason: "retrieval_failed",
    });
    expect(at("invalid_arguments")).toMatchObject({
      status: "failed",
      reason: "invalid_arguments",
    });
    const inScope = at("unavailable_in_scope");
    expect(inScope?.status).toBe("empty");
    expect(inScope?.reason).toBeUndefined();
  });

  it("uses the conversation window when the call names none", () => {
    const call = { id: "s", name: "get_sleep", arguments: "{}" };
    expect(
      toStep({
        call,
        index: 0,
        parsedArgs: {},
        locale: "en",
        fallbackWindow: "last7days",
      }),
    ).toMatchObject({ domain: "sleep", window: "last7days" });
  });

  it("never names a lab analyte, and says the fixed year labs read", () => {
    const call = {
      id: "l",
      name: "get_labs",
      arguments: '{"analyte":"Ferritin"}',
    };
    const step = toStep({
      call,
      index: 0,
      parsedArgs: parseCoachToolArgs(call.name, call.arguments),
      locale: "en",
      fallbackWindow: "last7days",
      result: {
        present: true,
        data: { recent: [{ name: "Ferritin", value: 37.5, unit: "ng/mL" }] },
      },
    });
    expect(step).toMatchObject({
      domain: "labs",
      window: "lastYear",
      status: "done",
      count: 1,
    });
    expect(JSON.stringify(step)).not.toMatch(/ferritin|ng\/mL|37/i);
  });

  it("gives no step past the cap, for an unknown tool, or an unreadable metric", () => {
    expect(
      toStep({
        call: bp,
        index: MAX_TURN_STEPS,
        parsedArgs: parsed,
        locale: "en",
      }),
    ).toBeNull();
    expect(
      toStep({
        call: bp,
        index: MAX_TURN_STEPS - 1,
        parsedArgs: parsed,
        locale: "en",
      })?.id,
    ).toBe("s12");
    expect(
      toStep({
        call: { id: "u", name: "get_everything", arguments: "{}" },
        index: 0,
        parsedArgs: undefined,
        locale: "en",
      }),
    ).toBeNull();
    expect(
      toStep({
        call: { id: "m", name: "get_metric_series", arguments: "{nope" },
        index: 0,
        parsedArgs: undefined,
        locale: "en",
        result: { present: false, reason: "invalid_arguments" },
      }),
    ).toBeNull();
  });
});

describe("snapshotStep", () => {
  it("is one settled step counting the metrics", () => {
    expect(snapshotStep({ metricCount: 5, locale: "en" })).toEqual({
      id: "s1",
      tool: "snapshot",
      labelKey: "coach.step.snapshot",
      label: "Reading your record summary",
      domain: "snapshot",
      status: "done",
      count: 5,
    });
  });

  it("an empty snapshot says so", () => {
    expect(snapshotStep({ metricCount: 0, locale: "en" })).toMatchObject({
      status: "empty",
      count: 0,
      reason: "no_data",
    });
  });
});

/**
 * A step that started and never settled would spin forever in the UI and be
 * persisted as running. The loop's behaviour is tested with mocks in
 * `tools-loop-callbacks.test.ts`; this pins the shape that makes it true for
 * every call: nothing between `onCallStart` and `onCallSettled` but the
 * executor, and the executor turns every failure into a result.
 */
describe("the tool loop settles every call it starts (structural)", () => {
  const root = path.resolve(__dirname, "../../../../../..");
  const loop = readFileSync(
    path.join(root, "src/lib/ai/coach/tools/loop.ts"),
    "utf8",
  );
  const executor = readFileSync(
    path.join(root, "src/lib/ai/coach/tools/executor.ts"),
    "utf8",
  );

  it("fires onCallStart and onCallSettled exactly once each per call", () => {
    expect(loop.match(/onCallStart\?\.\(/g)).toHaveLength(1);
    expect(loop.match(/onCallSettled\?\.\(/g)).toHaveLength(1);
  });

  it("runs only the executor between the two, with no exit in between", () => {
    const start = loop.indexOf("onCallStart?.(");
    const settle = loop.indexOf("onCallSettled?.(");
    expect(start).toBeGreaterThan(-1);
    expect(settle).toBeGreaterThan(start);
    const between = loop.slice(start, settle);
    expect(between).toMatch(/await\s+executeCoachTool\(/);
    expect(between).not.toMatch(/\breturn\b|\bthrow\b|\bcontinue\b|\bbreak\b/);
    expect(between).not.toMatch(/\bif\s*\(/);
  });

  it("the executor answers every failure with a result instead of throwing", () => {
    const body = executor.slice(
      executor.indexOf("export async function executeCoachTool("),
      executor.indexOf("async function dispatch("),
    );
    expect(body.length).toBeGreaterThan(0);
    // The one call that reaches data runs inside a try whose catch returns.
    expect(body).toMatch(
      /try\s*\{[\s\S]*await dispatch\([\s\S]*\}\s*catch[\s\S]*return \{ present: false, reason: "retrieval_failed" \}/,
    );
    expect(body).not.toMatch(/\bthrow\b/);
    // JSON parsing is guarded too.
    expect(body).toMatch(
      /try\s*\{[\s\S]*JSON\.parse\(rawArguments\)[\s\S]*\}\s*catch/,
    );
  });
});
