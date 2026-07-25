"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTranslations } from "@/lib/i18n/context";

/**
 * Password input with a built-in show/hide toggle. Lives in the shared UI
 * layer so every surface that needs a masked secret (Withings, Nightscout,
 * ntfy, Telegram, AI provider keys, account password, auth login /
 * register) can share the same UX without duplicating the
 * visibility-toggle plumbing.
 *
 * v1.4.27 R3d MB2 — the icon-only toggle wraps in an `inline-flex h-11
 * w-11` hit area so the 44 px WCAG 2.5.5 floor is honoured on touch.
 * The icon stays at 16 px; the surrounding padding does the work. The
 * input itself gets `pr-12` so user input never collides with the
 * toggle glyph.
 */
export function PasswordInput({
  className,
  autoComplete,
  ...props
}: React.ComponentProps<typeof Input>) {
  const [visible, setVisible] = useState(false);
  const { t } = useTranslations();

  // Config/secret fields (BYOK API keys, webhook secrets, ntfy tokens) pass no
  // `autoComplete` — they are not credentials, so a password manager offering
  // to fill or *save* them is noise and risks clobbering the field. Suppress
  // Bitwarden / 1Password / LastPass by default for those. Credential fields
  // (login, register, password change) pass a real token
  // (`current-password` / `new-password` / `username`) and keep manager
  // integration; only an explicit `"off"` opts back into suppression.
  const suppressManagers = autoComplete == null || autoComplete === "off";
  return (
    <div className="relative">
      <Input
        {...props}
        autoComplete={autoComplete ?? "off"}
        data-bwignore={suppressManagers ? "" : undefined}
        data-1p-ignore={suppressManagers ? "" : undefined}
        data-lpignore={suppressManagers ? "true" : undefined}
        type={visible ? "text" : "password"}
        className={cn("pr-12", className)}
      />
      <button
        type="button"
        tabIndex={-1}
        // WCAG 2.1.2 button-name — the icon-only toggle has no visible text
        // and screen readers fall back to the icon's filename otherwise.
        aria-label={
          visible ? t("common.hidePassword") : t("common.showPassword")
        }
        onClick={() => setVisible((v) => !v)}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-1 inline-flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-md"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
