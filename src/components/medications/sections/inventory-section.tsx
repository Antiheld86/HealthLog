"use client";

/**
 * v1.15.18 — Bestand (supply) tab body.
 *
 * v1.16.1 — the tab grows its write affordances:
 *
 *   - REGISTER: a "+" flow (header button + the empty-state CTA) that
 *     records a new pack / container via
 *     `POST /api/medications/[id]/inventory` — quantity in units,
 *     optional printed expiry. The quantity prefills from the
 *     medication's `dosesPerUnit` when configured.
 *   - CORRECT: a per-item adjust flow (`PATCH …/inventory/[itemId]`) for
 *     stock corrections and manual withdrawals — the count is set
 *     absolutely, clamped server-side to the item's capacity, and the
 *     canonical state machine derives the next state (0 ⇒ used up). The
 *     same flow edits the two dates that decide the state: the
 *     carton-printed expiry and the date the container was opened. The
 *     opening date is written by the intake consumption hook without the
 *     user typing it, so it needs a correction path more than any other
 *     field on the row.
 *   - DELETE: a per-item trash affordance behind a destructive confirm
 *     (`DELETE …/inventory/[itemId]`). Consumption stamps on intake
 *     events that referenced the container stay in place; a later
 *     restore skips the missing item.
 *
 * v1.16.10 — items count UNITS (tablets / ampoules / puffs);
 * `Medication.unitsPerDose` maps units to doses. Every dose-facing
 * readout divides by it (floor), with the raw unit count as secondary
 * text when the factor is > 1. The register flow gains a container-type
 * select (pen / ampoule / tablet pack / …, defaulted from the delivery
 * form) and, for multi-unit doses, a segmented Dosen | Einheiten
 * quantity input with live conversion — the wire always carries units.
 *
 * Reads stay on `GET /api/medications/[id]/inventory` (the same
 * per-item list the inventory CRUD route serves): a calm summary — the
 * doses remaining across every non-terminal item — plus a per-item list
 * with its container type and state badge. Shown for ALL medications
 * (pill packs count too).
 */

import { useId, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PackageOpen, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteButton } from "@/components/data-list/delete-button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingsGroup } from "@/components/medications/settings-group";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import { formatDate } from "@/lib/date-format";
import { queryKeys } from "@/lib/query-keys";
import { formatUnitCount } from "@/components/medications/units-per-dose";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
} from "@/lib/api/api-fetch";
import { startsInUseClock } from "@/lib/medications/inventory/clock-container-types";
import type { SupplySummary } from "@/lib/medications/inventory/summary";

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

type InventoryState = "ACTIVE" | "IN_USE" | "EXPIRED" | "USED_UP";

const CONTAINER_TYPES = [
  "PEN",
  "AMPOULE",
  "BLISTER",
  "INHALER",
  "BOTTLE",
  "OTHER",
] as const;
type ContainerType = (typeof CONTAINER_TYPES)[number];

interface InventoryItem {
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

/**
 * Both dates the row carries are entered — and were always stored — as a
 * calendar day at the browser's local midnight. Reading them back in the
 * same zone is what makes the value the user typed the value they see;
 * pinning to UTC would slide the day for anyone east of Greenwich.
 */
function toLocalDayInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The inverse: a `yyyy-MM-dd` day back to the instant the API stores. */
function fromLocalDayInput(day: string): string | null {
  if (!day) return null;
  const at = new Date(`${day}T00:00:00`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

interface InventoryResponse {
  items: InventoryItem[];
  // v1.19.0 (iOS#25) — server-authoritative supply summary. The headline
  // figures are computed server-side via the shared `summariseSupply`
  // helper and shipped ready; the client renders them rather than
  // re-deriving in the browser, so web and iOS agree on the Bestand.
  summary?: SupplySummary;
  meta?: { total: number };
}

const STATE_BADGE: Record<
  InventoryState,
  "secondary" | "outline" | "destructive"
> = {
  ACTIVE: "secondary",
  IN_USE: "secondary",
  EXPIRED: "destructive",
  USED_UP: "outline",
};

/** Default container kind for the register flow, from the delivery form. */
function defaultContainerType(deliveryForm: string | undefined): ContainerType {
  if (deliveryForm === "INJECTION") return "PEN";
  if (deliveryForm === "ORAL") return "BLISTER";
  return "OTHER";
}

export function InventorySection({
  medicationId,
  dosesPerUnit,
  unitsPerDose,
  deliveryForm,
}: {
  medicationId: string;
  /** Prefills the register flow's quantity when the medication tracks it. */
  dosesPerUnit?: number | null;
  /** Units one dose consumes; dose-derived readouts divide by it. */
  unitsPerDose?: number | null;
  /** Defaults the register flow's container type. */
  deliveryForm?: string;
}) {
  const { t, locale } = useTranslations();
  const dateFormatPref = useDateFormatPreference();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);
  const [packagingOpen, setPackagingOpen] = useState(false);

  async function deleteItem(item: InventoryItem) {
    try {
      await apiDelete(`/api/medications/${medicationId}/inventory/${item.id}`);
      await invalidateSupplyQueries(queryClient, medicationId);
      toast.success(t("medications.detail.bestand.deleteSuccess"));
    } catch {
      toast.error(t("medications.detail.bestand.deleteFailed"));
    }
  }

  // v1.16.12 — guard at > 0, NOT ≥ 1: a fractional unitsPerDose (½ tablet
  // per dose) must stay fractional or the dose-derived counts halve.
  const perDose = unitsPerDose && unitsPerDose > 0 ? unitsPerDose : 1;

  const { data, isLoading } = useQuery<InventoryResponse>({
    queryKey: queryKeys.medicationInventory(medicationId),
    queryFn: async () => {
      return apiGet<InventoryResponse>(
        `/api/medications/${medicationId}/inventory`,
      );
    },
    staleTime: 30_000,
    // v1.16.12 (#316) — fresh on every mount so reopening the supply tab
    // reflects stock changed elsewhere (a dose on another device, a
    // refill) without a manual reload.
    refetchOnMount: "always",
  });

  // v1.16.11 — the low-stock alert threshold, for the cross-link row
  // below the supply summary (same shared key + cache the cards read).
  // Null on failure falls back to the server default (7 days).
  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      try {
        return await apiGet<{
          lateMinutes: number;
          missedMinutes: number;
          lowStockRunwayDays: number | null;
        }>("/api/settings/reminder-thresholds");
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000,
  });
  const lowStockDays = thresholds == null ? 7 : thresholds.lowStockRunwayDays;

  if (isLoading) {
    return (
      <div
        className="flex h-32 items-center justify-center"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2
          aria-hidden="true"
          className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none"
        />
      </div>
    );
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  // v1.19.0 (iOS#25) — the supply headline is server-authoritative: the
  // GET response carries a `summary` computed server-side through the
  // shared `summariseSupply` helper (ACTIVE / IN_USE with units left;
  // EXPIRED surfaced separately, never available; dose-derived counts
  // floored). The client renders these ready figures so web and iOS show
  // identical numbers. The per-item rows below still divide by `perDose`
  // locally, which is presentation only — the canonical pool is the DTO.
  const summary = data?.summary;
  const remainingUnits = summary?.unitsRemaining ?? 0;
  const totalUnits = summary?.unitsTotal ?? 0;
  const remaining = summary?.dosesRemaining ?? 0;
  const total = summary?.dosesTotal ?? 0;
  const expiredUnits = summary?.expiredUnits ?? 0;
  // Nothing available, but stock is sitting in containers that were
  // declared unusable. That is a different statement from "no supply
  // recorded" and the headline has to make the difference.
  const allExpired = totalUnits === 0 && expiredUnits > 0;

  const dialogs = (
    <>
      {addOpen && (
        <AddInventoryDialog
          medicationId={medicationId}
          defaultUnitsTotal={dosesPerUnit ?? null}
          unitsPerDose={perDose}
          initialContainerType={defaultContainerType(deliveryForm)}
          onClose={() => setAddOpen(false)}
        />
      )}
      {adjustItem && (
        <AdjustInventoryDialog
          medicationId={medicationId}
          item={adjustItem}
          onClose={() => setAdjustItem(null)}
        />
      )}
      {packagingOpen && (
        <PackagingDialog
          medicationId={medicationId}
          unitsPerDose={perDose}
          dosesPerUnit={dosesPerUnit ?? null}
          onClose={() => setPackagingOpen(false)}
        />
      )}
    </>
  );

  if (items.length === 0) {
    return (
      <>
        <EmptyState
          icon={<PackageOpen className="size-6" />}
          title={t("medications.detail.bestand.empty")}
          description={t("medications.detail.bestand.emptyHelper")}
          ctaSize="lg"
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("medications.detail.bestand.emptyCta")}
            </Button>
          }
        />
        {dialogs}
      </>
    );
  }

  return (
    <div className="space-y-4" data-slot="medication-inventory-section">
      <SettingsGroup
        label={t("medications.detail.bestand.title")}
        dataSlot="inventory-summary-group"
      >
        <div className="flex items-center justify-between gap-3 py-3">
          <p className="text-foreground text-sm font-medium">
            {/* "0 of 0 doses" beside "+ 54 units expired" read as two
                contradicting statements — the first says nothing was ever
                configured, the second says stock was written off. When the
                available pool is empty and expired stock is all that is
                left, say that instead. */}
            {allExpired
              ? t("medications.detail.bestand.summaryAllExpired", {
                  units: expiredUnits,
                })
              : t("medications.detail.bestand.summary", { remaining, total })}
            {perDose !== 1 && !allExpired && (
              <span className="text-muted-foreground block text-xs font-normal">
                {t("medications.detail.bestand.unitsDetail", {
                  remaining: formatUnitCount(remainingUnits),
                  total: formatUnitCount(totalUnits),
                })}
              </span>
            )}
            {expiredUnits > 0 && !allExpired && (
              <span
                className="text-muted-foreground block text-xs font-normal"
                data-slot="inventory-expired-suffix"
              >
                {t("medications.detail.bestand.expiredSuffix", {
                  units: expiredUnits,
                })}
              </span>
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddOpen(true)}
            className="min-h-11 shrink-0 sm:min-h-9"
            data-slot="inventory-add-button"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("medications.detail.bestand.addButton")}
          </Button>
        </div>
        {/* v1.16.11 — cross-link to the low-stock alert setting: the
            threshold lives in Settings → Notifications, but the question
            "when will it warn me?" comes up here, where the stock lives. */}
        <div className="py-2">
          <Link
            href="/settings/notifications#low-stock"
            className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
            data-slot="inventory-low-stock-link"
          >
            {lowStockDays !== null
              ? t("medications.detail.bestand.lowStockLinkOn", {
                  days: lowStockDays,
                })
              : t("medications.detail.bestand.lowStockLinkOff")}
          </Link>
        </div>
      </SettingsGroup>

      {/* v1.16.11 — packaging economics surfaced where the stock lives:
          the wizard's dose step owns these on create/edit, but a
          manufacturer switch (a different blister size) happens while
          looking at the supply, so the supply tab carries them too. */}
      <SettingsGroup
        label={t("medications.detail.bestand.packagingTitle")}
        dataSlot="inventory-packaging-group"
      >
        <div className="flex items-center justify-between gap-3 py-3">
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.bestand.packagingUnitsPerDose", {
              units: perDose,
            })}
            <span className="text-muted-foreground block text-xs font-normal">
              {dosesPerUnit != null
                ? t("medications.detail.bestand.packagingDefaultPack", {
                    units: dosesPerUnit,
                  })
                : t("medications.detail.bestand.packagingNoDefaultPack")}
            </span>
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPackagingOpen(true)}
            className="min-h-11 shrink-0 sm:min-h-9"
            data-slot="inventory-packaging-edit"
          >
            {t("medications.detail.bestand.packagingEdit")}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        label={t("medications.detail.bestand.itemsTitle")}
        dataSlot="inventory-items-group"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between gap-3 py-3"
            data-slot="inventory-item-row"
          >
            <span className="text-foreground text-sm">
              <span className="block">
                {t(
                  `medications.detail.bestand.containerType.${item.containerType}`,
                )}
              </span>
              {/* Meta line: per-container figures with the state badge
                  inline at meta-text size — read-only, never a control. */}
              <span className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                <span>
                  {/* v1.18.3 (iOS#31) — an unknown unit count (null) renders
                      "—" rather than a fabricated 0-dose figure. */}
                  {item.unitsRemaining == null || item.unitsTotal == null
                    ? t("medications.detail.bestand.unknown")
                    : t("medications.detail.bestand.doses", {
                        remaining: Math.floor(item.unitsRemaining / perDose),
                        total: Math.floor(item.unitsTotal / perDose),
                      })}
                  {perDose !== 1 &&
                    item.unitsRemaining != null &&
                    item.unitsTotal != null && (
                      <>
                        {" · "}
                        {t("medications.detail.bestand.unitsDetail", {
                          remaining: formatUnitCount(item.unitsRemaining),
                          total: formatUnitCount(item.unitsTotal),
                        })}
                      </>
                    )}
                </span>
                <Badge
                  variant={STATE_BADGE[item.state]}
                  className="px-1.5 py-0 text-xs font-normal"
                  data-slot="inventory-state-badge"
                >
                  {t(`medications.detail.bestand.state.${item.state}`)}
                </Badge>
              </span>
              {/* The two dates that decide the row's state. They used to
                  be invisible here — a container could read EXPIRED with
                  nothing on screen to explain why, and no way to correct
                  the value that caused it. */}
              {(item.firstUseAt || item.printedExpiry) && (
                <span
                  className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs"
                  data-slot="inventory-item-dates"
                >
                  {item.firstUseAt && (
                    <span>
                      {t("medications.detail.bestand.openedOn", {
                        date: formatDate(
                          toLocalDayInput(item.firstUseAt),
                          dateFormatPref,
                          locale,
                        ),
                      })}
                    </span>
                  )}
                  {item.firstUseAt && item.printedExpiry && <span>·</span>}
                  {item.printedExpiry && (
                    <span>
                      {t("medications.detail.bestand.expiresOn", {
                        date: formatDate(
                          toLocalDayInput(item.printedExpiry),
                          dateFormatPref,
                          locale,
                        ),
                      })}
                    </span>
                  )}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAdjustItem(item)}
                className="min-h-11 sm:min-h-9"
                data-slot="inventory-adjust-button"
              >
                {t("medications.detail.bestand.adjustButton")}
              </Button>
              <DeleteButton
                onConfirm={() => void deleteItem(item)}
                title={t("medications.detail.bestand.deleteTitle")}
                description={t("medications.detail.bestand.deleteDescription")}
              />
            </span>
          </div>
        ))}
      </SettingsGroup>

      {dialogs}
    </div>
  );
}

/**
 * Register a new pack / container. Quantity (units), container type and
 * optional printed expiry → Dialog per ui-guidelines §2.3. The quantity
 * prefills from the medication's `dosesPerUnit` so the common case is
 * one tap. For multi-unit doses (`unitsPerDose > 1`) a segmented
 * Dosen | Einheiten control converts live — the POST always carries
 * units.
 */
export function AddInventoryDialog({
  medicationId,
  defaultUnitsTotal,
  unitsPerDose,
  initialContainerType,
  onClose,
}: {
  medicationId: string;
  defaultUnitsTotal: number | null;
  unitsPerDose: number;
  initialContainerType: ContainerType;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState(
    defaultUnitsTotal && defaultUnitsTotal >= 1 && defaultUnitsTotal <= 1000
      ? String(defaultUnitsTotal)
      : "",
  );
  // The unit the typed quantity is read in. Only surfaced when a dose
  // spans several units; the stored value is ALWAYS units.
  const [quantityMode, setQuantityMode] = useState<"units" | "doses">("units");
  const [containerType, setContainerType] =
    useState<ContainerType>(initialContainerType);
  const [expiry, setExpiry] = useState("");
  // Carton labelling. Only offered for a PEN: the native pen list is the
  // one surface that renders them, and asking for a maker + strength on a
  // blister pack would be noise on the far commoner path.
  const [manufacturer, setManufacturer] = useState("");
  const [doseStrength, setDoseStrength] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const parsed = Number(quantity);
  const effectiveMode = unitsPerDose > 1 ? quantityMode : "units";
  const units = effectiveMode === "doses" ? parsed * unitsPerDose : parsed;
  const quantityValid =
    Number.isInteger(parsed) && parsed >= 1 && units >= 1 && units <= 1000;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!quantityValid || busy) return;
    setBusy(true);
    try {
      await apiPost(`/api/medications/${medicationId}/inventory`, {
        // The wire field carries UNITS (v1.16.10 symmetric naming).
        unitsTotal: units,
        containerType,
        printedExpiry: expiry
          ? new Date(`${expiry}T00:00:00`).toISOString()
          : null,
        // Trimmed to null so a field the user opened and left blank stores
        // absence rather than an empty string.
        manufacturer: manufacturer.trim() || null,
        doseStrength: doseStrength.trim() || null,
      });
      await invalidateSupplyQueries(queryClient, medicationId);
      toast.success(t("medications.detail.bestand.addSuccess"));
      onClose();
    } catch {
      toast.error(t("medications.detail.bestand.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("medications.detail.bestand.addTitle")}
      description={t("medications.detail.bestand.addDescription")}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!quantityValid || busy}
            aria-busy={busy || undefined}
          >
            {busy && (
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
            )}
            {t("medications.detail.bestand.addSubmit")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="inventory-add-container-type"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.containerTypeLabel")}
          </label>
          <Select
            value={containerType}
            onValueChange={(v) => setContainerType(v as ContainerType)}
          >
            <SelectTrigger
              id="inventory-add-container-type"
              className="w-full"
              data-slot="inventory-container-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTAINER_TYPES.map((ct) => (
                <SelectItem key={ct} value={ct}>
                  {t(`medications.detail.bestand.containerType.${ct}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label
            htmlFor="inventory-add-quantity"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.addQuantityLabel")}
          </label>
          {unitsPerDose > 1 && (
            <div
              className="border-border/60 inline-flex rounded-md border p-0.5"
              role="group"
              aria-label={t("medications.detail.bestand.addQuantityLabel")}
              data-slot="inventory-quantity-mode"
            >
              <Button
                type="button"
                size="sm"
                variant={quantityMode === "doses" ? "secondary" : "ghost"}
                aria-pressed={quantityMode === "doses"}
                className="h-7 px-2 text-xs"
                onClick={() => setQuantityMode("doses")}
              >
                {t("medications.detail.bestand.quantityModeDoses")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={quantityMode === "units" ? "secondary" : "ghost"}
                aria-pressed={quantityMode === "units"}
                className="h-7 px-2 text-xs"
                onClick={() => setQuantityMode("units")}
              >
                {t("medications.detail.bestand.quantityModeUnits")}
              </Button>
            </div>
          )}
          <Input
            id="inventory-add-quantity"
            type="number"
            inputMode="numeric"
            min={1}
            max={
              effectiveMode === "doses" ? Math.floor(1000 / unitsPerDose) : 1000
            }
            step={1}
            required
            autoComplete="off"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-describedby="inventory-add-quantity-helper"
          />
          {unitsPerDose > 1 && Number.isInteger(parsed) && parsed >= 1 && (
            <p
              className="text-muted-foreground text-xs"
              data-slot="inventory-quantity-conversion"
            >
              {effectiveMode === "doses"
                ? t("medications.detail.bestand.quantityInUnits", { units })
                : // A unit count below one dose must not read "≈ 0 doses" —
                  // it is simply less than one dose.
                  Math.floor(parsed / unitsPerDose) === 0
                  ? t("medications.detail.bestand.quantityUnderOneDose")
                  : t("medications.detail.bestand.quantityInDoses", {
                      doses: Math.floor(parsed / unitsPerDose),
                    })}
            </p>
          )}
          <p
            id="inventory-add-quantity-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.addQuantityHelper")}
          </p>
        </div>
        <div className="space-y-2">
          <label htmlFor="inventory-add-expiry" className="text-sm font-medium">
            {t("medications.detail.bestand.addExpiryLabel")}
          </label>
          <DateField
            id="inventory-add-expiry"
            value={expiry}
            onChange={setExpiry}
          />
        </div>
        {containerType === "PEN" && (
          <>
            <div className="space-y-2">
              <label
                htmlFor="inventory-add-manufacturer"
                className="text-sm font-medium"
              >
                {t("medications.detail.bestand.addManufacturerLabel")}
              </label>
              <Input
                id="inventory-add-manufacturer"
                value={manufacturer}
                maxLength={120}
                onChange={(e) => setManufacturer(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="inventory-add-dose-strength"
                className="text-sm font-medium"
              >
                {t("medications.detail.bestand.addDoseStrengthLabel")}
              </label>
              <Input
                id="inventory-add-dose-strength"
                value={doseStrength}
                maxLength={60}
                onChange={(e) => setDoseStrength(e.target.value)}
              />
              <p className="text-muted-foreground text-sm">
                {t("medications.detail.bestand.addDoseStrengthHint")}
              </p>
            </div>
          </>
        )}
      </form>
    </ResponsiveSheet>
  );
}

/**
 * Correct one container: the remaining-unit count (covers both "I
 * miscounted" and a manual withdrawal), the carton-printed expiry, and
 * the date it was opened. The server clamps the count to the item's
 * capacity and re-derives the state from the two dates; 0 units marks
 * the item used up.
 *
 * Both dates are editable because both decide the state — and the
 * opening date in particular is written by the intake consumption hook
 * without the user ever typing it, so an auto-open on a back-dated dose
 * needs a way back. Each field is sent only when it actually changed,
 * so saving a unit correction never rewrites a date the user did not
 * touch.
 */
export function AdjustInventoryDialog({
  medicationId,
  item,
  onClose,
}: {
  medicationId: string;
  item: InventoryItem;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // v1.18.3 (iOS#31) — an unknown remaining count (null) pre-fills empty,
  // not the literal "null"; the operator types the corrected figure.
  const [value, setValue] = useState(
    item.unitsRemaining == null ? "" : String(item.unitsRemaining),
  );
  const initialExpiry = toLocalDayInput(item.printedExpiry);
  const initialOpened = toLocalDayInput(item.firstUseAt);
  const [expiry, setExpiry] = useState(initialExpiry);
  const [opened, setOpened] = useState(initialOpened);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const parsed = Number(value);
  // v1.16.12 — fractional remaining allowed (a ½-tablet dose leaves 29.5).
  // v1.18.3 — when capacity is unknown (null) the only ceiling is finiteness.
  const valid =
    value.trim() !== "" &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    (item.unitsTotal == null || parsed <= item.unitsTotal);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await apiPatch(`/api/medications/${medicationId}/inventory/${item.id}`, {
        // The wire field carries UNITS (v1.16.10 symmetric naming).
        unitsRemaining: parsed,
        // Absent means untouched on the server, so only changed fields
        // ride along. A cleared field sends null, which is a deliberate
        // "there is no such date" — not the same as leaving it alone.
        ...(expiry !== initialExpiry && {
          printedExpiry: fromLocalDayInput(expiry),
        }),
        ...(opened !== initialOpened && {
          markAsFirstUseAt: fromLocalDayInput(opened),
        }),
      });
      await invalidateSupplyQueries(queryClient, medicationId);
      toast.success(t("medications.detail.bestand.adjustSuccess"));
      onClose();
    } catch {
      toast.error(t("medications.detail.bestand.adjustFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("medications.detail.bestand.adjustTitle")}
      description={t("medications.detail.bestand.adjustDescription")}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!valid || busy}
            aria-busy={busy || undefined}
          >
            {busy && (
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
            )}
            {t("medications.detail.bestand.adjustSubmit")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="inventory-adjust-remaining"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.adjustQuantityLabel")}
          </label>
          <Input
            id="inventory-adjust-remaining"
            type="number"
            inputMode="decimal"
            min={0}
            max={item.unitsTotal ?? undefined}
            step="any"
            required
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby="inventory-adjust-helper"
          />
          <p
            id="inventory-adjust-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.adjustHelper", {
              total: item.unitsTotal ?? t("medications.detail.bestand.unknown"),
            })}
          </p>
        </div>
        <div className="space-y-2">
          <label
            htmlFor="inventory-edit-expiry"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.editExpiryLabel")}
          </label>
          <DateField
            id="inventory-edit-expiry"
            value={expiry}
            onChange={setExpiry}
            aria-describedby="inventory-edit-expiry-helper"
            data-testid="inventory-edit-expiry"
          />
          <p
            id="inventory-edit-expiry-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.editExpiryHelper")}
          </p>
        </div>
        <div className="space-y-2">
          <label
            htmlFor="inventory-edit-opened"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.editOpenedLabel")}
          </label>
          <DateField
            id="inventory-edit-opened"
            value={opened}
            onChange={setOpened}
            aria-describedby="inventory-edit-opened-helper"
            data-testid="inventory-edit-opened"
          />
          <p
            id="inventory-edit-opened-helper"
            className="text-muted-foreground text-xs"
          >
            {startsInUseClock(item.containerType)
              ? t("medications.detail.bestand.editOpenedHelperClock")
              : t("medications.detail.bestand.editOpenedHelper")}
          </p>
        </div>
      </form>
    </ResponsiveSheet>
  );
}

/**
 * Edit the medication-level packaging economics from the supply tab:
 * units one dose consumes, and the default container size the register
 * flow prefills. Both PUT sparsely onto the medication — the wizard's
 * dose step stays the source on create; this is the correction surface
 * for a manufacturer switch (same medication, different blister size).
 */
function PackagingDialog({
  medicationId,
  unitsPerDose,
  dosesPerUnit,
  onClose,
}: {
  medicationId: string;
  unitsPerDose: number;
  dosesPerUnit: number | null;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [perDoseValue, setPerDoseValue] = useState(String(unitsPerDose));
  const [packValue, setPackValue] = useState(
    dosesPerUnit === null ? "" : String(dosesPerUnit),
  );
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const parsedPerDose = Number(perDoseValue);
  const perDoseValid =
    Number.isInteger(parsedPerDose) &&
    parsedPerDose >= 1 &&
    parsedPerDose <= 100;
  const parsedPack = packValue.trim() === "" ? null : Number(packValue);
  const packValid =
    parsedPack === null ||
    (Number.isInteger(parsedPack) && parsedPack >= 1 && parsedPack <= 1000);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!perDoseValid || !packValid || busy) return;
    setBusy(true);
    try {
      await apiPut(`/api/medications/${medicationId}`, {
        unitsPerDose: parsedPerDose,
        dosesPerUnit: parsedPack,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.medicationDetail(medicationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.medications(),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.medicationInventory(medicationId),
        }),
      ]);
      toast.success(t("medications.detail.bestand.packagingSuccess"));
      onClose();
    } catch {
      toast.error(t("medications.detail.bestand.packagingFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("medications.detail.bestand.packagingTitle")}
      description={t("medications.detail.bestand.packagingDescription")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!perDoseValid || !packValid || busy}
          >
            {busy && (
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
            )}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="packaging-units-per-dose"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.packagingUnitsPerDoseLabel")}
          </label>
          <Input
            id="packaging-units-per-dose"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            step={1}
            required
            autoComplete="off"
            value={perDoseValue}
            onChange={(e) => setPerDoseValue(e.target.value)}
            aria-describedby="packaging-units-per-dose-helper"
          />
          <p
            id="packaging-units-per-dose-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.packagingUnitsPerDoseHelper")}
          </p>
        </div>
        <div className="space-y-2">
          <label
            htmlFor="packaging-default-pack"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.packagingDefaultPackLabel")}
          </label>
          <Input
            id="packaging-default-pack"
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            step={1}
            autoComplete="off"
            value={packValue}
            onChange={(e) => setPackValue(e.target.value)}
            aria-describedby="packaging-default-pack-helper"
          />
          <p
            id="packaging-default-pack-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.packagingDefaultPackHelper")}
          </p>
        </div>
      </form>
    </ResponsiveSheet>
  );
}
