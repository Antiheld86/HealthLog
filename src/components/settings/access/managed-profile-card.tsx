"use client";

import { UserRoundCog } from "lucide-react";

import { ManagedProfileCreateForm } from "@/components/settings/access/managed-profile-create-form";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { useAuth } from "@/hooks/use-auth";
import { useTranslations } from "@/lib/i18n/context";
import {
  accountLabel,
  type AccountAccessEntry,
} from "@/lib/sharing/account-access-view";

/**
 * v1.37.0 — the records this account looks after.
 *
 * ## Why the list is not a read of its own
 *
 * There is no `GET /api/managed-profiles`, and there does not need to be. A
 * Guardian's relationship to a managed profile IS a MANAGE grant with the
 * profile as grantor, so the profiles somebody looks after are already on
 * `GET /api/auth/me` as the `managed` entries of `accountAccess.accounts` —
 * the same list that paints the switcher. Reading them from anywhere else
 * would be a second answer to a question the account payload already answers,
 * and the two would disagree the first time a grant lapsed.
 *
 * It is also what makes the creation contract simple to state: the new profile
 * appears here, in the switcher and in the banner from ONE invalidation, and
 * if the account payload is not refreshed it appears in none of them.
 *
 * ## Why this card, in this section
 *
 * The section's docblock states the rule — one concept, one section — and this
 * is the same concept from the third side: who can open a record. Two of the
 * cards here are about another adult opening yours or you opening theirs; this
 * one is about a record that exists only because somebody looks after it. A
 * settings area of its own would split "who may open which record" across two
 * pages, which is the split that rule exists to prevent.
 *
 * It sits directly after the invitation card because both are acts, and this
 * one creates the record the other two then talk about.
 */
export function ManagedProfileCard() {
  const { t } = useTranslations();
  const { user } = useAuth();
  const profiles = managedProfilesOf(user?.accountAccess?.accounts);

  return (
    <SettingsCard data-slot="managed-profile-card">
      <SettingsCardHeader
        icon={UserRoundCog}
        title={t("recordSharing.managed.title")}
        description={t("recordSharing.managed.description")}
      />
      <div className="mt-4 space-y-4">
        {/* Content, not meta: this is what somebody is consenting to take on,
            and UI-STANDARDS §3 reserves muted for the incidental. */}
        <p data-slot="managed-profile-explainer" className="text-sm">
          {t("recordSharing.managed.explainer")}
        </p>

        {profiles.length > 0 && (
          <ul data-slot="managed-profile-list" className="divide-y">
            {profiles.map((profile) => (
              <li
                key={profile.accountId}
                data-slot="managed-profile-row"
                data-managed-profile-id={profile.accountId}
                className="py-3 first:pt-0 last:pb-0"
              >
                {/* UI-STANDARDS §11 inline action row. */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {/* A person's name is user data and stays content. */}
                    <p className="truncate text-sm font-medium">
                      {accountLabel(profile)}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {t("recordSharing.lookingAfter.kindManaged")}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        <ManagedProfileCreateForm />
      </div>
    </SettingsCard>
  );
}

/**
 * The managed entries of the account payload, in the order the server sent
 * them.
 *
 * Exported and pure so the filter can be pinned: `recordKind` is server-
 * resolved presentation metadata, and a card that showed every shared record
 * here would offer a delete control for an adult's own account.
 */
export function managedProfilesOf(
  accounts: AccountAccessEntry[] | undefined,
): AccountAccessEntry[] {
  return (accounts ?? []).filter((entry) => entry.recordKind === "managed");
}
