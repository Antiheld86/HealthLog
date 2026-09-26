"use client";

/**
 * A small segmented radio group (Paperless-ngx | Papra) with the keyboard
 * contract of a radio group: one tab stop (the checked option), arrow keys
 * move and select, Home and End jump to the ends. Shared by the document
 * picker's source switch and the settings card's system switch.
 */
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The option an arrow, Home or End key moves to from `index`, wrapping at the
 * ends; null for any other key.
 */
export function nextChoiceIndex(
  key: string,
  index: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

export function SegmentedChoice<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
  renderOption,
  slot,
  className,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the group. */
  label: string;
  disabled?: boolean;
  renderOption: (option: T) => ReactNode;
  slot?: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const next = nextChoiceIndex(event.key, i, options.length);
    if (next === null) return;
    event.preventDefault();
    if (disabled) return;
    onChange(options[next]);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        "bg-muted inline-flex self-start rounded-md p-1",
        className,
      )}
    >
      {options.map((option, i) => {
        const checked = option === value;
        return (
          <button
            key={option}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option)}
            onKeyDown={(event) => onKeyDown(event, i)}
            data-slot={slot}
            className={cn(
              "flex min-h-9 items-center gap-1.5 rounded-sm px-3 text-sm font-medium",
              "focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none",
              checked
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {renderOption(option)}
          </button>
        );
      })}
    </div>
  );
}
