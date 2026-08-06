"use client";

import { Check, Loader2, Users } from "lucide-react";

import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useAccountSwitch } from "@/hooks/use-account-switch";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { resolveRecordPresentation } from "@/lib/navigation/record-presentation";
import { sharedRecordLandingHref } from "@/lib/navigation/shared-record";
import { accountLabel } from "@/lib/sharing/account-access-view";

/**
 * v1.36.0 — the switcher, as a slice of the user menu.
 *
 * One component mounted in both user menus (the desktop sidebar's avatar
 * dropdown and the mobile top bar's) rather than the same block written twice.
 * The two menus have drifted before — that is the whole argument behind
 * `nav-model.ts` — and a switcher that exists on one surface and not the other
 * is a person who can enter a record on their laptop and cannot leave it on
 * their phone.
 *
 * Renders NOTHING unless the server says there is somewhere to go: `canSwitch`
 * arrives resolved on `accountAccess` and is bound directly. The list is
 * `accounts`, also resolved — the client never looks at grant rows and has none
 * to look at. An account that has never been shared with sees a user menu
 * identical to the one it saw before this feature existed.
 *
 * "Your own record" is a first-class entry rather than only a banner action:
 * the way out has to be reachable from the same menu as the way in, because
 * that is where somebody will look for it.
 */
export function AccountSwitcherMenuItems() {
  const { user } = useAuth();
  const { t } = useTranslations();
  const switchAccount = useAccountSwitch();

  const access = user?.accountAccess;
  if (!access?.canSwitch) return null;

  const activeId = access.active?.accountId ?? null;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger
          data-slot="account-switcher-trigger"
          className="min-h-11 py-2 sm:min-h-9"
        >
          {switchAccount.isPending ? (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Users className="size-4" aria-hidden="true" />
          )}
          <span className="ml-2">{t("recordSharing.switcher.label")}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent
          data-slot="account-switcher-menu"
          className="w-60"
        >
          <DropdownMenuItem
            data-slot="account-switcher-own"
            className="cursor-pointer"
            disabled={switchAccount.isPending}
            onClick={() => switchAccount.mutate(null)}
          >
            <span className="truncate">
              {t("recordSharing.switcher.ownRecord")}
            </span>
            {activeId === null && (
              <span className="text-primary ml-auto text-xs">&#10003;</span>
            )}
          </DropdownMenuItem>
          {access.accounts.map((account) => {
            const presentation = resolveRecordPresentation(account);

            return (
              <DropdownMenuItem
                key={account.accountId}
                data-slot="account-switcher-entry"
                data-account-id={account.accountId}
                data-access-level={presentation.access}
                data-record-kind={presentation.recordKind}
                className="cursor-pointer"
                disabled={switchAccount.isPending}
                onClick={() =>
                  switchAccount.switchTo(
                    account.accountId,
                    sharedRecordLandingHref(account.sections),
                  )
                }
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate">{accountLabel(account)}</span>
                  <span className="text-muted-foreground truncate text-xs">
                    {accessLabel(presentation.access, t)}
                  </span>
                  <span className="text-muted-foreground truncate text-xs">
                    {recordKindLabel(presentation.recordKind, t)}
                  </span>
                </div>
                {activeId === account.accountId && (
                  <Check className="text-primary ml-2 size-4 shrink-0" />
                )}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}

function accessLabel(
  access: ReturnType<typeof resolveRecordPresentation>["access"],
  t: ReturnType<typeof useTranslations>["t"],
): string {
  if (access === "manage") return t("recordSharing.row.canManage");
  return access === "view-and-add"
    ? t("recordSharing.switcher.canWrite")
    : t("recordSharing.switcher.readOnly");
}

function recordKindLabel(
  recordKind: ReturnType<typeof resolveRecordPresentation>["recordKind"],
  t: ReturnType<typeof useTranslations>["t"],
): string {
  return recordKind === "managed"
    ? t("recordSharing.lookingAfter.kindManaged")
    : t("recordSharing.lookingAfter.kindShared");
}
