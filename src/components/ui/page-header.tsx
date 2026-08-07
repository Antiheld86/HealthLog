import type { ReactNode } from "react";

import { BackLink } from "@/components/ui/back-link";
import { cn } from "@/lib/utils";

/**
 * The one canonical page header. Every module surface renders its title
 * through this so the header vocabulary reads identically app-wide: the H1
 * is always `text-2xl font-bold tracking-tight`, the explainer under it is
 * always `text-muted-foreground text-sm` (heading in foreground, one-line
 * explainer in muted — the app-wide convention the design standards pin for
 * `CardDescription`, `PageHeader`, and `SettingsCardHeader` alike), and no
 * icon sits beside the H1. An optional back-link rides above the title, and
 * an `actions` slot holds the page's primary buttons to the right of the
 * title block.
 *
 * The explainer never truncates. A page that clipped it mid-word to hold one
 * line on a phone was trading a readable sentence for a fixed height; the
 * fixed height now comes from every header being built the same way, and a
 * sentence too long for one line is a text problem, fixed in the string.
 *
 * `headingAs="div"` renders the title as `role="heading" aria-level={1}`
 * instead of an `<h1>`. The Settings and Admin shells paint their heading
 * twice — once above the mobile section strip, once inside the desktop grid
 * row — and only one of the two may be a real `<h1>`. Without this the two
 * shells hand-rolled the whole block to get the second copy, which is how
 * they drifted apart from every module page in the first place.
 */
export function PageHeader({
  title,
  titleId,
  description,
  headingAs = "h1",
  backLink,
  topSlot,
  actions,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  description?: ReactNode;
  headingAs?: "h1" | "div";
  backLink?: { href: string; label: string; dataSlot?: string };
  /** Optional block above the title (e.g. a hub back-link the shell owns). */
  topSlot?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const heading =
    headingAs === "div" ? (
      <div
        id={titleId}
        role="heading"
        aria-level={1}
        className="text-2xl font-bold tracking-tight"
      >
        {title}
      </div>
    ) : (
      <h1 id={titleId} className="text-2xl font-bold tracking-tight">
        {title}
      </h1>
    );

  return (
    <div className={cn("space-y-1.5", className)}>
      {backLink ? <BackLink {...backLink} /> : null}
      {topSlot}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          {heading}
          {description ? (
            <p className="text-muted-foreground text-sm">{description}</p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}
