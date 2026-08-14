"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

/**
 * URL-owned filter state — the documents-vault pattern
 * (`src/components/documents/documents-view.tsx`), extracted so the
 * measurements and mood management lists carry the same contract: the page's
 * filter object is parsed from the live query string and every change writes
 * the serialised form back through the router, so a filtered view survives
 * navigation, reload, back/forward and sharing.
 *
 * `parse` and `serialise` must be inverse, module-level functions (stable
 * identities): round-tripping is what keeps a deep link and the UI agreeing,
 * and `serialise` omits defaults so the unfiltered view keeps a bare URL.
 *
 * Mode grammar (matching the vault): a discrete facet change (`push`, the
 * default) creates a history entry so Back steps through filter states, like
 * the vault's kind/year chips; high-frequency typed input passes `replace` so
 * the history never fills with keystrokes, like the vault's debounced search.
 *
 * `syncToUrl: false` keeps the identical contract in component memory only —
 * for a list embedded under a URL that belongs to another surface (the
 * type-locked insights readings subpage).
 */
export function useUrlFilterSync<T>({
  parse,
  serialise,
  syncToUrl = true,
}: {
  parse: (params: URLSearchParams) => T;
  serialise: (filters: T) => string;
  syncToUrl?: boolean;
}): {
  filters: T;
  applyFilters: (next: T, mode?: "push" | "replace") => void;
} {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlFilters = useMemo(
    () => parse(new URLSearchParams(searchParams.toString())),
    [parse, searchParams],
  );

  // Memory-only fallback for `syncToUrl: false`. The hook always mounts both
  // sources (hooks are unconditional); only one is read.
  const [localFilters, setLocalFilters] = useState<T>(() =>
    parse(new URLSearchParams()),
  );

  const applyFilters = useCallback(
    (next: T, mode: "push" | "replace" = "push") => {
      if (!syncToUrl) {
        setLocalFilters(next);
        return;
      }
      const search = serialise(next);
      const href = search ? `${pathname}?${search}` : pathname;
      if (mode === "push") {
        router.push(href, { scroll: false });
      } else {
        router.replace(href, { scroll: false });
      }
    },
    [syncToUrl, serialise, pathname, router],
  );

  return { filters: syncToUrl ? urlFilters : localFilters, applyFilters };
}
