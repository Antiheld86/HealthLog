"use client";

import { HeartHandshake, Loader2 } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { TileHeader } from "@/components/insights/tile-header";
import { useAccountSwitch } from "@/hooks/use-account-switch";
import { useAccountOnceMounted } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import {
  accountLabel,
  type AccountAccessEntry,
} from "@/lib/sharing/account-access-view";

/**
 * v1.36.x — the caregiver's front door.
 *
 * ## Why this is on the dashboard and not in settings
 *
 * Sharing shipped as a settings panel and a menu three levels deep: user menu
 * → switcher → the record. That is the right place to MANAGE a grant, and the
 * wrong place to use one. Somebody who opens this app every morning to check
 * on a parent does not go to settings to do it, and UI-STANDARDS §10 draws
 * exactly that line: settings are account utilities, not feature
 * destinations. Looking after somebody is a feature destination.
 *
 * ## What it is not
 *
 * It is a doorway, not a preview. No numbers, no last reading, no status.
 * Putting a slice of somebody else's health record on a delegate's own
 * dashboard would place it outside the one frame the whole design leans on —
 * the banner that says which record you are inside. Everything about the
 * other person is read after the switch, under that banner, or not at all.
 *
 * ## Where the content comes from
 *
 * `accountAccess.accounts`, the same resolved list the switcher renders, and
 * the switch is the same mutation the switcher fires. No second mechanism, no
 * second source of truth about who may open what. An account nobody has
 * shared with sees nothing at all — no empty state, no invitation to ask
 * somebody for access (the v1.36.0 posture: the feature is invisible until it
 * applies to you).
 *
 * Design: `Card` + `TileHeader` per UI-STANDARDS §1 and §5 (icon and title in
 * the foreground colour, title `text-base`), the person's name as content in
 * `text-foreground` and the grant level as meta in `text-muted-foreground`
 * per §3, and the §11 row shape — label block `min-w-0 flex-1`, the whole row
 * a single tap target at the `min-h-11` mobile floor.
 */
export function LookingAfterCard() {
  const { t } = useTranslations();
  // Withheld until mounted: this card sits inside the dashboard's streamed
  // boundary and renders nothing without grants. The shell has usually answered
  // `/api/auth/me` before the boundary hydrates, so reading the grants on the
  // hydration render paints a card where the server painted none — a mismatch
  // that discards the streamed dashboard. See `useAccountOnceMounted`.
  const user = useAccountOnceMounted();
  const switchAccount = useAccountSwitch();

  const access = user?.accountAccess;
  const accounts = access?.accounts ?? [];

  // Inside somebody else's record the card would be a doorway to the room you
  // are already in; the banner owns that context and carries the way out.
  if (access?.active != null) return null;
  if (accounts.length === 0) return null;

  return (
    <Card data-slot="looking-after-card">
      <CardContent className="space-y-3">
        <TileHeader
          icon={HeartHandshake}
          title={t("recordSharing.lookingAfter.title")}
          titleAs="h2"
        />
        <p className="text-muted-foreground text-sm">
          {t("recordSharing.lookingAfter.description")}
        </p>
        <ul className="divide-y">
          {accounts.map((entry) => (
            <li key={entry.accountId}>
              <button
                type="button"
                data-slot="looking-after-row"
                data-account-id={entry.accountId}
                disabled={switchAccount.isPending}
                onClick={() => switchAccount.mutate(entry.accountId)}
                aria-label={t("recordSharing.lookingAfter.open", {
                  name: accountLabel(entry),
                })}
                className="hover:bg-accent/40 focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="text-foreground block truncate text-sm font-medium">
                    {accountLabel(entry)}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {levelLabel(entry, t)}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {recordKindLabel(entry, t)}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {scopeLabel(entry, t)}
                  </span>
                </span>
                {switchAccount.isPending && (
                  <Loader2
                    className="text-muted-foreground size-4 shrink-0 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                )}
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * The grant level, in the words the person reading it would use.
 *
 * Bound from the server's resolved `canWrite`, never from the `access` label
 * beside it: the label describes the row, the boolean is the decision, and a
 * lapsed WRITE grant must read as view-only here exactly as it behaves.
 *
 * No "last opened" line: `lastUsedAt` is not on this payload, and a relative
 * time invented from something else would be a placeholder wearing a fact's
 * clothes.
 */
function levelLabel(
  entry: AccountAccessEntry,
  t: (key: string) => string,
): string {
  if (entry.level === "manage") {
    return t("recordSharing.row.canManage");
  }
  return entry.canWrite
    ? t("recordSharing.lookingAfter.levelWrite")
    : t("recordSharing.lookingAfter.levelRead");
}

function recordKindLabel(
  entry: AccountAccessEntry,
  t: (key: string) => string,
): string {
  return entry.recordKind === "managed"
    ? t("recordSharing.lookingAfter.kindManaged")
    : t("recordSharing.lookingAfter.kindShared");
}

function scopeLabel(
  entry: AccountAccessEntry,
  t: (key: string) => string,
): string {
  if (entry.sections === null) {
    return t("recordSharing.row.entireRecord");
  }
  if (entry.sections.length === 0) {
    return t("recordSharing.row.noSections");
  }
  return entry.sections
    .map((domain) => t(`recordSharing.section.${domain}.label`))
    .join(", ");
}
