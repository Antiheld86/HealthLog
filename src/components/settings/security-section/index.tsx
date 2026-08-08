"use client";

import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { apiGet } from "@/lib/api/api-fetch";
import { PasswordCard } from "@/components/settings/password-card";
import { TotpCard } from "./totp-card";
import { SecurityKeysCard, type WebauthnKeyInfo } from "./security-keys-card";
import { PasskeyListSection } from "./passkey-list-section";
import { PasskeyUpgradeNudge } from "./passkey-upgrade-nudge";

interface MfaStatus {
  totp: { enabled: boolean };
  recoveryCodesRemaining: number;
  webauthn: WebauthnKeyInfo[];
  passkeyNudgeDismissed: boolean;
}

interface PasskeyInfo {
  id: string;
}

export function SecuritySection() {
  const { isAuthenticated } = useAuth();

  const { data: status, isLoading } = useQuery({
    queryKey: queryKeys.mfaStatus(),
    queryFn: async () => apiGet<MfaStatus>("/api/auth/me/mfa"),
    enabled: isAuthenticated,
  });

  // Passkey count drives whether the upgrade nudge shows. Shares the cached
  // `passkeys()` key with the list below, so this is not an extra round-trip.
  const { data: passkeys } = useQuery({
    queryKey: queryKeys.passkeys(),
    queryFn: async () => apiGet<PasskeyInfo[]>("/api/auth/passkeys"),
    enabled: isAuthenticated,
  });

  const showNudge =
    status != null &&
    !status.passkeyNudgeDismissed &&
    passkeys != null &&
    passkeys.length === 0;

  return (
    <div className="space-y-6">
      {showNudge && <PasskeyUpgradeNudge />}

      {isLoading || !status ? (
        <>
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </>
      ) : (
        <>
          <TotpCard
            enabled={status.totp.enabled}
            recoveryCodesRemaining={status.recoveryCodesRemaining}
          />

          <SecurityKeysCard keys={status.webauthn} />

          <PasskeyListSection isAuthenticated={isAuthenticated} />
        </>
      )}

      {/* The password comes last: authenticator, then security keys, then
          passkeys, then the password. It sits OUTSIDE the status conditional
          on purpose — it depends on nothing this page fetches and is the only
          way to change a password now that the Account card is gone, so a
          `/api/auth/me/mfa` that never answers must not take it down with the
          cards that do need the status. */}
      <PasswordCard />
    </div>
  );
}
