"use client";

/**
 * v1.37.0 — the reads and writes behind the managed-profile surface.
 *
 * A managed profile is a record with no login of its own. It is created by the
 * person who will look after it, and from that moment it exists only through
 * its Guardians — which is why every call here refreshes the ACCOUNT payload
 * and not merely the panel it was fired from.
 *
 * That is the one property worth stating up front. The list of profiles a
 * Guardian looks after is not a read of its own: it is `accountAccess.accounts`
 * on `GET /api/auth/me`, filtered to the managed entries, because the Guardian's
 * relationship to the profile IS a MANAGE grant. So a creation that refreshed
 * the sharing panel and not the payload would leave the new profile invisible —
 * in the switcher, in the banner, and in this card — until the next boot. Every
 * mutation below therefore goes through `invalidateGrantReads`, the one entry
 * `use-account-grants.ts` already publishes for exactly this fan-out; the
 * managed-profile family rides it as a key prefix rather than as a second
 * invalidation path (`grantDependentKeys`).
 */

import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { invalidateGrantReads } from "@/lib/queries/use-account-grants";
import type { Locale } from "@/lib/i18n/config";

/**
 * Exactly the body `POST /api/managed-profiles` accepts.
 *
 * The route's schema is `.strict()`, so an extra key is a 422 with nothing
 * useful in it — a form that helpfully posted an empty `heightCm` would be
 * refused for a field the person never saw. Naming the four fields as a type
 * rather than passing the form state through is what stops that: a fifth field
 * added to the form cannot reach the wire without somebody deciding it should.
 */
export interface CreateManagedProfileInput {
  displayName: string;
  /** ISO `yyyy-MM-dd`, or null. Never synthesised from a year. */
  dateOfBirth: string | null;
  locale: Locale;
  /** IANA zone name. */
  timezone: string;
}

/** What the create route answers with. */
export interface ManagedProfileCreated {
  id: string;
  displayName: string;
  dateOfBirth: string | null;
  locale: string;
  timezone: string;
  recordKind: "managed";
}

/**
 * Everything a managed-profile lifecycle change makes stale.
 *
 * Exported as a plain function over a `QueryClient` for the same reason
 * `invalidateGrantReads` is: a test can hand it a real client, seed the reads
 * and check they came back invalidated. "The mutation calls invalidate" is a
 * claim about the source; "the account payload comes back invalidated" is the
 * claim that decides whether the new profile appears in the switcher.
 */
export function invalidateManagedProfileReads(queryClient: QueryClient): void {
  invalidateGrantReads(queryClient);
}

/** The same refresh, bound to the mounted client. */
function useInvalidateManagedProfiles() {
  const queryClient = useQueryClient();
  return () => invalidateManagedProfileReads(queryClient);
}

/**
 * Create a record somebody looks after.
 *
 * `requireFreshMfa` guards the route, so a 401 carrying
 * `meta.errorCode: auth.stepup.required` is the EXPECTED first answer for
 * anybody who has a second factor and has not proved it recently. The form
 * routes that into the app's re-verification path rather than into a generic
 * failure — see `managed-profile-create-form.tsx`.
 */
export function useCreateManagedProfile() {
  const invalidate = useInvalidateManagedProfiles();
  return useMutation({
    mutationKey: queryKeys.managedProfileCreate(),
    mutationFn: (input: CreateManagedProfileInput) =>
      apiPost<ManagedProfileCreated>("/api/managed-profiles", input),
    onSuccess: invalidate,
  });
}
