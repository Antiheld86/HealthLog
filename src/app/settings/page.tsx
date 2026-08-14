import { permanentRedirect } from "next/navigation";

/**
 * `/settings` is a thin permanent redirect to `/settings/account`.
 *
 * Pre-v1.4 the entire settings UI lived in this single 3000+ LOC file. As part
 * of the v1.4 settings split (PR series A2), each concern moved to its own
 * route under `/settings/[section]/page.tsx`; the extraction finished long
 * ago and the historic monolith is gone.
 *
 * 308 (`permanentRedirect`) keeps the request method intact and is the right
 * answer for a permanent address change — bookmarks, deep-links, and any
 * external systems that POST to `/settings` will follow the redirect with
 * their original method.
 */
export default function SettingsRoot(): never {
  permanentRedirect("/settings/account");
}
