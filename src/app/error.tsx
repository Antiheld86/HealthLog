"use client";

import { useEffect } from "react";
import { ErrorDetails } from "@/components/error-details";

const CHUNK_RELOAD_KEY = "healthlog:chunk-reload-attempted";
const SHELL_VERSION = process.env.NEXT_PUBLIC_APP_VERSION || "";

function isChunkLoadError(err: Error & { digest?: string }): boolean {
  if (err.name === "ChunkLoadError") return true;
  const msg = err.message ?? "";
  return (
    msg.includes("Loading chunk") ||
    msg.includes("Loading CSS chunk") ||
    msg.includes("Failed to load chunk") ||
    msg.includes("Failed to fetch dynamically imported module")
  );
}

/**
 * Guard value recorded per auto-reload attempt — the running shell's
 * build version, so the suppression is scoped to ONE shell. After a
 * successful heal the reloaded page carries the NEW version and the
 * guard re-arms by construction; only a shell that reloaded and is
 * STILL broken (the new build is also missing the chunk) stays
 * suppressed. Builds without an injected version degrade to the legacy
 * once-per-session behaviour via the "unversioned" sentinel.
 */
export function chunkReloadGuardValue(shellVersion: string): string {
  return shellVersion || "unversioned";
}

/**
 * Pure reload decision so the guard semantics carry direct unit
 * coverage. `stored` is the sessionStorage value from the last attempt
 * (`null` when none happened); legacy guard values (the pre-v1.16.8
 * timestamp) never match a version string, so a session stuck from
 * before the change heals on its next chunk error.
 */
export function shouldAttemptChunkReload(
  stored: string | null,
  shellVersion: string,
): boolean {
  return stored !== chunkReloadGuardValue(shellVersion);
}

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to any client-side error tracker that's already hooked up.
    if (typeof window !== "undefined") {
      const g = window as typeof window & {
        __healthlog_onError?: (err: Error & { digest?: string }) => void;
      };
      g.__healthlog_onError?.(error);
    }

    // v1.4.38.3 — auto-recover from a stale-shell chunk-load error.
    // After a deploy the cached shell still references old chunk
    // filenames; they 404 and Next.js surfaces them as `ChunkLoadError`.
    // A single hard reload fetches the new shell + chunk graph.
    // The sessionStorage guard is keyed on the shell version (see
    // `chunkReloadGuardValue`) so it suppresses a loop within ONE
    // broken shell but re-arms after every deploy — the pre-v1.16.8
    // once-per-session guard exhausted on multi-deploy days and left
    // the user on the error page with no automatic way out.
    if (typeof window !== "undefined" && isChunkLoadError(error)) {
      try {
        const stored = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
        if (shouldAttemptChunkReload(stored, SHELL_VERSION)) {
          window.sessionStorage.setItem(
            CHUNK_RELOAD_KEY,
            chunkReloadGuardValue(SHELL_VERSION),
          );
          window.location.reload();
        }
      } catch {
        // sessionStorage can throw under strict privacy modes — fall
        // through to the error UI in that case.
      }
    }
  }, [error]);

  return <ErrorDetails error={error} reset={reset} />;
}
