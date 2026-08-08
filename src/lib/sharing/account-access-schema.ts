import { z } from "zod/v4";

import type { AccountAccess } from "./account-access-view";
import { SHARE_DOMAINS } from "./scope";

const accountAccessLevelSchema = z.enum(["read", "write", "manage"]);
const accountRecordKindSchema = z.enum(["shared", "managed"]);
const shareSectionsSchema = z.array(z.enum(SHARE_DOMAINS)).nullable();

/** The browser's resolved account-access payload, shared with OpenAPI. */
export const accountAccessEntrySchema = z
  .object({
    accountId: z.string().min(1),
    username: z.string().min(1),
    displayName: z.string().nullable(),
    // v1.37.2 — the record owner's full name, shown in front of a delegate on
    // the switcher + banner. A deliberate disclosure to everyone they share
    // with; see `accountLabel`.
    fullName: z.string().nullable(),
    access: z.enum(["read", "write"]),
    level: accountAccessLevelSchema,
    recordKind: accountRecordKindSchema,
    sections: shareSectionsSchema,
    canWrite: z.boolean(),
  })
  .superRefine((entry, ctx) => {
    const uniqueSections = new Set(entry.sections ?? []);
    if (uniqueSections.size !== (entry.sections?.length ?? 0)) {
      ctx.addIssue({
        code: "custom",
        message: "Account access sections must not repeat a domain",
        path: ["sections"],
      });
    }

    const isManage = entry.level === "manage";
    if (isManage && (entry.access !== "write" || entry.sections !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "Manage access must use legacy write access and whole scope",
      });
    }

    if (entry.canWrite !== (entry.level !== "read")) {
      ctx.addIssue({
        code: "custom",
        message: "Account access write flag disagrees with its level",
        path: ["canWrite"],
      });
    }

    if (!isManage && entry.access !== entry.level) {
      ctx.addIssue({
        code: "custom",
        message: "Legacy access must agree with the resolved level",
        path: ["access"],
      });
    }
  });

export const accountAccessBlockSchema = z.object({
  accounts: z.array(accountAccessEntrySchema),
  active: accountAccessEntrySchema.nullable(),
  recordKind: z.enum(["self", "shared", "managed"]),
  canSwitch: z.boolean(),
});

/** Both published views of the active record must name the same resolved grant. */
function matchesCanonicalAccountAccessEntry(
  active: z.infer<typeof accountAccessEntrySchema>,
  canonical: z.infer<typeof accountAccessEntrySchema>,
): boolean {
  const activeSections = active.sections;
  const canonicalSections = canonical.sections;
  const sameSections =
    activeSections === null || canonicalSections === null
      ? activeSections === canonicalSections
      : activeSections.length === canonicalSections.length &&
        activeSections.every(
          (section, index) => section === canonicalSections[index],
        );

  return (
    active.accountId === canonical.accountId &&
    active.username === canonical.username &&
    active.displayName === canonical.displayName &&
    active.fullName === canonical.fullName &&
    active.access === canonical.access &&
    active.level === canonical.level &&
    active.recordKind === canonical.recordKind &&
    active.canWrite === canonical.canWrite &&
    sameSections
  );
}

/** Parse the server-resolved access block as a closed presentation contract. */
export function parseAccountAccess(value: unknown): AccountAccess | null {
  const parsed = accountAccessBlockSchema.safeParse(value);
  if (!parsed.success) return null;

  const { accounts, active, recordKind, canSwitch } = parsed.data;
  const accountIds = new Set(accounts.map((entry) => entry.accountId));
  if (
    accountIds.size !== accounts.length ||
    canSwitch !== accounts.length > 0
  ) {
    return null;
  }

  if (active === null) {
    return recordKind === "self"
      ? { accounts, active: null, recordKind, canSwitch }
      : null;
  }

  if (!accountIds.has(active.accountId) || recordKind !== active.recordKind) {
    return null;
  }

  const canonicalActive = accounts.find(
    (entry) => entry.accountId === active.accountId,
  );
  if (
    !canonicalActive ||
    !matchesCanonicalAccountAccessEntry(active, canonicalActive)
  ) {
    return null;
  }

  return { accounts, active: canonicalActive, recordKind, canSwitch };
}
