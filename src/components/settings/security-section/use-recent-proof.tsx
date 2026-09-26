"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

import { useTranslations } from "@/lib/i18n/context";
import { ApiError, apiPost } from "@/lib/api/api-fetch";
import {
  ExistingFactorReauthDialog,
  isReproofRequired,
  type ExistingFactorProof,
  type ReauthMethod,
} from "./existing-factor-reauth-dialog";

const KNOWN_METHODS: readonly ReauthMethod[] = [
  "password",
  "totp",
  "webauthn",
  "passkey",
];

/** The proofs a `auth.reproof.required` refusal says this account can give. */
function methodsFrom(err: ApiError): ReauthMethod[] {
  const raw = err.meta?.methods;
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is ReauthMethod =>
    KNOWN_METHODS.includes(m as ReauthMethod),
  );
}

/** The person closed the re-proof dialog. Nothing ran; show nothing. */
export class ReproofCancelledError extends Error {
  constructor() {
    super("Re-proof cancelled");
    this.name = "ReproofCancelledError";
  }
}

/**
 * The sentence to show for an error `run` rejected with, or null when there is
 * nothing to show (the dialog was cancelled). Any other error returns
 * `fallback`.
 */
export function recentProofErrorMessage(
  err: unknown,
  fallback: string,
): string | null {
  if (err instanceof ReproofCancelledError) return null;
  if (
    err instanceof ApiError &&
    err.meta?.errorCode === "auth.reproof.sign_in_again"
  ) {
    return err.message;
  }
  return fallback;
}

/**
 * Turn a raw `Response` from a download or upload call site into the
 * `ApiError` the hook recognises, when it is the recent-proof refusal. Any
 * other response is returned untouched for the caller's own handling.
 */
export async function throwIfReproofRequired(res: Response): Promise<Response> {
  if (res.status !== 401) return res;
  let body: { error?: unknown; meta?: unknown } | null = null;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  const meta =
    body && typeof body.meta === "object" && body.meta !== null
      ? (body.meta as Record<string, unknown>)
      : undefined;
  const err = new ApiError(
    typeof body?.error === "string" ? body.error : "",
    401,
    meta,
  );
  if (isReproofRequired(err)) throw err;
  return res;
}

/**
 * Run an action that the server may hold back for a fresh proof.
 *
 * Exports of the whole record, share links, token minting and the admin data
 * actions answer 401 `auth.reproof.required` with `meta.methods` when the
 * session has not signed in or re-proved within five minutes. `run` catches
 * exactly that refusal, opens the re-proof dialog with the listed methods,
 * posts the proof to `/api/auth/reproof` and runs the action once more. Every
 * other error rejects as usual; a cancelled dialog rejects with
 * `ReproofCancelledError`. `recentProofErrorMessage` maps both for display.
 *
 * An account with nothing to re-prove in place (signed in through single
 * sign-on only) gets no dialog: the refusal is rethrown with a message asking
 * to sign in again.
 */
export function useRecentProof(): {
  run: <T>(action: () => Promise<T>) => Promise<T>;
  dialog: ReactNode;
} {
  const { t } = useTranslations();
  const [methods, setMethods] = useState<ReauthMethod[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiter = useRef<{
    resolve: () => void;
    reject: () => void;
  } | null>(null);

  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (!isReproofRequired(err)) throw err;
        const offered = methodsFrom(err as ApiError);
        if (offered.length === 0) {
          throw new ApiError(t("settings.reproof.signInAgain"), 401, {
            errorCode: "auth.reproof.sign_in_again",
          });
        }
        await new Promise<void>((resolve, reject) => {
          waiter.current = {
            resolve,
            reject: () => reject(new ReproofCancelledError()),
          };
          setError(null);
          setMethods(offered);
        });
        return action();
      }
    },
    [t],
  );

  const onProof = useCallback(
    async (proof: ExistingFactorProof) => {
      setPending(true);
      setError(null);
      try {
        await apiPost("/api/auth/reproof", proof);
        setMethods(null);
        const w = waiter.current;
        waiter.current = null;
        w?.resolve();
      } catch (err) {
        setError(
          err instanceof ApiError && err.status === 429
            ? err.message
            : t("settings.reproof.failed"),
        );
      } finally {
        setPending(false);
      }
    },
    [t],
  );

  const dialog = (
    <ExistingFactorReauthDialog
      key={methods?.join(",") ?? "closed"}
      open={methods !== null}
      onOpenChange={(open) => {
        if (open) return;
        setMethods(null);
        setError(null);
        const w = waiter.current;
        waiter.current = null;
        w?.reject();
      }}
      methods={methods ?? ["password"]}
      pending={pending}
      error={error}
      onProof={(proof) => void onProof(proof)}
      description={t("settings.reproof.description")}
    />
  );

  return { run, dialog };
}
