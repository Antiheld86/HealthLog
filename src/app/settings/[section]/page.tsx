import { notFound } from "next/navigation";
import type { JSX } from "react";

import { AccessSection } from "@/components/settings/access-section";
import { AccountSection } from "@/components/settings/account-section";
import { AnamnesisSection } from "@/components/settings/anamnesis-section";
import { SecuritySection } from "@/components/settings/security-section";
import { AboutSection } from "@/components/settings/about-section";
import { AdvancedSection } from "@/components/settings/advanced-section";
import { AiSection } from "@/components/settings/ai-section";
import { ApiSection } from "@/components/settings/api-section";
import { CoachSection } from "@/components/settings/coach-section";
import { DashboardSection } from "@/components/settings/dashboard-section";
import { EnvironmentSection } from "@/components/settings/environment-section";
import { ExportSection } from "@/components/settings/export-section";
import { GesundheitsakteSection } from "@/components/settings/gesundheitsakte-section";
import { IllnessSection } from "@/components/settings/illness-section";
import { InsightsSection } from "@/components/settings/insights-section";
import { IntegrationsSection } from "@/components/settings/integrations-section";
import { LabsSection } from "@/components/settings/labs-section";
import { LayoutSection } from "@/components/settings/layout-section";
import { MedicationsSection } from "@/components/settings/medications-section";
import { McpSection } from "@/components/settings/mcp-section";
import { ModulesSection } from "@/components/settings/modules-section";
import { MoodSection } from "@/components/settings/mood-section";
import { NotificationsSection } from "@/components/settings/notifications-section";
import { PrivacySection } from "@/components/settings/privacy-section";
import { ScoreSection } from "@/components/settings/score-section";
import { SectionPlaceholder } from "@/components/settings/section-placeholder";
import { VorsorgeSection } from "@/components/settings/vorsorge-section";
// v1.18.1 (D4) — `sources` is a standalone left-side entry (split out of the
// Integrations sub-tabs). v1.25.3 — `channels` folded into Notifications.
import { SharingSection } from "@/components/settings/sharing-section";
import { SourcesSection } from "@/components/settings/sources-section";
import { ThresholdsSection } from "@/components/settings/thresholds-section";
import {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
} from "@/components/settings/section-slugs";
import { SettingsShell } from "@/components/settings/settings-shell";
import { RecordSettingsSectionGate } from "@/components/settings/record-settings-section-gate";

/**
 * Dynamic settings section route. Each of the `SETTINGS_SECTION_SLUGS`
 * is pre-rendered at build via
 * `generateStaticParams()` so the URLs are
 * statically known to Next.js, while the `dynamicParams = false` flag below
 * tells the router to 404 (instead of attempting on-demand rendering) for any
 * slug not in the list — which is exactly what `notFound()` would do at
 * request time, just earlier and without rendering.
 */

export const dynamicParams = false;

export function generateStaticParams() {
  return SETTINGS_SECTION_SLUGS.map((section) => ({ section }));
}

const SECTION_COMPONENTS: Record<
  SettingsSectionSlug,
  () => JSX.Element | null
> = {
  account: AccountSection,
  access: AccessSection,
  security: SecuritySection,
  modules: ModulesSection,
  about: AboutSection,
  ai: AiSection,
  coach: CoachSection,
  integrations: IntegrationsSection,
  sources: SourcesSection,
  notifications: NotificationsSection,
  layout: LayoutSection,
  dashboard: DashboardSection,
  insights: InsightsSection,
  medications: MedicationsSection,
  mood: MoodSection,
  labs: LabsSection,
  illness: IllnessSection,
  environment: EnvironmentSection,
  anamnesis: AnamnesisSection,
  score: ScoreSection,
  vorsorge: VorsorgeSection,
  thresholds: ThresholdsSection,
  api: ApiSection,
  mcp: McpSection,
  gesundheitsakte: GesundheitsakteSection,
  sharing: SharingSection,
  export: ExportSection,
  advanced: AdvancedSection,
  privacy: PrivacySection,
};

interface PageProps {
  // Next.js 16 made route `params` an async Promise. We `await` it before use.
  params: Promise<{ section: string }>;
}

export default async function SettingsSectionPage({ params }: PageProps) {
  const { section } = await params;

  // Defence-in-depth — `dynamicParams = false` already 404s unknown slugs at
  // routing time, but we re-check here so a hand-rolled override of the route
  // config can never silently fall through to a typo'd slug.
  if (!isSettingsSectionSlug(section)) {
    notFound();
  }

  const SectionComponent = SECTION_COMPONENTS[section];
  // Defensive fallback: in theory unreachable since `isSettingsSectionSlug`
  // guards the slug, but a future slug added to `SETTINGS_SECTION_SLUGS`
  // without a wired component would otherwise crash silently — placeholder
  // surfaces the gap visually instead.
  // v1.18.6.1 — the heading + subtitle (and the Layout-hub "← back" link)
  // now live in `<SettingsShell>`, which places them in their own grid row
  // spanning only the content column so the left nav's first item lines up
  // with the top of the first card. The page body is pure card content,
  // wrapped in the labelled `<section>` so the historic
  // `settings-section-<slug>-title` `aria-labelledby` linkage still resolves.
  const body = SectionComponent ? (
    <section
      aria-labelledby={`settings-section-${section}-title`}
      className="space-y-6"
    >
      <SectionComponent />
    </section>
  ) : (
    <SectionPlaceholder slug={section} />
  );

  return (
    <SettingsShell active={section}>
      <RecordSettingsSectionGate section={section}>
        {body}
      </RecordSettingsSectionGate>
    </SettingsShell>
  );
}
