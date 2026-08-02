"use client";

import { useState } from "react";
import { UserPlus } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api/api-fetch";
import { useTranslations } from "@/lib/i18n/context";
import { useInviteGrant } from "@/lib/queries/use-account-grants";

/**
 * v1.36.0 — offering somebody read access to this record.
 *
 * One field, because there is one decision: who. The access level is not
 * offered — v1 grants read and only read, and a control whose only setting is
 * its default is a promise about a future release rather than a choice about
 * this one.
 *
 * The invitation confers nothing until the other person accepts it. The card
 * says so above the field rather than after the submit, because that is the
 * part somebody needs to know BEFORE they type a name: nothing has been shared
 * yet, and nothing will be until the other side agrees.
 *
 * Errors are named, not generic. "No account with that name" and "that person
 * already has access" are different situations with different next steps, and
 * the server publishes a stable `meta.errorCode` for each precisely so this
 * card does not have to read prose to tell them apart.
 */
export function GrantInviteCard() {
  const { t } = useTranslations();
  const invite = useInviteGrant();
  const [identifier, setIdentifier] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = identifier.trim();
    if (value.length === 0) return;
    setError(null);
    setInvited(null);
    invite.mutate(
      { identifier: value, expiresAt: null },
      {
        onSuccess: (grant) => {
          setIdentifier("");
          setInvited(grant.account.username);
        },
        onError: (err) => setError(t(inviteErrorKey(err))),
      },
    );
  };

  return (
    <SettingsCard data-slot="grant-invite-card">
      <SettingsCardHeader
        icon={UserPlus}
        title={t("recordSharing.invite.title")}
        description={t("recordSharing.invite.description")}
      />
      <form onSubmit={submit} className="mt-4 space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="grant-invite-identifier">
            {t("recordSharing.invite.identifierLabel")}
          </Label>
          <Input
            id="grant-invite-identifier"
            data-slot="grant-invite-identifier"
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
        <Button
          type="submit"
          data-slot="grant-invite-submit"
          disabled={invite.isPending || identifier.trim().length === 0}
        >
          {invite.isPending
            ? t("recordSharing.invite.submitting")
            : t("recordSharing.invite.submit")}
        </Button>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {invited && (
          <p role="status" className="text-sm">
            {t("recordSharing.invite.sent", { name: invited })}
          </p>
        )}
      </form>
    </SettingsCard>
  );
}

/**
 * The message for a refused invitation.
 *
 * Branches on the stable `meta.errorCode` rather than the status alone: a 422
 * covers both a malformed identifier and an invitation somebody addressed to
 * themselves, and telling those two apart is the difference between "fix the
 * field" and "you already have your own record".
 */
function inviteErrorKey(err: unknown): string {
  const code =
    err instanceof ApiError && typeof err.meta?.errorCode === "string"
      ? err.meta.errorCode
      : null;
  switch (code) {
    case "sharing.invite.self":
      return "recordSharing.invite.errorSelf";
    case "sharing.invite.duplicate":
      return "recordSharing.invite.errorDuplicate";
    case "sharing.invite.invalid":
      return "recordSharing.invite.errorInvalid";
    default:
      break;
  }
  if (err instanceof ApiError && err.status === 404) {
    return "recordSharing.invite.errorNoAccount";
  }
  if (err instanceof ApiError && err.status === 429) {
    return "recordSharing.invite.errorRateLimited";
  }
  return "recordSharing.invite.errorFailed";
}
