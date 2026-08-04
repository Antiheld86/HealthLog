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
 * v1.36.0 — offering somebody access to this record.
 *
 * Two decisions: who, and what they may do. The level is a choice at the
 * invitation and only there — a grant is READ or WRITE from the moment it is
 * offered, nothing widens it later, and the way to a wider one is a fresh
 * invitation the other person accepts again. So this form is the one screen
 * where the owner's half of that consent is given, and the option labels have
 * to be worth reading.
 *
 * The capability sentences say what actually ships rather than the word
 * "write", which people read as larger than it is. A delegate can ADD:
 * readings, results, observations, a medication, a dose marked as taken. They
 * cannot edit or delete anything, including what they added ten seconds ago.
 * A person who learns that from a support reply rather than from this card was
 * not told.
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
  const [expiresOn, setExpiresOn] = useState("");
  // READ preselected. The narrower level is the one somebody should have to
  // choose their way out of, not into.
  const [access, setAccess] = useState<GrantAccessLevel>("READ");
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<string | null>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = identifier.trim();
    if (value.length === 0) return;
    setError(null);
    setInvited(null);
    invite.mutate(
      { identifier: value, access, expiresAt: endOfDayIso(expiresOn) },
      {
        onSuccess: (grant) => {
          setIdentifier("");
          setExpiresOn("");
          setAccess("READ");
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
        <fieldset className="space-y-1.5" data-slot="grant-invite-access">
          {/* The `Label` primitive is a `<label>` and cannot name a group, so
              the legend mirrors its type and its trailing colon by hand rather
              than mislabelling one radio as the heading of both. */}
          <legend className="pl-1 text-sm leading-none font-medium after:content-[':']">
            {t("recordSharing.invite.accessLegend")}
          </legend>
          <div className="space-y-2">
            <AccessOption
              level="READ"
              selected={access === "READ"}
              onSelect={() => setAccess("READ")}
              label={t("recordSharing.invite.accessReadLabel")}
              capability={t("recordSharing.invite.accessReadCapability")}
            />
            <AccessOption
              level="WRITE"
              selected={access === "WRITE"}
              onSelect={() => setAccess("WRITE")}
              label={t("recordSharing.invite.accessWriteLabel")}
              capability={t("recordSharing.invite.accessWriteCapability")}
            />
          </div>
        </fieldset>
        <div className="space-y-1.5">
          <Label htmlFor="grant-invite-expires">
            {t("recordSharing.invite.expiresLabel")}
          </Label>
          <Input
            id="grant-invite-expires"
            data-slot="grant-invite-expires"
            type="date"
            value={expiresOn}
            min={tomorrowIso()}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            {t("recordSharing.invite.expiresHint")}
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

/** The two levels an invitation can carry, as the client names them. */
export type GrantAccessLevel = "READ" | "WRITE";

/**
 * One level, with the sentence that says what it actually does.
 *
 * The capability line is not decoration and it is not a tooltip: it is the
 * part the owner is consenting to, so it sits under the label where it has to
 * be read past rather than behind an info icon. Muted because it describes the
 * option rather than being the option (UI-STANDARDS §3), `text-xs` because
 * that is the meta floor.
 */
function AccessOption({
  level,
  selected,
  onSelect,
  label,
  capability,
}: {
  level: GrantAccessLevel;
  selected: boolean;
  onSelect: () => void;
  label: string;
  capability: string;
}) {
  return (
    <label
      data-slot="grant-invite-access-option"
      data-access={level}
      data-selected={selected ? "true" : "false"}
      className={[
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
        // The radio itself is `sr-only`, so the browser's own focus ring lands
        // on a zero-size box: keyboard focus moved through this fieldset with
        // nothing visible moving with it. WCAG 2.4.7, on the screen where
        // somebody decides who may write into their health record. The label
        // wears the ring instead, on the same `ring-ring/50 ring-2` token the
        // capture picker's options use.
        "has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-2",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/40",
      ].join(" ")}
    >
      <input
        type="radio"
        name="grant-invite-access"
        value={level}
        checked={selected}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="space-y-1">
        <span className="text-foreground block text-sm font-medium">
          {label}
        </span>
        <span className="text-muted-foreground block text-xs">
          {capability}
        </span>
      </span>
    </label>
  );
}

/**
 * The chosen day, as the instant access stops.
 *
 * A date input yields a bare `YYYY-MM-DD`, and the grant's `expiresAt` is
 * checked live against `now` on every request. Anchoring at the END of the
 * chosen day in the browser's own zone is what makes "until the 30th" mean the
 * 30th rather than the midnight that starts it, which is the reading anybody
 * picking a date has in mind. Empty means no lapse date, which is the default
 * and stays the common case.
 */
export function endOfDayIso(day: string): string | null {
  if (day.length === 0) return null;
  const end = new Date(`${day}T23:59:59.999`);
  return Number.isNaN(end.getTime()) ? null : end.toISOString();
}

/** The earliest day worth offering: a grant that lapses today confers nothing. */
function tomorrowIso(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
