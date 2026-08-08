"use client";

/**
 * `<SettingsShell>` — sidebar + main column shell for the v1.4 settings split.
 *
 * Each section lives at its own route (`/settings/[section]/page.tsx`) and
 * mounts inside this shell. The shell owns nothing but navigation: the active
 * section is read from the route, the section heading + content are rendered
 * by the page itself.
 *
 * Mobile-first per `docs/ui-guidelines.md`:
 *   - <md: section selector renders as a horizontal scroll strip at the top so
 *     a thumb-tap can swap sections without leaving the viewport.
 *   - >=md: sticky 220px sidebar + content column with `max-w-screen-xl`.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Blocks,
  Bot,
  ClipboardList,
  CloudSun,
  Download,
  FileHeart,
  Gauge,
  Info,
  KeyRound,
  Plug,
  Layers,
  Link2,
  Lock,
  Palette,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  User,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import { SUB_SHELL_GRID_FLOOR } from "@/components/layout/shell-metrics";
import { useAuth } from "@/hooks/use-auth";
import { useMounted } from "@/hooks/use-mounted";
import { useTranslations } from "@/lib/i18n/context";
import type { ModuleKey } from "@/lib/modules/registry";
import { classifySettingsDestination } from "@/lib/record-settings";
import {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
} from "./section-slugs";
import { SettingsHubBackLink } from "./settings-hub-back-link";

// Re-export so existing call-sites importing from this module keep working.
// New server-side call-sites (e.g. `generateStaticParams()`) should import
// from `./section-slugs` directly, since this file is `"use client"` and
// values exported from a client module become unusable proxies on the
// server. (Discovered the hard way: `SETTINGS_SECTION_SLUGS.map(...)` in
// `generateStaticParams()` blows up at build time when imported through a
// client boundary.)
export {
  SETTINGS_SECTION_SLUGS,
  isSettingsSectionSlug,
  type SettingsSectionSlug,
};

/**
 * 2026-07-17 UX/IA audit (M6) — the sidebar's 19 entries render under one
 * of these seven non-interactive group headers instead of as one flat
 * list. Presentation only: no slug, route, or redirect changes. Order
 * below is the render order of the groups themselves.
 */
export type SettingsSectionGroup =
  | "account"
  | "yourData"
  | "display"
  | "healthProfile"
  | "ai"
  | "connectivity"
  | "system";

/** i18n key for each group's header label, under `settings.shell.groups.*`. */
export const SETTINGS_SECTION_GROUP_LABEL_KEYS: Record<
  SettingsSectionGroup,
  string
> = {
  account: "settings.shell.groups.account",
  yourData: "settings.shell.groups.yourData",
  display: "settings.shell.groups.display",
  healthProfile: "settings.shell.groups.healthProfile",
  ai: "settings.shell.groups.ai",
  connectivity: "settings.shell.groups.connectivity",
  system: "settings.shell.groups.system",
};

interface SettingsSection {
  slug: SettingsSectionSlug;
  /** i18n key under `settings.sections.<slug>.title`. */
  titleKey: string;
  icon: LucideIcon;
  /** 2026-07-17 UX/IA audit (M6) — which sidebar group this entry renders under. */
  group: SettingsSectionGroup;
  /**
   * v1.18.0 (S5) — per-submodule entries are listed only when their module
   * is enabled. When set, the nav entry hides if the resolved
   * `useAuth().user.modules` map has the key explicitly `false`. The gate
   * fails OPEN (a missing key reads as enabled) so a stale `/me` payload
   * never blanks an entry. Omitted = always shown (global / CORE entries).
   */
  moduleGate?: ModuleKey;
}

/**
 * Source of truth for the section list that the settings shell renders
 * in its sidebar + mobile chip-strip.
 *
 * 2026-07-17 UX/IA audit (M6) — the list used to render in a single flat
 * order with no visual structure (19 entries deep, the AI cluster and the
 * programmatic-access cluster interleaved, the health-profile pair split
 * across the list). It is now clustered into the seven
 * `SettingsSectionGroup`s, each entry carrying its `group`; the list is
 * pre-ordered by group and the shell inserts a non-interactive header
 * before the first VISIBLE entry of each group. This is a presentation-only
 * reorder — no slug, route, or redirect changed, and `SETTINGS_SECTION_SLUGS`
 * (`section-slugs.ts`, which also carries the page-only slugs and drives
 * `generateStaticParams()`) is untouched.
 *
 * "About" sits at the end of the list (System group). v1.4.33 IW7 had
 * folded it into the sidebar user-card dropdown only, which left
 * `/settings/about` an orphaned route — reachable by URL but discoverable
 * nowhere in the settings navigation. It is now both a regular shell entry
 * and a user-card dropdown item ("Über HealthLog" / "About HealthLog").
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  // ── Account ──
  {
    slug: "account",
    titleKey: "settings.sections.account.title",
    icon: User,
    group: "account",
  },
  // v1.23 — the account-security home: second factors, recovery codes,
  // passkey management.
  {
    slug: "security",
    titleKey: "settings.sections.security.title",
    icon: ShieldCheck,
    group: "account",
  },
  // v1.36.0 — who else may open this record, and whose this account may open.
  // In the Account group beside Security: both answer "who can get at my
  // account and what have they done", and a person looking for one will look
  // where the other is.
  {
    slug: "access",
    titleKey: "settings.sections.access.title",
    icon: UsersRound,
    group: "account",
  },
  // v1.23 — "Data & Privacy" assembles the export / deletion / retention /
  // encryption / session / activity pieces into one coherent privacy pane.
  {
    slug: "privacy",
    titleKey: "settings.sections.privacy.title",
    icon: Lock,
    group: "account",
  },
  // ── Your data ──
  // v1.18.0 — the "Was du trackst" hub: the front door for enabling /
  // disabling the secondary tracking domains.
  {
    slug: "modules",
    titleKey: "settings.sections.modules.title",
    icon: Blocks,
    group: "yourData",
  },
  {
    slug: "integrations",
    titleKey: "settings.sections.integrations.title",
    icon: Link2,
    group: "yourData",
  },
  // v1.18.1 (D4) — Quellen (source weighting): which connection wins when
  // two report the same metric. v1.25.3 — Kanäle (delivery channels) folded
  // back into Notifications as an in-page group;
  // `/settings/channels` 301-redirects to `/settings/notifications#channels`.
  {
    slug: "sources",
    titleKey: "settings.sections.sources.title",
    icon: Layers,
    group: "yourData",
  },
  // v1.18.0 (S5) — the full health record (PDF + FHIR R4 + zip package).
  // v1.18.6.1 — NOT module-gated: the health record is a flagship export
  // capability; gating its only entry-point on the `doctorReport` opt-out
  // meant a stray toggle in the Modules hub made the whole section vanish
  // with no in-context way back. The `doctorReport` module still governs
  // the data layer server-side (403 `module.disabled` over Bearer).
  {
    slug: "gesundheitsakte",
    titleKey: "settings.sections.gesundheitsakte.title",
    icon: FileHeart,
    group: "yourData",
  },
  // v1.25.7 — clinician share links fold into the Gesundheitsakte section as
  // a labelled "Sharing" group; `/settings/sharing` 301-redirects there.
  {
    slug: "export",
    titleKey: "settings.sections.export.title",
    icon: Download,
    group: "yourData",
  },
  // ── Display ──
  // v1.17.1 (F-2) — one nav entry replaces the four scattered Dashboard /
  // Insights / Medications / Mood "arrange" entries; those routes still
  // resolve, reached through this hub. v1.25.3 — renamed to "Appearance" /
  // "Darstellung" and widened into the index for every module's
  // view/sort/order surface (the slug stays `layout`). v1.25.11 (#148) —
  // each module lives on its own subpage at `/settings/layout/<module>`;
  // the old per-module routes 301-redirect there.
  {
    slug: "layout",
    titleKey: "settings.sections.layout.title",
    icon: Palette,
    group: "display",
  },
  // v1.25.7 — Vorsorge (preventive-care reminders) folded into
  // "Darstellung"; `/settings/vorsorge` 301-redirects to
  // `/settings/layout/vorsorge`.
  {
    slug: "thresholds",
    titleKey: "settings.sections.thresholds.title",
    icon: SlidersHorizontal,
    group: "display",
  },
  // v1.18.0 (S4) — "Benachrichtigungen" is the single module-gated
  // reminder-types home; the standalone "Erinnerungen" hub is gone.
  {
    slug: "notifications",
    titleKey: "settings.sections.notifications.title",
    icon: Bell,
    group: "display",
  },
  // ── Health profile ──
  // v1.35.0 — which pillars count toward the Health Score. Sits at the top
  // of the health-profile cluster: it is a statement about the person's own
  // health picture, not about how the app looks or what it records.
  {
    slug: "score",
    titleKey: "settings.sections.score.title",
    icon: Gauge,
    group: "healthProfile",
  },
  // v1.25 (W-RECORDS) — Anamnese (medical history): the structured-record
  // home for allergies + family history. NOT module-gated (like Vorsorge) —
  // these are foundational health-profile records, always available.
  {
    slug: "anamnesis",
    titleKey: "settings.sections.anamnesis.title",
    icon: ClipboardList,
    group: "healthProfile",
  },
  // v1.25 (W-ENV) — Environmental context: home location, travel overrides,
  // and the weather/daylight backfill. Module-gated on the opt-in
  // `environment` module, so the entry only appears once the user turns it on.
  {
    slug: "environment",
    titleKey: "settings.sections.environment.title",
    icon: CloudSun,
    group: "healthProfile",
    moduleGate: "environment",
  },
  // ── AI ──
  {
    slug: "ai",
    titleKey: "settings.sections.ai.title",
    icon: Sparkles,
    group: "ai",
  },
  // v1.18.0 (S5) — Coach: the Coach preference cards get their own entry,
  // shown only when the coach module is enabled. The AI entry above keeps
  // provider / model / BYOK configuration.
  {
    slug: "coach",
    titleKey: "settings.sections.coach.title",
    icon: Bot,
    group: "ai",
    moduleGate: "coach",
  },
  // ── Connectivity ──
  {
    slug: "api",
    titleKey: "settings.sections.api.title",
    icon: KeyRound,
    group: "connectivity",
  },
  // v1.22.0 — remote MCP connector. Not module-gated: the card carries its
  // own enable toggle (mirroring `gesundheitsakte`), so the entry-point
  // stays reachable even with the opt-in module off.
  {
    slug: "mcp",
    titleKey: "settings.sections.mcp.title",
    icon: Plug,
    group: "connectivity",
  },
  // ── System ──
  {
    slug: "advanced",
    titleKey: "settings.sections.advanced.title",
    icon: Settings2,
    group: "system",
  },
  {
    slug: "about",
    titleKey: "settings.sections.about.title",
    icon: Info,
    group: "system",
  },
] as const;

export interface SettingsShellProps {
  /**
   * Optional override for the active section. When omitted the shell reads
   * the active slug from `usePathname()` (the production behaviour). Tests
   * pass an explicit value so they don't need to mock the router.
   */
  active?: SettingsSectionSlug;
  /**
   * v1.18.6.1 — the page heading + subtitle now live in the shell, not in
   * the section body. The shell places them in their own grid row that
   * spans ONLY the content column, so the left nav's first item lines up
   * with the top of the first card by construction — no fixed-height
   * spacer to drift across locales or subtitle line-wraps.
   *
   * Title comes from `settings.sections.<active>.title` when omitted; pass
   * an explicit value for the per-module pages (Vorsorge / Illness / Labs)
   * that stay out of the slug registry. `headingId` keeps the historic
   * `settings-section-<slug>-title` anchor for `aria-labelledby` and the
   * spotlight tour.
   */
  heading?: {
    title: string;
    subtitle: string;
    headingId: string;
    /** Rendered above the heading (e.g. a "← back to hub" link). */
    topSlot?: React.ReactNode;
    /** Rendered inline at the top-right of the heading row. */
    headingAccessory?: React.ReactNode;
  };
  children: React.ReactNode;
}

// v1.17.1 (F-2) — the personalization editors live under the Layout
// hub. They keep their own routes but are NOT standalone nav entries, so
// when the user is on one of them the Layout nav entry is the one that
// reads active.
//
// v1.18.0 (S5) — `mood` (Stimmung) and `medications` (Medikamente)
// graduated to their own nav entries, so they are no longer Layout-hub
// children for highlighting purposes.
const LAYOUT_CHILD_SLUGS: ReadonlySet<string> = new Set([
  "dashboard",
  "insights",
  // v1.25.7 — the per-module view/sort/order surfaces moved into the
  // "Darstellung" hub. v1.25.11 (#148) — each lives on its own subpage at
  // `/settings/layout/<slug>`; the legacy `/settings/<slug>` routes
  // 301-redirect there, and a direct hit still highlights the hub.
  "medications",
  "mood",
  "labs",
  "illness",
  "vorsorge",
]);

/** Map a Layout child editor onto the Layout hub for nav highlighting. */
function navHighlightSlug(slug: SettingsSectionSlug): SettingsSectionSlug {
  return LAYOUT_CHILD_SLUGS.has(slug) ? "layout" : slug;
}

function deriveActiveSlug(
  pathname: string | null,
  override?: SettingsSectionSlug,
): SettingsSectionSlug {
  if (override) return navHighlightSlug(override);
  if (!pathname) return "account";
  // Match `/settings/<slug>` and ignore any trailing segments (none today,
  // but cheap insurance for future nested routes).
  const match = pathname.match(/^\/settings\/([^/]+)/);
  const candidate = match?.[1] ?? "";
  if (LAYOUT_CHILD_SLUGS.has(candidate)) return "layout";
  return isSettingsSectionSlug(candidate) ? candidate : "account";
}

export function SettingsShell({
  active,
  heading,
  children,
}: SettingsShellProps) {
  const pathname = usePathname();
  const { t } = useTranslations();
  const { user } = useAuth();
  const activeSlug = deriveActiveSlug(pathname, active);

  // v1.18.0 (S5) — per-submodule entries are listed only when their module
  // is enabled. Read from the resolved `useAuth().user.modules` map (the
  // same map the Module hub, nav, and Insights pills gate off). Fail OPEN
  // (`!== false`): a missing key, or a not-yet-resolved `/me` payload,
  // reads as enabled so an entry never silently disappears. Entries with
  // no `moduleGate` (global / CORE) are always shown.
  //
  // v1.25.9 — the module filter must NOT run during SSR / the first client
  // paint. `useAuth().user` resolves from the `/api/auth/me` query, which is
  // populated on the server-rendered pass and the hydrating client pass at
  // DIFFERENT times (a cache race): the server may render the full list while
  // the client hydrates with `modules` already resolved (or vice versa),
  // producing a different number of nav `<li>`s and a React #418 hydration
  // mismatch. On a mismatch React discards and regenerates the whole tree,
  // which dropped the event handlers on every settings page (dead toggles /
  // download buttons). Gate the filter on a post-mount flag so SSR and the
  // first client render ALWAYS emit the same fail-open list; the real filter
  // applies once, after hydration, as an ordinary client update.
  // `useMounted()` is the SSR-safe hydration probe: it returns the server
  // snapshot (`false`) on the server render AND the first client paint, then
  // the client snapshot (`true`) after hydration commits. No setState in an
  // effect (which the lint rule flags as a cascading render), and no risk of
  // the two passes disagreeing.
  const hydrated = useMounted();
  const modules = user?.modules;
  const activeRecord = user?.accountAccess?.active ?? null;
  const allVisibleSections = SETTINGS_SECTIONS.filter(
    (section) =>
      !hydrated ||
      !section.moduleGate ||
      modules?.[section.moduleGate] !== false,
  );

  // The server has already resolved which record is active, and which
  // destinations that record offers depends on what kind of record it is. The
  // section gate remains responsible for refusing any direct URL that is not
  // on the list; this filter only stops the nav from offering one.
  //
  // Keep `allVisibleSections` for the active heading so a direct unavailable
  // link identifies itself before the gate explains why it cannot open.
  //
  //   * A managed profile shows its guardian configuration AND the record
  //     content a MANAGE holder may write — the guardian holds MANAGE, so the
  //     second set is theirs as well.
  //   * An ordinary shared record at MANAGE shows only the record content. A
  //     delegate manages somebody's health record, not their account: modules,
  //     thresholds and notification routing stay with the owner.
  //   * Every other shared record shows nothing here, because it reaches no
  //     Settings destination at all.
  const visibleSections =
    activeRecord === null
      ? allVisibleSections
      : allVisibleSections.filter((section) => {
          const kind = classifySettingsDestination(section.slug).kind;
          // Every destination on either list needs MANAGE, so the level is
          // checked once for both record kinds rather than only for the adult
          // one. A guardian grant is always MANAGE today, which is exactly why
          // the check was easy to leave out — and a managed entry that ever
          // arrived below it would have listed destinations the section gate
          // refuses, sending somebody to a page that explains it cannot open.
          if (activeRecord.level !== "manage") return false;
          if (activeRecord.recordKind === "managed") {
            return kind === "managed-guardian" || kind === "manage-writable";
          }
          return kind === "manage-writable";
        });
  const activeSection = allVisibleSections.find(
    (section) => section.slug === activeSlug,
  );

  // v1.4.33 IW4 — keep the active chip in view inside the horizontal
  // mobile strip. On a 393 CSS px viewport the strip is wider than the
  // viewport and the rightmost chips sit off-screen; a user who tapped
  // one of those chips lands on the new route with the strip still
  // scrolled to the leftmost chip, which reads as if the navigation is
  // broken. We pin the active chip to the left edge of the strip.
  //
  // v1.7.0 — adjust only the strip's own horizontal scroll offset
  // (via `scrollTo({ left })`) instead of `Element.scrollIntoView()`.
  // `scrollIntoView` walks every scrollable ancestor and adjusts both
  // axes, so on mobile it also nudged the whole document vertically on
  // each route change — a dizzy auto-scroll that fired on every settings
  // sub-page tap. Scrolling the strip's own `scrollLeft` confines the
  // motion to its horizontal axis and never touches the page scroll
  // position.
  const mobileStripRef = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const strip = mobileStripRef.current;
    if (!strip) return;
    const active = strip.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    // Land the active chip at the strip's left edge, clamped to the
    // scrollable range. `offsetLeft` is relative to the strip's padding
    // box, which is the origin for `scrollLeft`.
    const maxScroll = strip.scrollWidth - strip.clientWidth;
    const target = Math.max(0, Math.min(active.offsetLeft, maxScroll));
    // Position the active chip instantly. A smooth behaviour here animates
    // the strip from its reset `scrollLeft: 0` to the target on every tap,
    // which reads as an unwanted "scroll from the start" sweep when swapping
    // sections. An instant jump keeps the chip in view without the sweep.
    strip.scrollTo({ left: target, behavior: "auto" });
  }, [activeSlug]);

  // v1.18.6.1 — resolve the heading once. Pages pass an explicit `heading`
  // (the canonical path); the slug fallback keeps the shell renderable on
  // its own (and in tests that mount it without a heading) by deriving the
  // title from the active section. The heading lives in the shell so it can
  // occupy its own grid row spanning only the content column — see the grid
  // below.
  const resolvedHeading =
    heading ??
    (activeSection
      ? {
          title: t(activeSection.titleKey),
          subtitle: t(`settings.sections.${activeSection.slug}.subtitle`),
          headingId: `settings-section-${activeSection.slug}-title`,
          topSlot: LAYOUT_CHILD_SLUGS.has(activeSection.slug) ? (
            <SettingsHubBackLink
              href="/settings/layout"
              labelKey="settings.sections.layout.backToHub"
            />
          ) : undefined,
          headingAccessory: undefined,
        }
      : null);

  // The shell paints the heading twice — above the mobile chip strip and
  // inside the desktop grid row — so only the desktop copy may be a real
  // `<h1>`. Both go through `PageHeader`: the block used to be hand-rolled
  // here and in `admin-shell.tsx`, which is how Settings and Admin ended up
  // a step off every module page (and off each other).
  const headingBlock = (mobile = false) =>
    resolvedHeading ? (
      <PageHeader
        headingAs={mobile ? "div" : "h1"}
        titleId={
          mobile
            ? `${resolvedHeading.headingId}-mobile`
            : resolvedHeading.headingId
        }
        title={resolvedHeading.title}
        description={resolvedHeading.subtitle}
        topSlot={resolvedHeading.topSlot}
        actions={resolvedHeading.headingAccessory}
      />
    ) : null;

  // v1.4.25 W8 — AuthShell wraps the page in `px-4 py-6 md:px-6`
  // already, so this inner shell only carries the wider max-width.
  // Previously the duplicate `px-4 py-6 md:px-6 md:py-8` here was
  // producing visibly more top/bottom whitespace on Settings/Admin
  // pages than on Dashboard/Insights/Measurements.
  return (
    <div
      className="mx-auto w-full max-w-screen-xl"
      data-active-record-id={activeRecord?.accountId}
      data-record-kind={activeRecord?.recordKind}
    >
      {/* v1.18.6.1 — on mobile the heading sits above the chip strip; on
          desktop it is rendered inside the grid (row 1 / content column) so
          it does not paint twice. */}
      {resolvedHeading ? (
        <div className="mb-4 md:hidden">{headingBlock(true)}</div>
      ) : null}

      {/* Mobile section strip — horizontal scroll, hidden on md+.
          `no-scrollbar` (defined in `globals.css`) suppresses the
          painted scrollbar; the horizontal swipe + keyboard arrow
          scrolling still work. Without it the 10-section strip
          renders an always-on scrollbar at the top of every settings
          page, which makes the page feel like every section card has
          an overflow problem.

          v1.4.33 IW7 — `snap-x snap-mandatory` lets a swipe-flick land
          on the next chip's leading edge instead of the in-between
          dead zone. The auto `scrollIntoView({inline: "center"})`
          effect above stays the canonical positioner for the active
          chip; snap is the polish layer when the user manually flicks
          through the strip without tapping. */}
      <nav
        ref={mobileStripRef}
        aria-label={t("settings.shell.sectionsNav")}
        className="no-scrollbar relative -mx-4 mb-4 snap-x snap-mandatory overflow-x-auto px-4 md:hidden"
      >
        <ul className="flex min-w-max items-center gap-2">
          {visibleSections.map((section, index) => {
            const isActive = section.slug === activeSlug;
            const Icon = section.icon;
            // 2026-07-17 UX/IA audit (M6) — a quiet vertical divider marks a
            // group boundary in the horizontal strip (the desktop sidebar
            // carries the full text header for the same grouping).
            const startsNewGroup =
              index > 0 && visibleSections[index - 1].group !== section.group;
            return (
              <React.Fragment key={section.slug}>
                {startsNewGroup ? (
                  <li aria-hidden="true" className="shrink-0">
                    <span className="bg-border block h-6 w-px" />
                  </li>
                ) : null}
                <li className="snap-start">
                  <Link
                    href={`/settings/${section.slug}`}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      // v1.4.25 W8 — chip strip is the primary mobile-settings
                      // navigation surface. Pad to WCAG 2.5.5 44 px so the
                      // chips can be tapped without zoom on a Pixel-5.
                      "flex min-h-11 items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors",
                      isActive
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border text-foreground hover:bg-accent",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {t(section.titleKey)}
                  </Link>
                </li>
              </React.Fragment>
            );
          })}
        </ul>
      </nav>

      {/* v1.18.6.1 — two-row grid on desktop:
            row 1 / col 2 = heading (content column only)
            row 2 / col 1 = nav     row 2 / col 2 = cards
          The nav's first item lines up with the top of the first card BY
          CONSTRUCTION — both start the grid's second row — so the alignment
          holds across locales and however the title or subtitle wraps. No
          fixed-height spacer to guess. The `gap-6` between rows reproduces
          the `space-y-6` the heading-to-first-card gap used to carry. */}
      <div
        className={cn(
          "grid gap-6 md:grid-cols-[220px_1fr] md:grid-rows-[auto_1fr]",
          SUB_SHELL_GRID_FLOOR,
        )}
      >
        {/* Heading — desktop only here (mobile renders it above the strip). */}
        {resolvedHeading ? (
          <div className="hidden md:col-start-2 md:row-start-1 md:block">
            {headingBlock()}
          </div>
        ) : null}

        {/* Desktop sticky sidebar — starts on the heading row and spans the
            two desktop rows. Its top therefore shares the heading's grid
            line while the content column keeps the natural heading-to-card
            gap in row 2.

            The sticky lives on the `<aside>` grid item itself, with
            `self-start` so it shrinks to its content instead of stretching
            to the full row height. A sticky CHILD inside a stretched grid
            item resolves its containing block to the stretched item, which
            in some engines lets the nav scroll away with the content rather
            than pin. Sticking the grid item directly — sized to content and
            offset `top-6` to clear the scroll viewport's padding — keeps the
            nav fixed while only the content column scrolls. `max-h` +
            `overflow-y-auto` let a long section list scroll within the
            pinned panel on short viewports. */}
        <aside
          aria-label={t("settings.shell.sectionsNav")}
          className="no-scrollbar hidden max-h-[calc(100dvh-10.5rem)] overflow-y-auto md:sticky md:top-6 md:col-start-1 md:row-span-2 md:row-start-1 md:block md:self-start"
        >
          <ul className="space-y-1">
            {visibleSections.map((section, index) => {
              const isActive = section.slug === activeSlug;
              const Icon = section.icon;
              // 2026-07-17 UX/IA audit (M6) — a non-interactive header
              // precedes the first VISIBLE entry of each group so a
              // module-gated entry never leaves an orphan header above an
              // empty cluster.
              const startsNewGroup =
                index === 0 ||
                visibleSections[index - 1].group !== section.group;
              return (
                <React.Fragment key={section.slug}>
                  {startsNewGroup ? (
                    <li
                      className={cn(
                        "text-muted-foreground px-3 pb-1 text-xs font-medium tracking-wide uppercase",
                        index === 0 ? "" : "pt-4",
                      )}
                    >
                      {t(SETTINGS_SECTION_GROUP_LABEL_KEYS[section.group])}
                    </li>
                  ) : null}
                  <li>
                    <Link
                      href={`/settings/${section.slug}`}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-foreground hover:bg-accent",
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden="true" />
                      {t(section.titleKey)}
                    </Link>
                  </li>
                </React.Fragment>
              );
            })}
          </ul>
        </aside>

        {/* Main column — page renders its own h1 + subtitle.

            v1.25.11 (#154) — the column no longer carries its own
            `min-h-[calc(100dvh-12rem)]`. That reserve was tuned without
            the AuthShell wrapper's `pt-6 pb-20` (104 px) in the budget, so
            on a short section it forced the column ~100 px past the
            viewport: the page scrolled into a dark empty band below the
            last card. Instead the GRID carries `md:min-h-[calc(100dvh-
            10.5rem)]` (top bar 4rem + wrapper pt-6/pb-20 = 10.5rem), and
            this column is the grid's `1fr` row, so it stretches to fill
            the viewport EXACTLY on a short section (no over-scroll, no dark
            band) and grows past it on a long one (normal scroll). The floor
            still prevents the short-loading-state → long-list height jump
            the old reserve guarded, just measured against the real budget.

            The column carries NO bottom gutter of its own. AuthShell's
            `<main>` already reserves `pb-[calc(4rem+safe-area)]` on `<md` to
            clear the floating bottom-nav, and its wrapper reserves `pb-20` for
            the Coach FAB. The old `pb-24 md:pb-0` (v1.4.33 F14) double-counted
            that same 64 px nav clearance and stacked ~96 px of dead scroll
            below the last card on mobile — removed so the shell owns all
            bottom-space (over-scroll class, #154 lineage).

            v1.16.4 — a `<div>`, not `<main>`: the surrounding AuthShell
            already provides the page's single `<main>` landmark and a
            nested second one is an a11y violation. */}
        <div className="min-w-0 md:col-start-2">{children}</div>
      </div>
    </div>
  );
}
