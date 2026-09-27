"use client";

/**
 * v1.39.4 — copy a Coach result table: for a spreadsheet (tab-separated
 * values plus an HTML table, so a document gets a real table too) or as
 * aligned plain text.
 *
 * A check mark and a polite live "Copied" confirm for two seconds; a failure
 * says so in a toast. Absent where the Clipboard API is (plain-HTTP
 * self-hosts), rather than failing on every tap.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTranslations } from "@/lib/i18n/context";
import { COACH_RESULT_UI_KEYS } from "@/lib/ai/coach/dialog-keys";
import {
  copyResultTable,
  copyResultText,
  type ClipboardGrid,
} from "@/lib/insights/coach-result-clipboard";

import { COACH_ICON_BUTTON, useClipboardSupported } from "./read-aloud";

/** How long the confirmation stays up. */
export const COPY_CONFIRM_MS = 2_000;

export interface CopyTableButtonProps {
  /** Built on demand, so a table nobody copies formats nothing extra. */
  grid: () => ClipboardGrid;
  caption: string;
}

export function CopyTableButton({ grid, caption }: CopyTableButtonProps) {
  const { t } = useTranslations();
  const supported = useClipboardSupported();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const run = useCallback(
    async (copy: (g: ClipboardGrid, c: string) => Promise<void>) => {
      try {
        await copy(grid(), caption);
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          setCopied(false);
          timer.current = null;
        }, COPY_CONFIRM_MS);
      } catch {
        toast.error(t(COACH_RESULT_UI_KEYS.copyFailed));
      }
    },
    [grid, caption, t],
  );

  if (!supported) return null;
  const label = t(COACH_RESULT_UI_KEYS.copyMenu);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-slot="coach-copy-table"
            aria-label={label}
            title={label}
            className={COACH_ICON_BUTTON}
          >
            {copied ? (
              <Check className="text-success size-3.5" aria-hidden="true" />
            ) : (
              <Copy className="size-3.5" aria-hidden="true" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-slot="coach-copy-table-spreadsheet"
            onSelect={() => void run(copyResultTable)}
          >
            {t(COACH_RESULT_UI_KEYS.copyForSpreadsheet)}
          </DropdownMenuItem>
          <DropdownMenuItem
            data-slot="coach-copy-table-text"
            onSelect={() => void run(copyResultText)}
          >
            {t(COACH_RESULT_UI_KEYS.copyAsText)}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? t(COACH_RESULT_UI_KEYS.copied) : ""}
      </span>
    </>
  );
}
