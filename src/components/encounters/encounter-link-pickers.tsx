"use client";

/**
 * The visit form's three optional link blocks: documents, lab results,
 * conditions.
 *
 * **The gate blanks the block, it does not post-filter it.** A module the
 * account turned off leaves nothing behind here — no heading, no empty list,
 * no "0 selected". An empty picker for a switched-off module advertises a
 * feature that is not there and invites a person to wonder what is wrong. This
 * is the same shape the dashboard snapshot uses for a disabled module.
 *
 * The encounter itself carries NO module gate. A visit is core, like the
 * checkups page it lives on; what it may point AT follows the modules that own
 * those things, which is why the gate lives here and not on the route.
 *
 * Nothing in this block can block a save. Every list starts empty and stays
 * valid empty.
 */
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, FolderOpen, Stethoscope } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { apiGet } from "@/lib/api/api-fetch";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { ModuleKey } from "@/lib/modules/registry";
import type { IllnessEpisodeDTO } from "@/lib/illness/dto";
import type { InboundDocumentDto } from "@/lib/validations/inbound-documents";

/** How many candidates one block offers before the person must use the sheet. */
const OPTION_LIMIT = 25;

interface Option {
  id: string;
  label: string;
  /** ISO-8601, or null for a target with no date of its own. */
  date: string | null;
}

function LinkBlock({
  icon: Icon,
  title,
  options,
  selected,
  onToggle,
  pending,
  slot,
}: {
  icon: LucideIcon;
  title: string;
  options: Option[];
  selected: string[];
  onToggle: (id: string) => void;
  pending: boolean;
  slot: string;
}) {
  const { t } = useTranslations();
  const format = useFormatters();

  return (
    <div className="space-y-2" data-slot={slot}>
      <div className="flex items-center gap-2">
        <Icon className="text-foreground size-4 shrink-0" aria-hidden />
        <span className="text-sm font-medium">{title}</span>
        {selected.length > 0 ? (
          <Badge variant="outline" className="ml-auto">
            {selected.length}
          </Badge>
        ) : null}
      </div>
      {pending ? (
        <Skeleton className="h-9 w-full rounded-md" />
      ) : options.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("encounters.form.linkNothingToOffer")}
        </p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto overscroll-contain">
          {options.map((option) => {
            const on = selected.includes(option.id);
            return (
              <li key={option.id}>
                <button
                  type="button"
                  aria-pressed={on}
                  data-slot={`${slot}-option`}
                  onClick={() => onToggle(option.id)}
                  className={cn(
                    "border-border hover:bg-muted/50 focus-visible:ring-ring/50 flex min-h-11 w-full items-center gap-2 rounded-md border px-3 text-left focus-visible:ring-[3px] focus-visible:outline-none",
                    on && "border-primary/40 bg-primary/5",
                  )}
                >
                  <span className="text-foreground min-w-0 flex-1 truncate text-sm">
                    {option.label}
                  </span>
                  {option.date ? (
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {format.date(option.date)}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id)
    ? list.filter((entry) => entry !== id)
    : [...list, id];
}

interface LabListPage {
  results: Array<{
    id: string;
    analyte: string;
    panel: string | null;
    takenAt: string;
  }>;
}

interface DocumentListPage {
  documents: InboundDocumentDto[];
}

export function EncounterLinkPickers({
  modules,
  documentIds,
  labResultIds,
  episodeIds,
  onChange,
}: {
  modules: Partial<Record<ModuleKey, boolean>> | undefined;
  documentIds: string[];
  labResultIds: string[];
  episodeIds: string[];
  onChange: (part: {
    documentIds?: string[];
    labResultIds?: string[];
    episodeIds?: string[];
  }) => void;
}) {
  const { t } = useTranslations();

  const documentsOn = modules?.inboundDocuments === true;
  const labsOn = modules?.labs === true;
  const illnessOn = modules?.illness === true;

  const documents = useQuery({
    queryKey: queryKeys.inboundDocumentPicker("encounter-form"),
    enabled: documentsOn,
    queryFn: () =>
      apiGet<DocumentListPage>(
        `/api/documents/inbound?sort=documentDate&order=desc&limit=${OPTION_LIMIT}`,
      ),
  });

  const labs = useQuery({
    queryKey: queryKeys.labResultsList({
      analyte: undefined,
      panel: undefined,
      from: undefined,
      to: undefined,
      page: 0,
      sortDir: "desc",
    }),
    enabled: labsOn,
    queryFn: () =>
      apiGet<LabListPage>(
        `/api/labs?limit=${OPTION_LIMIT}&offset=0&sortDir=desc`,
      ),
  });

  const episodes = useQuery({
    queryKey: queryKeys.illnessEpisodes(true),
    enabled: illnessOn,
    queryFn: () =>
      apiGet<IllnessEpisodeDTO[]>(
        `/api/illness/episodes?includeResolved=true&limit=${OPTION_LIMIT}`,
      ),
  });

  if (!documentsOn && !labsOn && !illnessOn) return null;

  return (
    <div className="space-y-4 border-t pt-4" data-slot="encounter-link-pickers">
      {documentsOn ? (
        <LinkBlock
          icon={FolderOpen}
          title={t("encounters.form.linkDocuments")}
          slot="encounter-link-documents"
          pending={documents.isPending}
          selected={documentIds}
          onToggle={(id) => onChange({ documentIds: toggle(documentIds, id) })}
          options={(documents.data?.documents ?? []).map((doc) => ({
            id: doc.id,
            label: doc.title ?? doc.filename ?? doc.id,
            date: doc.documentDate ?? doc.reportDate ?? doc.createdAt,
          }))}
        />
      ) : null}

      {labsOn ? (
        <LinkBlock
          icon={FlaskConical}
          title={t("encounters.form.linkLabResults")}
          slot="encounter-link-labs"
          pending={labs.isPending}
          selected={labResultIds}
          onToggle={(id) =>
            onChange({ labResultIds: toggle(labResultIds, id) })
          }
          options={(labs.data?.results ?? []).map((result) => ({
            id: result.id,
            label: result.panel
              ? `${result.panel} · ${result.analyte}`
              : result.analyte,
            date: result.takenAt,
          }))}
        />
      ) : null}

      {illnessOn ? (
        <LinkBlock
          icon={Stethoscope}
          title={t("encounters.form.linkConditions")}
          slot="encounter-link-conditions"
          pending={episodes.isPending}
          selected={episodeIds}
          onToggle={(id) => onChange({ episodeIds: toggle(episodeIds, id) })}
          options={(episodes.data ?? []).map((episode) => ({
            id: episode.id,
            label: episode.label,
            date: episode.onsetAt,
          }))}
        />
      ) : null}
    </div>
  );
}
