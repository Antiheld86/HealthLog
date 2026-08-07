"use client";

import * as React from "react";
import { Slider as SliderPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Numeric range entry.
 *
 * The alternative this replaces is eleven discrete buttons, which is what the
 * rated-factor picker does for a 1-5 scale. That pattern does not survive the
 * jump to 0-10: eleven 32 px targets with 4 px gaps come to roughly 392 px
 * before the label, and the narrow phone this app is mostly used on is 390 px
 * wide. A slider answers the same question in a fixed width at any scale, and
 * arrow keys move it a step at a time, which eleven buttons never did.
 *
 * `Slider` is the bare control. `SliderField` is the labelled row around it —
 * name on the left, value on the right, the two scale anchors underneath — and
 * it is what a capture surface should reach for, because the anchors are what
 * make a 7 mean anything.
 */
function Slider({
  className,
  valueText,
  thumbLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & {
  /**
   * What a screen reader announces instead of the bare number. A slider that
   * says "6" tells somebody who cannot see the anchors nothing at all; the
   * caller passes the number together with what the ends of the scale mean.
   */
  valueText?: string;
  /** Accessible name for the thumb when the field label is not adjacent. */
  thumbLabel?: string;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn(
        "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50",
        // The 44 px hit target WCAG 2.5.5 asks for, without a 44 px track:
        // the padding is vertical only, so the visible rail stays 6 px.
        "py-[19px]",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className="bg-muted relative h-1.5 w-full grow overflow-hidden rounded-full"
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className="bg-primary absolute h-full"
        />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={thumbLabel}
        aria-valuetext={valueText}
        className="border-primary bg-background focus-visible:ring-ring/50 block size-4 rounded-full border-2 shadow-sm transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:pointer-events-none"
      />
    </SliderPrimitive.Root>
  );
}

/**
 * A labelled slider with its scale anchors.
 *
 * `value` is nullable and the null is load-bearing: a question nobody answered
 * is not a question answered in the middle. An unset field renders no number
 * and fills no track, and only an interaction commits a value. `onClear`, when
 * given, renders the control that takes an answer back — without it a user who
 * nudged a slider by accident can never return the field to empty.
 */
function SliderField({
  label,
  value,
  onValueChange,
  onClear,
  clearLabel,
  emptyLabel,
  valueText,
  lowAnchor,
  highAnchor,
  min = 0,
  max = 10,
  step = 1,
  className,
  ...props
}: {
  label: string;
  value: number | null;
  onValueChange: (value: number) => void;
  onClear?: () => void;
  clearLabel?: string;
  /** Rendered in place of the number while the field is unanswered. */
  emptyLabel: string;
  /** Announced by a screen reader; carries the anchors, not only the number. */
  valueText?: string;
  lowAnchor: string;
  highAnchor: string;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
} & Omit<
  React.ComponentProps<typeof SliderPrimitive.Root>,
  "value" | "onValueChange" | "min" | "max" | "step" | "className"
>) {
  const unset = value === null;
  return (
    <div
      data-slot="slider-field"
      data-unset={unset ? "true" : undefined}
      className={cn("flex flex-col gap-1", className)}
    >
      <div className="flex items-baseline justify-between gap-2">
        {/* Content colour for the label and the value, muted for the anchors
            below: the anchors are the legend, the value is the answer. */}
        <span className="text-sm font-medium">{label}</span>
        <span className="flex items-center gap-2">
          <span
            data-slot="slider-field-value"
            className={cn(
              "text-sm tabular-nums",
              unset ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {unset ? emptyLabel : value}
          </span>
          {!unset && onClear ? (
            <button
              type="button"
              onClick={onClear}
              data-slot="slider-field-clear"
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded text-xs underline-offset-2 outline-none hover:underline focus-visible:ring-[3px]"
            >
              {clearLabel}
            </button>
          ) : null}
        </span>
      </div>
      <Slider
        // An unanswered field parks the thumb at the low end with an empty
        // track, so it reads as "nothing here" rather than as the value the
        // low end happens to carry. The announced text says the same.
        value={[unset ? min : value]}
        onValueChange={(next) => onValueChange(next[0])}
        min={min}
        max={max}
        step={step}
        thumbLabel={label}
        valueText={unset ? emptyLabel : valueText}
        {...props}
      />
      <div className="text-muted-foreground flex justify-between gap-2 text-xs">
        <span>{lowAnchor}</span>
        <span className="text-right">{highAnchor}</span>
      </div>
    </div>
  );
}

export { Slider, SliderField };
