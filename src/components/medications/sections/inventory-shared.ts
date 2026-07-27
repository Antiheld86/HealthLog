/**
 * The facts the supply tab's two halves both need.
 *
 * The tab is a list of containers on one side and three write dialogs on the
 * other, and they meet at exactly this much: the row shape the API returns,
 * the container kinds it can carry, and the cache keys a write has to drop.
 * Keeping that here is what lets the two halves live in their own files
 * without either importing the other's rendering.
 */
import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query-keys";

/**
 * Invalidate every read key whose payload reflects a medication's supply
 * after a container write (register / adjust / delete).
 *
 * The per-medication inventory read (`medicationInventory`) is the supply
 * tab's own list. The medications LIST read (`medications`) carries the
 * dose-derived stock (`stockUnitsRemaining` / `stockDosesRemaining`) that
 * the card and table render — without invalidating it, the card kept
 * showing the pre-write stock until an unrelated refetch landed (the
 * supply-staleness bug). Both keys must drop together.
 */
export async function invalidateSupplyQueries(
  queryClient: QueryClient,
  medicationId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: queryKeys.medicationInventory(medicationId),
    }),
    queryClient.invalidateQueries({
      queryKey: queryKeys.medications(),
    }),
  ]);
}

export type InventoryState = "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";

export const CONTAINER_TYPES = [
  "PEN",
  "AMPOULE",
  "BLISTER",
  "INHALER",
  "BOTTLE",
  "OTHER",
] as const;
export type ContainerType = (typeof CONTAINER_TYPES)[number];

export interface InventoryItem {
  id: string;
  state: InventoryState;
  containerType: ContainerType;
  // v1.18.3 (iOS#31) — null = unknown unit count (corrupt / legacy row);
  // the UI renders "—" instead of a fabricated 0.
  unitsTotal: number | null;
  unitsRemaining: number | null;
  /** ISO instant. The carton-printed expiry; null when none was recorded. */
  printedExpiry: string | null;
  /** ISO instant. When the container was opened; null while sealed. */
  firstUseAt: string | null;
}
