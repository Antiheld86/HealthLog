"use client";

import { toast } from "sonner";

import type { WrittenOutcome } from "@/lib/outcome/written-outcome";

/**
 * The toast twin of `WrittenOutcomeLine`: one mapping from a written outcome
 * to the toast variant that reports it.
 *
 * `toast.success` lives here and is reached only through the `success` key, so
 * a surface that reports a write cannot raise a green toast for a run that
 * wrote nothing. `empty` uses the neutral variant rather than the success one
 * — "nothing to write" is an honest non-event, not an achievement.
 */
export function toastWrittenOutcome(
  outcome: WrittenOutcome,
  message: string,
): void {
  switch (outcome) {
    case "success":
      toast.success(message);
      return;
    case "partial":
      toast.warning(message);
      return;
    case "failed":
      toast.error(message);
      return;
    case "empty":
      toast.info(message);
  }
}
