"use client";

import { Eye, Loader2, LogOut } from "lucide-react";

import { useAccountSwitch } from "@/hooks/use-account-switch";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import { accountLabel } from "@/lib/sharing/account-access-view";

/**
 * v1.36.0 — the strip that says whose record is open.
 *
 * This is the feature, not decoration around it. A caregiver who forgets they
 * are switched will log their own blood pressure into somebody else's record,
 * and there is no undo for a reading that was never theirs. So the banner
 * states three things in one line — that this is not your record, whose it is,
 * and that you can only read it — and carries the way out beside them.
 *
 * ## Why it looks like this
 *
 * Loud on purpose, within the token system. `bg-warning/15` + `border-warning/40`
 * puts it in the one visual register the app reserves for "something about this
 * screen is not normal", above the offline strip and the demo strip in the
 * shell so it is the first line of chrome under any circumstance. Not
 * `destructive` — nothing is broken and nothing is at risk of being lost;
 * warning is the honest register for a context the user has to hold in mind.
 * Not a tint on the page background either: a subtle wash is exactly what
 * somebody stops seeing after the third switch, and the failure mode here is
 * a person who has stopped noticing.
 *
 * The name is `text-foreground` and the qualifier `text-muted-foreground`, per
 * the two-tier text rule — the person's name is content, the read-only note is
 * meta. Mounted for every authenticated route inside `<AuthShell>` (the
 * `<DemoBanner>` pattern) so no page can forget it, and rendered from
 * `accountAccess.active`, which the server resolves: the banner appears exactly
 * when the server says the session is inside a record, never on a client guess.
 *
 * `role="status"` rather than `alert`: assistive tech announces the context
 * once when it appears, without the interrupt an alert implies. `aria-live` is
 * left to the role's implicit `polite`.
 */
export function SharedRecordBanner() {
  const { user } = useAuth();
  const { t } = useTranslations();
  const switchAccount = useAccountSwitch();

  const active = user?.accountAccess?.active ?? null;
  if (!active) return null;

  const name = accountLabel(active);

  return (
    <div
      role="status"
      data-slot="shared-record-banner"
      data-account-id={active.accountId}
      className="bg-warning/15 border-warning/40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b px-3 py-2 text-xs"
    >
      <Eye className="text-foreground size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-foreground text-center font-medium">
        {t("recordSharing.banner.viewing", { name })}
      </span>
      {/* Resolved server-side. `canWrite` is false for every grant in v1, and
          the day it is not, this line stops claiming otherwise on its own. */}
      {!active.canWrite && (
        <span className="text-muted-foreground text-center">
          {t("recordSharing.banner.readOnly")}
        </span>
      )}
      <button
        type="button"
        data-slot="shared-record-banner-exit"
        onClick={() => switchAccount.mutate(null)}
        disabled={switchAccount.isPending}
        className="text-foreground hover:bg-warning/25 focus-visible:ring-ring inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
      >
        {switchAccount.isPending ? (
          <Loader2
            className="size-3.5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
        ) : (
          <LogOut className="size-3.5" aria-hidden="true" />
        )}
        {t("recordSharing.banner.leave")}
      </button>
    </div>
  );
}
