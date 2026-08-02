"use client";

import { Loader2, Users } from "lucide-react";

import { GrantRowItem } from "@/components/settings/access/grant-row";
import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useTranslations } from "@/lib/i18n/context";
import { accountLabel } from "@/lib/sharing/account-access-view";
import {
  useAccountGrants,
  useRevokeGrant,
  type GrantRow,
} from "@/lib/queries/use-account-grants";

/**
 * v1.36.0 — who can open this record.
 *
 * The compliance surface: at any moment the owner can see who has access, at
 * what level, since when, and whether it is still being used. Ended grants stay
 * in the list because the row is the consent record.
 *
 * Revoking asks once and then does it. No step-up, no typed confirmation —
 * reducing access must never be harder than granting it was, and the one party
 * here whose intent needs no verification is the person closing their own
 * health record to somebody. The confirm dialog exists only because the click
 * target sits in a list and a mis-tap should not end an access silently; it
 * names the person and the act.
 */
export function GrantsGivenCard() {
  const { t } = useTranslations();
  const { data, isLoading, isError, refetch } = useAccountGrants();
  const revoke = useRevokeGrant();

  const given = data?.given ?? [];

  return (
    <SettingsCard data-slot="grants-given-card">
      <SettingsCardHeader
        icon={Users}
        title={t("recordSharing.given.title")}
        description={t("recordSharing.given.description")}
      />
      <div className="mt-4">
        {isLoading && (
          <Loader2
            className="text-muted-foreground size-5 animate-spin motion-reduce:animate-none"
            aria-label={t("common.loading")}
          />
        )}
        {isError && (
          <QueryErrorCard
            title={t("recordSharing.given.loadError")}
            onRetry={() => void refetch()}
          />
        )}
        {!isLoading && !isError && given.length === 0 && (
          <EmptyState
            icon={<Users className="size-6" />}
            title={t("recordSharing.given.emptyTitle")}
            description={t("recordSharing.given.emptyDescription")}
          />
        )}
        {given.length > 0 && (
          <ul data-slot="grants-given-list" className="divide-y">
            {given.map((grant) => (
              <GrantRowItem
                key={grant.id}
                grant={grant}
                side="given"
                actions={renderRevoke(grant)}
              />
            ))}
          </ul>
        )}
      </div>
    </SettingsCard>
  );

  function renderRevoke(grant: GrantRow) {
    // Only a live grant can be ended. An already-ended row keeps its history
    // and loses its button, rather than offering an act that would 409.
    if (grant.state !== "ACTIVE" && grant.state !== "PENDING") return null;
    const name = accountLabel(grant.account);
    return (
      <ConfirmButton
        slot="grant-revoke"
        size="sm"
        label={
          grant.state === "PENDING"
            ? t("recordSharing.given.withdrawInvite")
            : t("recordSharing.given.revoke")
        }
        title={t("recordSharing.given.revokeTitle", { name })}
        body={t("recordSharing.given.revokeBody", { name })}
        confirmLabel={t("recordSharing.given.revokeConfirm")}
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate(grant.id)}
      />
    );
  }
}
