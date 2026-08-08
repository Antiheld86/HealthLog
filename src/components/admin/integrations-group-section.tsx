"use client";

/**
 * `<IntegrationsGroupSection>` — composite admin route at `/admin/integrations`.
 *
 * Wraps the standalone integration sub-sections (Umami, GlitchTip, Web Push)
 * under one route so each existing component stays the source of truth for its
 * own settings while admins still get a single landing page.
 *
 * No wrapper element: `SectionFrame` already stacks its children at
 * `space-y-6`, so a second identical stack here was one nesting level with
 * no effect.
 */

import { GlitchtipSection } from "./glitchtip-section";
import { UmamiSection } from "./umami-section";
import { WebPushVapidSection } from "./web-push-vapid-section";

export function IntegrationsGroupSection() {
  return (
    <>
      <UmamiSection />
      <GlitchtipSection />
      <WebPushVapidSection />
    </>
  );
}
