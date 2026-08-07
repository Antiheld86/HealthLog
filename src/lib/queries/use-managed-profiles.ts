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
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import { apiDelete, apiGet, apiPost } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import { invalidateGrantReads } from "@/lib/queries/use-account-grants";
import type { GrantParty } from "@/lib/queries/use-account-grants";
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

/** One person who looks after a profile, as the roster publishes them. */
export interface ManagedProfileGuardian {
  /** The grant row — what `DELETE .../guardians/{grantId}` takes. */
  grantId: string;
  account: GrantParty;
  /**
   * PENDING or ACTIVE. Only ACTIVE counts toward the last-Guardian floor, and
   * the server counts the same way — a pending invitation does not let the
   * last Guardian leave.
   */
  state: "PENDING" | "ACTIVE";
  invitedAt: string;
  acceptedAt: string | null;
}

/**
 * Who else looks after this profile.
 *
 * The read the removal control needs to exist at all: a Guardian grant has the
 * PROFILE as grantor, so it never appears in the caller's own given-list and
 * `GET /api/account/grants` cannot supply the `grantId`. It is also where the
 * last-Guardian floor is counted from BEFORE the act rather than discovered as
 * a 409 after it.
 */
export function useManagedProfileGuardians(profileId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.managedProfileGuardians(profileId),
    queryFn: () =>
      apiGet<ManagedProfileGuardian[]>(
        `/api/managed-profiles/${profileId}/guardians`,
      ),
    enabled,
  });
}

/**
 * Delete a managed profile, and everything recorded in it.
 *
 * The variable is the profile id, which is what lets a refusal be rendered on
 * the row it was refused for rather than somewhere near it.
 *
 * This route emits no last-Guardian refusal, and that is deliberate rather
 * than an omission: deleting the profile is the documented way OUT of the
 * floor. A Guardian may not strand a record with nobody looking after it, but
 * they may end the record.
 */
export function useDeleteManagedProfile() {
  const invalidate = useInvalidateManagedProfiles();
  return useMutation({
    mutationKey: queryKeys.managedProfileDelete(),
    mutationFn: (profileId: string) =>
      apiDelete<{ deleted: true }>(`/api/managed-profiles/${profileId}`),
    onSuccess: invalidate,
  });
}
