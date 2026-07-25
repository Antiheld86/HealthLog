"use client";

import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * v1.4.27 R3d MB4 / CF-40 — shadcn-style `<Checkbox>` primitive backed
 * by `radix-ui`'s `Checkbox` namespace. Brought in so the Coach
 * sources-rail can drop its raw `<input type="checkbox">` for a
 * keyboard + touch accessible control that ships proper focus rings
 * and a 44 px hit target on mobile.
 *
 * Mirrors the v1.4.27 shadcn `<Checkbox>` recipe: a Root that draws
 * the border + checked-state background, an Indicator slot that
 * shows the lucide `<Check>` when the box is checked.
 *
 * The Indicator also draws a `<Minus>` for the indeterminate state, which
 * Radix's Root accepts natively via `checked="indeterminate"`. A group row
 * whose leaves are partly selected is a real third state and needs to look
 * like one — drawing it as unchecked would say "none of this is included",
 * which on this surface is a false statement about what leaves the instance.
 */
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // The visual box stays 16×16, but the effective touch target is
        // 32×32 via the switch's `::before` hit-area trick (v1.4.43 W5-H1):
        // `relative` + an absolutely positioned 8 px halo that receives
        // pointer events without disturbing layout. 16 px alone sits below
        // the WCAG 2.5.8 24 px floor on the measurement/mood row selectors;
        // 32 px clears it with margin while staying small enough not to
        // blanket neighbouring controls in dense table rows.
        "peer border-border/70 relative size-4 shrink-0 rounded border before:absolute before:inset-[-8px] before:content-['']",
        "data-[state=checked]:bg-primary data-[state=checked]:border-primary data-[state=checked]:text-background",
        "data-[state=indeterminate]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:text-background",
        "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "transition-colors",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        {props.checked === "indeterminate" ? (
          <Minus className="size-3" aria-hidden="true" />
        ) : (
          <Check className="size-3" aria-hidden="true" />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
