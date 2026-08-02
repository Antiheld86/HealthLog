"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { accountLabel } from "@/lib/sharing/account-access-view";
import type { GrantRow, GrantState } from "@/lib/queries/use-account-grants";

/**
 * v1.36.0 — one grant, from either side.
 *
 * The row's whole job is to say what a person can see and since when, without
 * anybody having to read a timestamp and work out the answer. Two rules shape
 * it:
 *
 *   * **The state comes from the server.** `state` is resolved by the same
 *     function the request resolver's predicate is built on. The row renders
 *     it; it never compares `expiresAt` to the clock, because a panel that
 *     said ACTIVE about a grant the server had stopped honouring would be a
 *     second opinion about somebody's access to a health record.
 *   * **Ended rows stay.** A revoked grant is not gone from the list — the row
 *     IS the consent record, and "who had access, from when to when, and who
 *     ended it" is the question the panel exists to answer. It renders muted
 *     with its end named, rather than disappearing as though it never was.
 *
 * The person's name is `text-foreground` (it is the content); every date,
 * level and last-used note is `text-muted-foreground` (they are meta). The
 * status badge carries meaning rather than decoration, so it uses the semantic
 * tokens: active is `success`, an unanswered invitation is `warning`, an ended
 * one is neutral.
 */

const STATE_VARIANT: Record<
  GrantState,
  "default" | "secondary" | "destructive" | "outline"
> = {
  ACTIVE: "default",
  PENDING: "secondary",
  EXPIRED: "outline",
  REVOKED: "outline",
};

export function GrantRowItem({
  grant,
  /** What ended it reads differently depending on who is looking. */
  side,
  actions,
}: {
  grant: GrantRow;
  side: "given" | "received";
  actions?: ReactNode;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();

  const ended = grant.state === "REVOKED" || grant.state === "EXPIRED";

  return (
    <li
      data-slot="grant-row"
      data-grant-id={grant.id}
      data-grant-state={grant.state}
      className="flex flex-wrap items-start justify-between gap-3 py-3"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground truncate text-sm font-medium">
            {accountLabel(grant.account)}
          </span>
          <Badge variant={STATE_VARIANT[grant.state]}>
            {t(`recordSharing.state.${stateKey(grant.state)}`)}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          {grant.access === "WRITE"
            ? t("recordSharing.row.canWrite")
            : t("recordSharing.row.readOnly")}
        </p>
        <dl className="text-muted-foreground space-y-0.5 text-xs">
          <div className="flex flex-wrap gap-x-1">
            <dt>{t("recordSharing.row.invited")}</dt>
            <dd>{fmt.dateTime(new Date(grant.invitedAt))}</dd>
          </div>
          {grant.acceptedAt && (
            <div className="flex flex-wrap gap-x-1">
              <dt>{t("recordSharing.row.accepted")}</dt>
              <dd>{fmt.dateTime(new Date(grant.acceptedAt))}</dd>
            </div>
          )}
          {grant.expiresAt && !ended && (
            <div className="flex flex-wrap gap-x-1">
              <dt>{t("recordSharing.row.expires")}</dt>
              <dd>{fmt.dateTime(new Date(grant.expiresAt))}</dd>
            </div>
          )}
          {grant.state === "ACTIVE" && (
            <div className="flex flex-wrap gap-x-1">
              <dt>{t("recordSharing.row.lastUsed")}</dt>
              {/* Absence reads as absence: a grant that has never been
                  exercised says so, rather than showing a blank. */}
              <dd>
                {grant.lastUsedAt
                  ? fmt.dateTime(new Date(grant.lastUsedAt))
                  : t("recordSharing.row.neverUsed")}
              </dd>
            </div>
          )}
          {grant.revokedAt && (
            <div className="flex flex-wrap gap-x-1">
              <dt>{endedByKey(grant.revokedBy, side, t)}</dt>
              <dd>{fmt.dateTime(new Date(grant.revokedAt))}</dd>
            </div>
          )}
        </dl>
      </div>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </li>
  );
}

function stateKey(state: GrantState): string {
  return state.toLowerCase();
}

/**
 * "You withdrew it" versus "she handed it back" — the same column, read from
 * two sides. `revokedBy` is what makes the distinction possible; conflating
 * them would misreport an ordinary handover as a falling-out.
 */
function endedByKey(
  revokedBy: GrantRow["revokedBy"],
  side: "given" | "received",
  t: (key: string) => string,
): string {
  if (revokedBy === "GRANTOR") {
    return side === "given"
      ? t("recordSharing.row.endedByYou")
      : t("recordSharing.row.endedByOwner");
  }
  if (revokedBy === "GRANTEE") {
    return side === "given"
      ? t("recordSharing.row.handedBack")
      : t("recordSharing.row.endedByYou");
  }
  return t("recordSharing.row.ended");
}
