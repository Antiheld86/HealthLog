"use client";

import { useMemo, useState } from "react";
import {
  Bell,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  Monitor,
  Moon,
  MoreVertical,
  Settings,
  Shield,
  Sun,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { AccountSwitcherMenuItems } from "@/components/layout/account-switcher-menu";
import { medicationsPrefetchIntentProps } from "@/lib/queries/prefetch-medications";
import {
  isNavDestinationActive,
  visibleNavDestinations,
  visibleUtilityDestinations,
} from "@/components/layout/nav-model";
import { SHELL_HEADER_BAND } from "@/components/layout/shell-metrics";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/logo";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useMounted } from "@/hooks/use-mounted";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useTheme } from "@/components/providers";
import { useTranslations } from "@/lib/i18n/context";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const STORAGE_KEY = "healthlog-sidebar-collapsed";

function getInitials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

/**
 * The sidebar footer's name-and-avatar block.
 *
 * A link into the account settings normally, and a plain block while this
 * browser is acting on somebody else's record — the settings routes refuse
 * under a switch, so the link would lead only to an explanation of why it did
 * not work. It keeps naming the person at the keyboard either way, which is
 * what a switched session needs it to do.
 */
function FooterIdentity({
  sharedRecord,
  label,
  children,
}: {
  sharedRecord: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const className =
    "flex min-w-0 flex-1 items-center gap-3 rounded-md transition-colors";
  if (sharedRecord) {
    return <div className={className}>{children}</div>;
  }
  return (
    <Link
      href="/settings/account"
      aria-label={label}
      className={`hover:bg-accent ${className}`}
    >
      {children}
    </Link>
  );
}

function SidebarUserSection({ collapsed }: { collapsed: boolean }) {
  const { user } = useAuth();
  const logout = useLogout();
  const { theme, setTheme } = useTheme();
  const { t } = useTranslations();
  const avatarUrl = user?.avatarUrl ?? null;
  // v1.36.0 — while this browser is acting on somebody else's record the
  // account surfaces are unreachable, so the avatar stops being a door into
  // them. It still names the person at the keyboard, which is exactly what a
  // switched session needs it to do.
  const sharedRecord = user?.accountAccess?.active != null;

  if (!user) return null;

  const themeIcon =
    theme === "system" ? (
      <Monitor className="h-4 w-4" />
    ) : theme === "dark" ? (
      <Moon className="h-4 w-4" />
    ) : (
      <Sun className="h-4 w-4" />
    );

  const identityBlock = (
    <>
      <Avatar className="h-9 w-9 shrink-0">
        {avatarUrl && <AvatarImage src={avatarUrl} alt={user.username} />}
        <AvatarFallback className="bg-primary/15 text-primary text-xs font-medium">
          {getInitials(user.username)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{user.username}</p>
        {user.email && (
          <p className="text-muted-foreground truncate text-xs">{user.email}</p>
        )}
      </div>
    </>
  );

  const dropdownContent = (
    <DropdownMenuContent
      side="right"
      align="end"
      className="w-60"
      sideOffset={8}
    >
      {/* R20 — the user header is the direct route into the account
          settings. Clicking the avatar / name jumps straight to
          `/settings/account` rather than making the user hunt for a
          separate "Settings" entry. */}
      {sharedRecord ? (
        <div className="flex items-center gap-3 px-2 py-2">{identityBlock}</div>
      ) : (
        <DropdownMenuItem asChild>
          <Link
            href="/settings/account"
            className="flex cursor-pointer items-center gap-3 px-2 py-2"
          >
            {identityBlock}
          </Link>
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      {!sharedRecord && (
        <DropdownMenuItem asChild>
          <Link href="/notifications" className="cursor-pointer">
            <Bell className="mr-2 h-4 w-4" />
            {t("nav.notifications")}
          </Link>
        </DropdownMenuItem>
      )}
      {/* The about section lives at the end of the settings shell nav;
          the avatar menu stays focused on account-level actions. */}
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {themeIcon}
          <span className="ml-2">{t("nav.theme")}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={() => setTheme("system")}>
            <Monitor className="mr-2 h-4 w-4" />
            {t("nav.themeSystem")}
            {theme === "system" && (
              <span className="text-primary ml-auto text-xs">&#10003;</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("dark")}>
            <Moon className="mr-2 h-4 w-4" />
            {t("nav.themeDark")}
            {theme === "dark" && (
              <span className="text-primary ml-auto text-xs">&#10003;</span>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme("light")}>
            <Sun className="mr-2 h-4 w-4" />
            {t("nav.themeLight")}
            {theme === "light" && (
              <span className="text-primary ml-auto text-xs">&#10003;</span>
            )}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {/* v1.36.0 — the records this account may open. Renders nothing when
          nobody has shared one, so the menu is unchanged for every account
          that does not use sharing. */}
      <AccountSwitcherMenuItems />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => logout.mutate()}
        className="text-destructive focus:text-destructive focus:bg-destructive/10 cursor-pointer"
      >
        <LogOut className="mr-2 h-4 w-4" />
        {t("nav.logout")}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  if (collapsed) {
    return (
      <div className="border-sidebar-border border-t p-3">
        <div className="flex items-center justify-center">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("nav.userMenu")}
              className="hover:bg-accent focus-visible:ring-ring/50 shrink-0 rounded-md p-1.5 transition-colors focus:outline-none focus-visible:ring-[3px]"
            >
              <Avatar className="h-8 w-8">
                {avatarUrl && (
                  <AvatarImage src={avatarUrl} alt={user.username} />
                )}
                <AvatarFallback className="bg-primary/15 text-primary text-xs font-medium">
                  {getInitials(user.username)}
                </AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            {dropdownContent}
          </DropdownMenu>
        </div>
      </div>
    );
  }

  return (
    <div className="border-sidebar-border border-t p-3">
      <div className="flex items-center gap-3 px-2 py-1">
        {/* R20 — the avatar + name in the expanded footer routes straight
            into the account settings; the kebab to the right still opens
            the rest of the user menu. */}
        <FooterIdentity
          sharedRecord={sharedRecord}
          label={t("nav.accountSettings")}
        >
          <Avatar className="h-8 w-8 shrink-0">
            {avatarUrl && <AvatarImage src={avatarUrl} alt={user.username} />}
            <AvatarFallback className="bg-primary/15 text-primary text-xs font-medium">
              {getInitials(user.username)}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{user.username}</p>
            {user.email && (
              <p className="text-muted-foreground truncate text-xs">
                {user.email}
              </p>
            )}
          </div>
        </FooterIdentity>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("nav.userMenu")}
            className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring/50 shrink-0 rounded-md p-1.5 transition-colors focus:outline-none focus-visible:ring-[3px]"
          >
            <MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          {dropdownContent}
        </DropdownMenu>
      </div>
    </div>
  );
}

export function SidebarNav() {
  const pathname = usePathname();
  const { t } = useTranslations();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  // v1.16.7 — hover / focus intent on the medications link starts the
  // list request before the navigation commits, so the due-time cells
  // hydrate from a warm cache instead of serialising behind the chunk.
  const medsIntent = medicationsPrefetchIntentProps(queryClient);
  const isAdmin = user?.role === "ADMIN";
  // Match `/admin` exactly or any `/admin/...` sub-route for active-link
  // styling. Plain `startsWith("/admin")` would also flip for a
  // hypothetical future `/administrative` page, which is not the same
  // semantic surface. The Admin entry mirrors Settings: a single link
  // with no sub-item expansion in the global sidebar — `<AdminShell>`
  // renders its own per-section nav inside the page itself.
  const onAdminPage = pathname === "/admin" || pathname.startsWith("/admin/");
  // v1.17.1 (F-1) — the sidebar renders the one shared destination model
  // (`nav-model.ts`), the same ordered list the mobile bottom-nav derives
  // its "More" hub from. v1.18.0 — entries are filtered by the account's
  // resolved module map (mood, cycle, labs, coach, achievements …); cycle +
  // coach are delegated server-side and already reflected in that map.
  // The module map rides the client-only `/api/auth/me` query, so it is not
  // settled on SSR or the first client paint. Gating the filter behind
  // `useMounted()` keeps SSR and first paint identical (core destinations
  // only) and stops a disabled module's entry from flickering in for one
  // frame before the query resolves; once mounted the real map applies.
  const mounted = useMounted();
  // v1.36.0 — while this browser is acting on somebody else's record, the nav
  // shows only what sharing covers. The server refuses the rest regardless;
  // dropping the entries spares a delegate a click that ends in a 403.
  const { inSharedRecord: sharedRecord, sections } = useRecordCapabilities();
  const visibleNavItems = useMemo(
    () =>
      visibleNavDestinations(user?.modules, mounted, sharedRecord, sections),
    [user?.modules, mounted, sharedRecord, sections],
  );
  // Collapsed = the user's stored choice, or — with no stored choice — a
  // viewport default: tablet widths (md–lg, e.g. an iPad held upright)
  // fall back to the icon rail so the content column keeps its room; a
  // 256 px sidebar squeezes a 768 px viewport down to a 512 px column.
  // Everything is gated on `mounted` (same pattern as the module filter
  // above): SSR and the hydration render both paint the expanded shell,
  // the stored pref / viewport default applies on the first client render
  // after hydration settles. Branching earlier — localStorage or
  // matchMedia inside the initial render — is a React #418 hydration
  // mismatch, because the sidebar is only CSS-hidden below `md` and still
  // hydrates its DOM there.
  const tabletOrBelow = useIsMobile("lg");
  const [collapsedPref, setCollapsedPref] = useState<boolean | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      return stored === null ? null : stored === "true";
    } catch {
      return null;
    }
  });
  const collapsed = mounted ? (collapsedPref ?? tabletOrBelow) : false;

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsedPref(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Ignore storage errors
    }
  }

  // v1.17.1 (F-1 residue) — the sidebar footer utility links derive from
  // the SAME shared list the mobile More-hub tail consumes, so the two
  // surfaces can no longer drift into two hand-curated utility lists.
  // Notifications is surfaced in the avatar menu (not the footer), so the
  // footer takes every utility entry except `/notifications`; Admin is the
  // role-gated, sidebar-only surface and is inserted separately below.
  const footerUtilityItems = useMemo(
    () =>
      visibleUtilityDestinations({ sharedRecord }).filter(
        (d) => d.href !== "/notifications",
      ),
    [sharedRecord],
  );

  function isUtilityActive(href: string) {
    // Settings matches the whole `/settings/*` shell; the rest match exact.
    return href === "/settings/account"
      ? pathname.startsWith("/settings")
      : pathname === href;
  }

  function renderUtilityLink(item: {
    href: string;
    tKey: string;
    icon: typeof Settings;
  }) {
    const Icon = item.icon;
    const isActive = isUtilityActive(item.href);
    const tourId =
      item.href === "/settings/account" ? "nav-settings" : undefined;
    if (collapsed) {
      return (
        <Tooltip key={item.href}>
          <TooltipTrigger asChild>
            <Link
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              data-tour-id={tourId}
              className={cn(
                "flex items-center justify-center rounded-lg p-2.5 transition-colors",
                isActive
                  ? "bg-primary/10 text-primary"
                  : "text-foreground hover:bg-accent",
              )}
            >
              <Icon className="h-4 w-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {t(item.tKey)}
          </TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        data-tour-id={tourId}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-foreground hover:bg-accent",
        )}
      >
        <Icon className="h-4 w-4" />
        {t(item.tKey)}
      </Link>
    );
  }

  function renderAdminLink() {
    if (!isAdmin) return null;
    if (collapsed) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              href="/admin"
              aria-current={onAdminPage ? "page" : undefined}
              className={cn(
                "flex items-center justify-center rounded-lg p-2.5 transition-colors",
                onAdminPage
                  ? "bg-primary/10 text-primary"
                  : "text-foreground hover:bg-accent",
              )}
            >
              <Shield className="h-4 w-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {t("nav.admin")}
          </TooltipContent>
        </Tooltip>
      );
    }
    return (
      <Link
        href="/admin"
        aria-current={onAdminPage ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
          onAdminPage
            ? "bg-primary/10 text-primary"
            : "text-foreground hover:bg-accent",
        )}
      >
        <Shield className="h-4 w-4" />
        {t("nav.admin")}
      </Link>
    );
  }

  function renderCollapseToggle(className?: string) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={toggleCollapsed}
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-accent z-20 rounded-md p-1 transition-colors",
              className,
            )}
            aria-label={t("nav.collapseSidebar")}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronsRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronsLeft className="h-3.5 w-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {t("nav.collapseSidebar")}
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        aria-label={t("nav.sidebar")}
        className={cn(
          "bg-sidebar border-sidebar-border relative hidden h-full flex-shrink-0 border-r transition-[width] duration-200 md:flex md:flex-col",
          collapsed ? "w-16" : "w-64",
        )}
      >
        {/* Logo band. Height + bottom border come from `SHELL_HEADER_BAND`,
            which the top bar reads too, so the two borders draw one
            continuous line. The band owns the 4rem; the link inside
            stretches with `h-full` and never restates a height. */}
        <div
          data-slot="sidebar-header"
          className={cn(
            "border-sidebar-border",
            SHELL_HEADER_BAND,
            collapsed ? "px-3" : "px-6",
          )}
        >
          <Link
            href="/"
            className={cn(
              "flex h-full items-center",
              collapsed ? "justify-center px-0" : "gap-2",
            )}
          >
            <Logo className="text-primary shrink-0" size={24} />
            {!collapsed && (
              <span className="text-lg font-bold tracking-tight">
                HealthLog
              </span>
            )}
          </Link>
        </div>

        <nav
          aria-label={t("nav.mainNavigation")}
          className={cn("flex-1 overflow-y-auto", collapsed ? "p-1.5" : "p-3")}
        >
          {collapsed ? (
            <div className="mb-1 flex justify-center">
              {renderCollapseToggle()}
            </div>
          ) : (
            // v1.4.33 IW7 — drop the "Home" group label. The sidebar
            // has exactly one nav group, and the first entry is
            // already "Dashboard" pointing to `/`, so the previous
            // "HOME / Dashboard" pairing read as if there were two
            // separate destinations for the homepage. The collapse
            // toggle stays anchored to the top-right of the strip so
            // the visual rhythm of the sidebar header is unchanged.
            <div className="relative mb-1 flex h-5 items-center justify-end">
              {renderCollapseToggle()}
            </div>
          )}
          <div className="space-y-1">
            {visibleNavItems.map((item) => {
              const isActive = isNavDestinationActive(
                item.href,
                pathname,
                visibleNavItems,
              );
              const label = t(item.tKey);

              if (collapsed) {
                return (
                  <Tooltip key={item.href}>
                    <TooltipTrigger asChild>
                      <Link
                        href={item.href}
                        aria-current={isActive ? "page" : undefined}
                        data-tour-id={item.tourId}
                        {...(item.href === "/medications" ? medsIntent : {})}
                        className={cn(
                          "flex items-center justify-center rounded-lg p-2.5 transition-colors",
                          isActive
                            ? "bg-primary/10 text-primary"
                            : "text-foreground hover:bg-accent",
                        )}
                      >
                        <item.icon className="h-4 w-4" />
                      </Link>
                    </TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      {label}
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  data-tour-id={item.tourId}
                  {...(item.href === "/medications" ? medsIntent : {})}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary"
                      : "text-foreground hover:bg-accent",
                  )}
                >
                  <item.icon className="h-4 w-4" />
                  {label}
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Bottom utility links — the shared utility tail (minus
            Notifications, which lives in the avatar menu) with the
            role-gated Admin entry inserted before Settings. */}
        <div className={cn("space-y-1 pb-1", collapsed ? "px-1.5" : "px-3")}>
          {footerUtilityItems
            .filter((item) => item.href !== "/settings/account")
            .map((item) => renderUtilityLink(item))}
          {renderAdminLink()}
          {footerUtilityItems
            .filter((item) => item.href === "/settings/account")
            .map((item) => renderUtilityLink(item))}
        </div>

        <SidebarUserSection collapsed={collapsed} />
      </aside>
    </TooltipProvider>
  );
}
