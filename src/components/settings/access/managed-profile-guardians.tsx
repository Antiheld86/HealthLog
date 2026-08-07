"use client";

import { useState } from "react";

import {
  GrantActionAlert,
  grantActionErrorKey,
  stepUpErrorKey,
} from "@/components/settings/access/grant-action-error";
import { endOfDayIso } from "@/components/settings/access/grant-invite-card";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { ApiError } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  useInviteManagedProfileGuardian,
  useRemoveManagedProfileGuardian,
  type ManagedProfileGuardian,
} from "@/lib/queries/use-managed-profiles";
import { accountLabel } from "@/lib/sharing/account-access-view";
import { DEFAULT_TIMEZONE, isValidTimezone } from "@/lib/tz/format";

/**
 * v1.37.0 — who else looks after this record, and how that changes.
 *
 * ## The floor is stated, and still enforced
 *
 * A managed profile may never be left with nobody looking after it. The server
 * enforces that by refusing the removal (409
 * `managed_profile.guardian.required`) and by counting only ACCEPTED,
 * unexpired MANAGE grants — `activeGuardianWhere`. This panel says the same
 * thing BEFORE the click, from the roster it is already showing, because
 * discovering a floor as a refusal after inviting somebody is the state the
 * release goal asks us to end.
 *
 * The pre-emptive statement is a courtesy and not the enforcement. The roster
 * can be seconds stale, another Guardian can renounce between the render and
 * the click, and the server is the only authority — so the 409 arm stays wired
 * through `grant-action-error.tsx` regardless. A surface that hid the control
 * AND dropped the refusal handler would fail silently the one time it matters.
 *
 * ## Why nobody can end their own access here
 *
 * `revokeManagedProfileGuardian` refuses a target grant whose grantee is the
 * caller, and the route turns that into the same 404 an unknown profile gets.
 * So a self-removal control would be a button that always fails. The way for a
 * Guardian to step away is the renounce control on "What I can open", which is
 * the same act from the delegate's own side and already carries the
 * last-Guardian refusal. The card says so rather than offering a dead control
 * or leaving somebody to hunt for it.
 *
 * That also means the last-ACTIVE-Guardian case and the own-row case coincide:
 * to see this roster at all you must be an active Guardian of the profile, so
 * "one ACTIVE Guardian" always means "you". The sentence names all three ways
 * forward — invite somebody who accepts, hand your own access back, or delete
 * the profile.
 *
 * ## The pending truth
 *
 * `inviteManagedProfileGuardian` mints the grant PENDING, through the ordinary
 * invitation flow, and the invitee accepts it on their own shared-access panel.
 * Until they do, they do not count. A Guardian who invites somebody and then
 * tries to leave is still refused, and no wording in the product said so before
 * this.
 */
export function ManagedProfileGuardians({
  profileId,
  profileName,
  roster,
}: {
  profileId: string;
  profileName: string;
  /** The resolved roster. The caller withholds this panel until it arrives. */
  roster: ManagedProfileGuardian[];
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { user } = useAuth();
  const invite = useInviteManagedProfileGuardian();
  const remove = useRemoveManagedProfileGuardian();

  const [identifier, setIdentifier] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [invited, setInvited] = useState<string | null>(null);

  const timezone = isValidTimezone(user?.timezone ?? "")
    ? (user?.timezone as string)
    : DEFAULT_TIMEZONE;
  const active = roster.filter((g) => g.state === "ACTIVE");
  const soleGuardian = active.length <= 1;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = identifier.trim();
    if (value.length === 0 || invite.isPending) return;
    setInvited(null);
    invite.mutate(
      {
        profileId,
        identifier: value,
        expiresAt: endOfDayIso(expiresOn, timezone),
      },
      {
        onSuccess: () => {
          setIdentifier("");
          setExpiresOn("");
          setInvited(value);
        },
      },
    );
  };

  return (
    <div data-slot="managed-profile-guardians" className="space-y-3">
      <h3 className="text-sm font-medium">
        {t("recordSharing.managed.guardiansTitle", { name: profileName })}
      </h3>

      <ul data-slot="managed-profile-guardian-list" className="divide-y">
        {roster.map((guardian) => {
          const isSelf = guardian.account.id === user?.id;
          // A PENDING invitation can always be withdrawn: it confers nothing,
          // so ending it cannot strand the record. The floor only ever bites
          // on an ACTIVE row, and the only ACTIVE row that could be the last
          // one is the caller's own — which the route refuses anyway.
          const removable = !isSelf;
          const failed =
            remove.isError && remove.variables?.grantId === guardian.grantId;
          return (
            <li
              key={guardian.grantId}
              data-slot="managed-profile-guardian"
              data-guardian-grant-id={guardian.grantId}
              data-guardian-state={guardian.state}
              className="space-y-2 py-3 first:pt-0 last:pb-0"
            >
              {/* UI-STANDARDS §11 inline action row. */}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {accountLabel(guardian.account)}
                    {isSelf ? ` ${t("recordSharing.managed.guardianYou")}` : ""}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {guardian.state === "ACTIVE" && guardian.acceptedAt
                      ? t("recordSharing.managed.guardianSince", {
                          date: fmt.dateTime(new Date(guardian.acceptedAt)),
                        })
                      : t("recordSharing.managed.guardianPending", {
                          date: fmt.dateTime(new Date(guardian.invitedAt)),
                        })}
                  </p>
                </div>
                {removable && (
                  <div className="flex shrink-0 items-center">
                    <ConfirmButton
                      slot="managed-profile-guardian-remove"
                      size="sm"
                      className="min-h-11 sm:min-h-9"
                      label={t("recordSharing.managed.guardianRemove")}
                      title={t("recordSharing.managed.guardianRemoveTitle", {
                        name: accountLabel(guardian.account),
                      })}
                      body={t(
                        guardian.state === "PENDING"
                          ? "recordSharing.managed.guardianWithdrawBody"
                          : "recordSharing.managed.guardianRemoveBody",
                        {
                          name: accountLabel(guardian.account),
                          profile: profileName,
                        },
                      )}
                      confirmLabel={t(
                        "recordSharing.managed.guardianRemoveConfirm",
                      )}
                      pending={remove.isPending}
                      onConfirm={() =>
                        remove.mutate({
                          profileId,
                          grantId: guardian.grantId,
                        })
                      }
                    />
                  </div>
                )}
              </div>
              {failed && (
                <GrantActionAlert
                  grantId={guardian.grantId}
                  message={t(
                    grantActionErrorKey(remove.error, "removeGuardian"),
                  )}
                  retrying={remove.isPending}
                  onRetry={() =>
                    remove.mutate({ profileId, grantId: guardian.grantId })
                  }
                />
              )}
            </li>
          );
        })}
      </ul>

      {soleGuardian && (
        // Content, not meta: it is the reason a control somebody is looking
        // for is not on the screen.
        <p data-slot="managed-profile-sole-guardian" className="text-sm">
          {t("recordSharing.managed.soleGuardian", { name: profileName })}
        </p>
      )}

      <form
        onSubmit={submit}
        data-slot="managed-profile-guardian-invite"
        className="space-y-3"
      >
        <div className="space-y-1.5">
          <Label htmlFor={`managed-guardian-identifier-${profileId}`}>
            {t("recordSharing.managed.guardianInviteLabel")}
          </Label>
          <Input
            id={`managed-guardian-identifier-${profileId}`}
            data-slot="managed-profile-guardian-identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t("recordSharing.invite.identifierPlaceholder")}
            autoComplete="off"
            maxLength={255}
          />
          <p className="text-muted-foreground text-xs">
            {t("recordSharing.invite.identifierHint")}
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`managed-guardian-expires-${profileId}`}>
            {t("recordSharing.invite.expiresLabel")}
          </Label>
          <DateField
            id={`managed-guardian-expires-${profileId}`}
            data-slot="managed-profile-guardian-expires"
            data-testid={`managed-guardian-expires-input-${profileId}`}
            value={expiresOn}
            onChange={setExpiresOn}
            aria-describedby={`managed-guardian-expires-hint-${profileId}`}
          />
          <p
            id={`managed-guardian-expires-hint-${profileId}`}
            className="text-muted-foreground text-xs"
          >
            {t("recordSharing.managed.guardianExpiresHint")}
          </p>
        </div>
        {/* The truth the routes enforce and no wording stated. It sits ABOVE
            the button, where it is part of the decision, rather than below it
            where it would be a disclaimer. */}
        <p data-slot="managed-profile-pending-note" className="text-sm">
          {t("recordSharing.managed.guardianPendingNote")}
        </p>
        <Button
          type="submit"
          data-slot="managed-profile-guardian-submit"
          disabled={invite.isPending || identifier.trim().length === 0}
        >
          {invite.isPending
            ? t("recordSharing.managed.guardianInviting")
            : t("recordSharing.managed.guardianInvite")}
        </Button>
        {invite.isError && (
          <p
            role="alert"
            data-slot="managed-profile-guardian-error"
            className="text-destructive text-sm"
          >
            {t(guardianInviteErrorKey(invite.error))}
          </p>
        )}
        {invited && (
          <p
            role="status"
            data-slot="managed-profile-guardian-invited"
            className="text-sm"
          >
            {t("recordSharing.managed.guardianInvited", { name: invited })}
          </p>
        )}
      </form>
    </div>
  );
}

/**
 * The message for a refused Guardian invitation.
 *
 * Six refusals, and **two of them carry no `errorCode`** — the rate limit
 * (`guardians/route.ts`, before the body is even read) and the unknown-account
 * 404. That asymmetry is the route's actual shape, not laziness here: the
 * other four arms publish a stable code and are matched on it, and these two
 * have to be told apart by status because there is nothing else to branch on.
 * Recorded in `02-13.1-CONTRACT-FINDINGS.md` so whoever freezes the contract
 * decides deliberately whether to close it.
 *
 * The code switch runs FIRST, and the order matters: `managed_profile.not_found`
 * is a 404 WITH a code, and an unknown account is a 404 without one. Branching
 * on status first would tell somebody to check the spelling of a name when the
 * real answer is that they are not a Guardian of that profile any more.
 */
export function guardianInviteErrorKey(err: unknown): string {
  if (!(err instanceof ApiError)) return "recordSharing.managed.errorOffline";

  const code =
    typeof err.meta?.errorCode === "string" ? err.meta.errorCode : null;
  switch (code) {
    // There is deliberately NO arm for `managed_profile.guardian.self`. The
    // route declares one, and it cannot fire: `self_grant` needs the grantor
    // to equal the grantee, and the grantor here is the profile rather than
    // the caller — while naming the profile itself is caught one line earlier
    // as a managed invitee. Inviting yourself arrives as `duplicate`, which is
    // both true and the useful sentence. A client arm for a code the server
    // cannot send would be a branch nothing can reach.
    case "managed_profile.guardian.duplicate":
      return "recordSharing.managed.guardianErrorDuplicate";
    case "managed_profile.guardian.managed_invitee":
      return "recordSharing.managed.guardianErrorManagedInvitee";
    case "managed_profile.not_found":
      return "recordSharing.actionError.profileNotFound";
    default:
      break;
  }

  // The two codeless arms. Waiting is the recovery for one and correcting the
  // identifier is the recovery for the other, so they must not collapse.
  if (err.status === 429) return "recordSharing.managed.guardianErrorRateLimit";
  if (err.status === 404) return "recordSharing.managed.guardianErrorNoAccount";
  // The step-up gate this whole family carries. Not a failure — and it comes
  // in two shapes, because an account with no factor enrolled cannot clear it.
  if (err.status === 401) return stepUpErrorKey(err);
  return "recordSharing.managed.guardianErrorFailed";
}
