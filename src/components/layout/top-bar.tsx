"use client";

import {
  Bell,
  ChevronDown,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Settings,
  Shield,
  Sun,
} from "lucide-react";
import { AccountSwitcherMenuItems } from "@/components/layout/account-switcher-menu";
import { SHELL_HEADER_BAND } from "@/components/layout/shell-metrics";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/ui/logo";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";
import { useAuth, useLogout } from "@/hooks/use-auth";
import { useTheme } from "@/components/providers";
import { useTranslations } from "@/lib/i18n/context";
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

function getInitials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("");
}

export function TopBar() {
  const { user, isLoading } = useAuth();
  // v1.36.0 — acting on somebody else's record; see the menu below.
  const sharedRecord = user?.accountAccess?.active != null;
  const logout = useLogout();
  const { theme, setTheme } = useTheme();
  const { t } = useTranslations();
  const avatarUrl = user?.avatarUrl ?? null;
  const isAdmin = user?.role === "ADMIN";

  const themeIcon =
    theme === "system" ? (
      <Monitor className="h-4 w-4" />
    ) : theme === "dark" ? (
      <Moon className="h-4 w-4" />
    ) : (
      <Sun className="h-4 w-4" />
    );

  return (
    <header
      data-slot="top-bar"
      // Height + bottom border come from `SHELL_HEADER_BAND`, which the
      // sidebar logo band reads too, so the two borders draw one
      // continuous line. Never restate a height here.
      className={cn(
        "bg-card/80 border-border sticky top-0 z-40 flex items-center justify-between px-4 backdrop-blur-md md:px-6",
        SHELL_HEADER_BAND,
      )}
      // iOS PWA on notched iPhones overlays the status bar onto the
      // sticky header unless we reserve the safe-area inset. The
      // inline style adds `safe-area-inset-top` as padding-top on
      // devices that report one and is a no-op on every other
      // platform. The band stays 4rem tall either way (border-box), so
      // on a device that reports an inset the content area inside it
      // gives up those pixels.
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      {/* Mobile logo */}
      <Link href="/" className="flex items-center gap-2 md:hidden">
        <Logo className="text-primary" size={20} />
        <span className="font-bold tracking-tight">HealthLog</span>
      </Link>

      {/* Desktop: empty spacer (user controls are in sidebar) */}
      <div className="hidden md:block" />

      {/* Mobile-only auth section (desktop uses sidebar user section) */}
      <div className="flex items-center gap-2 md:hidden">
        {isLoading ? (
          <Skeleton className="bg-muted h-4 w-20 rounded" />
        ) : user ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("nav.userMenu")}
              // v1.4.25 W8 — hit the WCAG 2.5.5 44 px touch-target floor on
              // mobile. The text-only py-1.5 was previously ~30 px tall.
              //
              // v1.4.34 IW-G — keyboard users get a visible ring on
              // focus-visible. The previous `focus:outline-none` killed
              // the focus indicator without replacing it.
              className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex min-h-11 min-w-11 items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
            >
              <Avatar className="size-7">
                {avatarUrl && (
                  <AvatarImage src={avatarUrl} alt={user.username} />
                )}
                <AvatarFallback className="bg-primary/15 text-primary text-xs font-medium">
                  {getInitials(user.username)}
                </AvatarFallback>
              </Avatar>
              <span className="hidden sm:inline">{user.username}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {/* v1.36.0 — the account utilities drop out while this browser is
                  acting on somebody else's record. Every route behind them
                  refuses under a switch, and a control that leads only to an
                  explanation of why it does not work is worse than no control.
                  The switcher below is how the person gets back. */}
              {!sharedRecord && (
                <>
                  <DropdownMenuItem asChild>
                    <Link href="/settings/account" className="cursor-pointer">
                      <Settings className="mr-2 h-4 w-4" />
                      {t("nav.settings")}
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/notifications" className="cursor-pointer">
                      <Bell className="mr-2 h-4 w-4" />
                      {t("nav.notifications")}
                    </Link>
                  </DropdownMenuItem>
                  {isAdmin && (
                    <DropdownMenuItem asChild>
                      <Link href="/admin" className="cursor-pointer">
                        <Shield className="mr-2 h-4 w-4" />
                        {t("nav.admin")}
                      </Link>
                    </DropdownMenuItem>
                  )}
                </>
              )}
              {/* v1.4.36 W4e — About moved into the Admin Console
                  (`/admin/about`). The dropdown entry was redundant
                  for the small audience that still reaches it (admins
                  only, on the order of once or twice a year). */}
              <DropdownMenuSub>
                {/* v1.22.1 — the shared sub-trigger ships `py-1.5` and no
                    min-height, while every sibling `DropdownMenuItem` carries
                    `min-h-11 py-2`. Left as-is the Theme row sits a few pixels
                    shorter than the rows around it and the menu reads as
                    unevenly spaced. Match the item height here (instance-level
                    override, so no other dropdown's sub-trigger is touched). */}
                <DropdownMenuSubTrigger className="min-h-11 py-2">
                  {themeIcon}
                  <span className="ml-2">{t("nav.theme")}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem onClick={() => setTheme("system")}>
                    <Monitor className="mr-2 h-4 w-4" />
                    {t("nav.themeSystem")}
                    {theme === "system" && (
                      <span className="text-primary ml-auto text-xs">
                        &#10003;
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTheme("dark")}>
                    <Moon className="mr-2 h-4 w-4" />
                    {t("nav.themeDark")}
                    {theme === "dark" && (
                      <span className="text-primary ml-auto text-xs">
                        &#10003;
                      </span>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTheme("light")}>
                    <Sun className="mr-2 h-4 w-4" />
                    {t("nav.themeLight")}
                    {theme === "light" && (
                      <span className="text-primary ml-auto text-xs">
                        &#10003;
                      </span>
                    )}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {/* v1.36.0 — the same switcher slice the desktop sidebar menu
                  mounts. One component in both menus: a switcher a person can
                  reach on their laptop and not on their phone is a record they
                  can enter and cannot leave. */}
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
          </DropdownMenu>
        ) : (
          <Link
            href="/auth/login"
            // v1.4.25 W8 — match the WCAG 2.5.5 44 px touch-target floor.
            className="text-muted-foreground hover:text-foreground flex min-h-11 min-w-11 items-center gap-2 rounded-md px-2 text-sm transition-colors"
          >
            <LogIn className="h-4 w-4" />
            <span className="hidden sm:inline">{t("nav.login")}</span>
          </Link>
        )}
      </div>
    </header>
  );
}
