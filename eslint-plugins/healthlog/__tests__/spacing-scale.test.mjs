/**
 * Unit tests for the `healthlog/spacing-scale` rule — pt-* / pb-* slot
 * padding on CardHeader/CardContent is banned (the Card is gap-based;
 * density lives on the Card itself). Covers modifier prefixes,
 * cn()/ternary/template collection, the safe-area non-match, and the
 * scope gating shared with the sibling rules.
 */

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import rule from "../spacing-scale.js";

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

const APP_FILE = "/repo/src/components/insights/example.tsx";

ruleTester.run("spacing-scale", rule, {
  valid: [
    // Density on the Card itself is the sanctioned pattern.
    {
      code: '<Card className="gap-2 py-3 md:py-4"><CardContent>x</CardContent></Card>',
      filename: APP_FILE,
    },
    // Slots without className, or with unrelated classes, are fine.
    { code: "<CardHeader />", filename: APP_FILE },
    {
      code: '<CardContent className="px-0 space-y-4" />',
      filename: APP_FILE,
    },
    // Other paddings on slots are not this rule's business.
    {
      code: '<CardContent className="pl-2 pr-2" />',
      filename: APP_FILE,
    },
    // Safe-area helpers are not scale steps and never match.
    {
      code: '<CardContent className="pb-safe" />',
      filename: APP_FILE,
    },
    // pt-/pb- on arbitrary elements stays legal — the contract is about
    // the gap-based Card slots only.
    { code: '<div className="pb-2" />', filename: APP_FILE },
    // Outside the enforced roots nothing matches.
    {
      code: '<CardHeader className="pb-2" />',
      filename: "/repo/scripts/tool.tsx",
    },
    // Test files are exempt.
    {
      code: '<CardHeader className="pb-2" />',
      filename: "/repo/src/components/__tests__/example.test.tsx",
    },
    // The card-shell check is scoped to the bg-card+border pair, so the
    // justified list-marker inset never trips it (no shell).
    {
      code: '<ul className="list-disc pl-5 space-y-1" />',
      filename: APP_FILE,
    },
    // Off-scale spacing without a shell surface is fine — a form-body
    // `space-y-5` rhythm and a half-step gap outside a shell both pass.
    {
      code: '<form className="space-y-5" />',
      filename: APP_FILE,
    },
    {
      code: '<div className="flex flex-col gap-3.5" />',
      filename: APP_FILE,
    },
    // The sanctioned `1.5` half-step is on-scale, even on a shell.
    {
      code: '<div className="bg-card border-border rounded-xl border gap-1.5" />',
      filename: APP_FILE,
    },
    // A deliberate negative margin is never matched (boundary anchored).
    {
      code: '<div className="bg-card border-border rounded-full border -mt-5" />',
      filename: APP_FILE,
    },
    // Height is a dimension, not a scale step — `h-15` on a shell is out of
    // this rule's scope by design.
    {
      code: '<div className="bg-card border-border rounded-xl border h-15" />',
      filename: APP_FILE,
    },
    // A shell already on-scale is fine.
    {
      code: '<div className="bg-card border-border rounded-xl border p-4 md:p-6" />',
      filename: APP_FILE,
    },
    // bg-card without a border is not treated as a shell.
    {
      code: '<div className="bg-card p-5" />',
      filename: APP_FILE,
    },
  ],
  invalid: [
    {
      code: '<CardHeader className="pb-2" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    {
      code: '<CardContent className="pt-0" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // Modifier-prefixed and fractional steps.
    {
      code: '<CardHeader className="md:pb-1.5" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // Arbitrary-value padding.
    {
      code: '<CardContent className="pt-[10px]" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // Collected through cn() args…
    {
      code: '<CardHeader className={cn("pb-3", extra)} />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // …ternaries…
    {
      code: '<CardContent className={dense ? "pt-2" : "pt-4"} />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }, { messageId: "slotPadding" }],
    },
    // …and template literals.
    {
      code: "<CardHeader className={`pb-2 ${extra}`} />",
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // Member-expression component tails match too.
    {
      code: '<UI.CardHeader className="pb-2" />',
      filename: APP_FILE,
      errors: [{ messageId: "slotPadding" }],
    },
    // Card-shell `5` step: bg-card + border + p-5 on one element.
    {
      code: '<div className="bg-card border-border rounded-xl border p-5" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    // …py-5, …space-y-5, …gap-5 on a shell all trip it.
    {
      code: '<section className="bg-card rounded-lg border py-5" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    {
      code: '<div className="bg-card border-border rounded-xl border gap-5 flex" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    // The `7` step is banned with the `5` step.
    {
      code: '<div className="bg-card border-border rounded-xl border p-7" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    // Half-steps other than 1.5 on a shell: gap-3.5, space-y-3.5, py-2.5.
    {
      code: '<div className="bg-card border-border rounded-xl border flex flex-col gap-3.5" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    {
      code: '<div className="bg-card border rounded-xl space-y-3.5" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    {
      code: '<div className="bg-card border-border rounded-lg border py-2.5" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    // The directional `pl-`/`ml-` spellings that slipped the `5`-only check
    // now trip it on a shell.
    {
      code: '<div className="bg-card border-border rounded-xl border pl-5" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    {
      code: '<div className="bg-card border-border rounded-xl border ml-5" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    // Split across cn() args — the join still sees the shell + the step.
    {
      code: '<div className={cn("bg-card border rounded-xl", "p-5")} />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
    // Modifier-prefixed step on a shell.
    {
      code: '<div className="bg-card border-border rounded-xl border sm:p-5" />',
      filename: APP_FILE,
      errors: [{ messageId: "cardShellOffScale" }],
    },
  ],
});
