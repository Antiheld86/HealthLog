/**
 * The two machine-format downloads on a share link.
 *
 * A practice opens the link, unlocks it, and saves the file into their system.
 * These serve exactly the link's frozen selection — the same object the page
 * above renders from — behind the same unlock cookie the document route
 * enforces. There is no bearer face and no new scope.
 *
 * Rendered only for a link that actually carries a record; a documents-only
 * share has nothing to download here.
 */
import { Download } from "lucide-react";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function ShareDownloadActions({
  t,
  token,
}: {
  t: Translate;
  token: string;
}) {
  const base = `/c/${encodeURIComponent(token)}`;
  const actions = [
    { href: `${base}/report.pdf`, label: t("clinicianView.downloadPdf") },
    { href: `${base}/fhir`, label: t("clinicianView.downloadFhir") },
  ];
  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid="share-downloads">
      {actions.map((action) => (
        <a
          key={action.href}
          href={action.href}
          download
          className="border-border hover:bg-muted focus-visible:ring-ring/50 inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border px-3 text-xs font-medium focus-visible:ring-[3px] focus-visible:outline-none sm:min-h-9"
        >
          <Download className="size-3.5" aria-hidden />
          {action.label}
        </a>
      ))}
    </div>
  );
}
