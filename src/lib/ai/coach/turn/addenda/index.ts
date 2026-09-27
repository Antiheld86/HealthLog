/**
 * The dialog addenda appended to the tool-mode system prompt: result
 * tables, clarification, the method line, follow-up chips. Each lives in its
 * own file; an empty one adds nothing, so a turn with every addendum empty
 * sends the prompt byte for byte as before.
 */
import type { Locale } from "@/lib/i18n/config";

import { clarifyAddendum } from "./clarify";
import { followUpsAddendum } from "./followups";
import { methodAddendum } from "./method";
import { resultsAddendum } from "./results";

export function buildDialogAddenda(locale: Locale): string {
  return [
    resultsAddendum(locale),
    clarifyAddendum(locale),
    methodAddendum(locale),
    followUpsAddendum(locale),
  ]
    .filter((block) => block.length > 0)
    .join("\n\n");
}
