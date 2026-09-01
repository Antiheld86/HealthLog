"use client";

// v1.17.0 (F4) — Polar AccessLink integration card. Thin wrapper over the
// shared OAuth card.
// v1.17.1 — per-user BYO OAuth credentials (DB-first then env).

import { Watch } from "lucide-react";

import {
  OAuthProviderCard,
  type OAuthProviderStatus,
} from "@/components/settings/integrations/oauth-provider-card";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";
import { queryKeys } from "@/lib/query-keys";

export function PolarCard({
  viewModel,
  callbackUrl,
}: {
  viewModel?: OAuthProviderStatus;
  callbackUrl: IntegrationCallbackUrls["polar"];
}) {
  return (
    <OAuthProviderCard
      provider="polar"
      statusQueryKey={queryKeys.polar()}
      i18nPrefix="settings.polar"
      icon={Watch}
      dataHref="/insights/sleep"
      credentials
      viewModel={viewModel}
      callbackUrl={callbackUrl}
    />
  );
}
