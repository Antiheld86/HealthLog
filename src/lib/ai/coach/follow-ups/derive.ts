/**
 * The follow-up chips under the latest assistant reply, derived on the
 * server from what the turn read: as a chart, as a table, the period before,
 * a year ago, a wider window, a related metric. At most three, deduplicated,
 * labels from the catalog only.
 *
 * Pure. Not built yet: no chips.
 */
import type { Locale } from "@/lib/i18n/config";
import type {
  CoachFollowUp,
  CoachFollowUpKind,
  CoachResultMeta,
  CoachStep,
  CoachStepDomain,
} from "@/lib/ai/coach/types";
import type { InventoryEntry } from "@/lib/ai/coach/tools/inventory";
import type { CoachPrefs } from "@/lib/validations/coach-prefs";

export function deriveFollowUps(_args: {
  results: CoachResultMeta[];
  steps: CoachStep[];
  /** What the record holds; null on the no-tools path. */
  inventory: InventoryEntry[] | null;
  /** Kind and domain pairs the model proposed, already catalog-checked. */
  proposals: Array<{ kind: CoachFollowUpKind; domain: CoachStepDomain }>;
  forcedFinal: boolean;
  prefs: CoachPrefs;
  locale: Locale;
}): CoachFollowUp[] {
  return [];
}
