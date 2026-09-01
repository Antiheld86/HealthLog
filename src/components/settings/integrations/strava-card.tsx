"use client";

// v1.28.x — Strava integration card. Thin wrapper over the shared OAuth card
// (per-user BYO OAuth credentials, DB-first then env). Strava is a workout
// source: connecting it syncs your activities into the workout surface, where
// the cross-source picker collapses any twin already captured by a wearable.

import { Activity } from "lucide-react";

import {
  OAuthProviderCard,
  type OAuthProviderStatus,
} from "@/components/settings/integrations/oauth-provider-card";
import type { IntegrationCallbackUrls } from "@/lib/integrations/callback-urls";
import { queryKeys } from "@/lib/query-keys";

export function StravaCard({
  viewModel,
  callbackUrl,
}: {
  viewModel?: OAuthProviderStatus;
  callbackUrl: IntegrationCallbackUrls["strava"];
}) {
  return (
    <OAuthProviderCard
      provider="strava"
      statusQueryKey={queryKeys.strava()}
      i18nPrefix="settings.strava"
      icon={Activity}
      dataHref="/insights/workouts"
      credentials
      viewModel={viewModel}
      callbackUrl={callbackUrl}
    />
  );
}
