"use client";

// v1.17.0 (F4) — Oura Cloud integration card. Thin wrapper over the shared
// OAuth card.
// v1.17.1 — per-user BYO OAuth credentials (DB-first then env).

import { CircleDot } from "lucide-react";

import {
  OAuthProviderCard,
  type OAuthProviderStatus,
} from "@/components/settings/integrations/oauth-provider-card";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";
import { queryKeys } from "@/lib/query-keys";

export function OuraCard({
  viewModel,
  callbackUrl,
}: {
  viewModel?: OAuthProviderStatus;
  callbackUrl: IntegrationCallbackUrls["oura"];
}) {
  return (
    <OAuthProviderCard
      provider="oura"
      statusQueryKey={queryKeys.oura()}
      i18nPrefix="settings.oura"
      icon={CircleDot}
      dataHref="/insights/sleep"
      credentials
      viewModel={viewModel}
      callbackUrl={callbackUrl}
    />
  );
}
