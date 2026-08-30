"use client";

/**
 * v1.17.1 — shared "Setup guide" doc-link for every Settings → Integrations
 * card. Each card paints the same affordance: one discreet, external link to
 * the provider's setup runbook ("was eingeben, wo klicken"). Single-sourced
 * here so all six cards (WHOOP / Withings / Fitbit / Polar / Oura / Nightscout)
 * read as one family and the docs host lives in exactly one place.
 *
 * The runbooks themselves are authored separately; this link wires the
 * destination now so a user who is mid-setup always knows where to go.
 */

import { useSyncExternalStore } from "react";
import { ExternalLink } from "lucide-react";

import { useTranslations } from "@/lib/i18n/context";

/**
 * Base for every provider setup runbook. The provider key is appended as a
 * path segment, e.g. `https://docs.healthlog.dev/integrations/whoop`. Kept as
 * a single constant so the host never drifts across cards.
 */
export const INTEGRATION_DOCS_BASE = "https://docs.healthlog.dev/integrations";

export type IntegrationDocsProvider =
  | "whoop"
  | "withings"
  | "fitbit"
  | "polar"
  | "oura"
  | "nightscout"
  // v1.27.0 — Google Health runbook (docs.healthlog.dev/integrations/google-health).
  | "google-health"
  // v1.28.x — Strava runbook (docs.healthlog.dev/integrations/strava).
  | "strava";

export function integrationDocsHref(provider: IntegrationDocsProvider): string {
  return `${INTEGRATION_DOCS_BASE}/${provider}`;
}

/**
 * The OAuth callback path every BYO-key provider registers against. Every
 * provider's `getRedirectUri()` (`src/lib/{provider}/client.ts`) derives the
 * same shape from `NEXT_PUBLIC_APP_URL` unless an operator overrides it with
 * an explicit `*_REDIRECT_URI` env var — the common case this card targets.
 */
export function integrationCallbackUrl(
  provider: IntegrationDocsProvider,
): string {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "";
  return `${base}/api/${provider}/callback`;
}

/** Shows a compact warning when the callback origin differs from the app. */
export function CallbackMismatchNotice({
  provider,
  callbackUrl,
}: {
  provider: string;
  callbackUrl: string;
}) {
  // Get the current origin of the app
  const { t } = useTranslations();
  const currentOrigin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => null,
  );
  // Get the origin of the callback URL
  const callbackOrigin = (() => {
    try {
      return new URL(callbackUrl).origin;
    } catch {
      return null;
    }
  })();
  if (!currentOrigin || !callbackOrigin || callbackOrigin === currentOrigin) {
    return null;
  }
  // If the callback origin differs from the app, show a warning
  return (
    <span className="text-warning border-warning/30 bg-warning/5 block rounded-md border px-2 py-1 text-xs">
      {t("settings.oauthCallbackPreflightItem", {
        provider,
        configuredOrigin: callbackOrigin,
        currentOrigin,
      })}
    </span>
  );
}

/**
 * v1.29.x (UX audit H2) — compact 3-step BYO-developer-app guide for the
 * six providers that require a self-hoster to register their own vendor
 * app before an OAuth connect can ever succeed (Withings / WHOOP / Fitbit /
 * Polar / Oura / Strava). The external "Setup guide" link explains the
 * *why*; this inline callout gives the one value every vendor form asks
 * for and the app already knows — the callback URL — so it doesn't have to
 * be reconstructed by hand from the docs. Shown only while the user hasn't
 * saved their own credentials yet; it steps out of the way once configured.
 */
export function IntegrationRedirectGuide({
  provider,
  providerLabel,
}: {
  provider: IntegrationDocsProvider;
  providerLabel: string;
}) {
  const { t } = useTranslations();
  const callbackUrl = integrationCallbackUrl(provider);
  return (
    <div
      className="bg-muted/40 border-border/60 space-y-1.5 rounded-md border p-3 text-xs"
      data-testid={`${provider}-redirect-guide`}
    >
      <p className="text-muted-foreground">
        {t("settings.integrationRedirectGuide.intro", {
          provider: providerLabel,
        })}
      </p>
      <ol className="text-muted-foreground list-decimal space-y-1 pl-4">
        <li>
          {t("settings.integrationRedirectGuide.step1", {
            provider: providerLabel,
          })}
        </li>
        <li>
          {t("settings.integrationRedirectGuide.step2")}{" "}
          <code
            className="bg-background text-foreground rounded px-1 py-0.5 font-mono break-all"
            data-testid={`${provider}-redirect-uri`}
          >
            {callbackUrl}
          </code>
        </li>
        <li>{t("settings.integrationRedirectGuide.step3")}</li>
      </ol>
    </div>
  );
}

/**
 * The one description every integration card paints: ONE sentence, then the
 * setup-guide link inline at the end of it.
 *
 * It used to be two paragraphs stacked in the description slot — a white
 * primary sentence and a grey secondary one whose only job was to carry the
 * link. The secondary sentence was byte-identical across six of the eight
 * cards, which is the tell: it said nothing about the provider it sat under.
 * The link is the part that carried information, so the link is what stayed.
 */
export function IntegrationCardDescription({
  i18nPrefix,
  provider,
}: {
  i18nPrefix: string;
  provider: IntegrationDocsProvider;
}) {
  const { t } = useTranslations();
  return (
    <>
      {t(`${i18nPrefix}Description`)}{" "}
      <a
        href={integrationDocsHref(provider)}
        target="_blank"
        rel="noopener noreferrer"
        data-testid={`${provider}-setup-guide`}
        data-slot="integration-setup-guide"
        className="hover:text-foreground inline-flex items-center gap-1 underline underline-offset-2"
      >
        {t("settings.integrationSetupGuide")}
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>
    </>
  );
}
