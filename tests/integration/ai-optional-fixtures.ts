/**
 * Shared fixtures for the `ai-optional-*` integration files: one fully set-up
 * account, and one function per state in the design's state matrix, each
 * changing exactly one layer against that baseline.
 *
 *   S0  all on: own key (presence only), every receipt, every switch on
 *   S1  the operator's master switch off
 *   S2  one operator sub-switch off
 *   S3  no provider configured anywhere
 *   S4  only the operator's key, and no consent receipt
 *   S5  the Coach hidden by the person (`disableCoach`)
 *   S6  the AI analysis opt-out (`insights` module off)
 *   S8  a delegate with MANAGE access inside somebody else's record
 *
 * Not a test file: the `vi.mock` blocks stay in each file, because Vitest
 * hoists them per file.
 */
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, switchSessionTo, truncateAllTables } from "./setup";

let counter = 0;

export async function resetWorld(): Promise<void> {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  counter = 0;
}

/** A person with their own Anthropic key and the `ai_full` receipt: S0. */
export async function makeUser(
  label: string,
  overrides: Record<string, unknown> = {},
) {
  const suffix = `${label}-${counter++}`;
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: `aio-${suffix}`,
      email: `aio-${suffix}@example.test`,
      role: "USER",
      timezone: "UTC",
      locale: "en",
      onboardingCompletedAt: new Date(),
      aiProvider: "ANTHROPIC",
      aiModel: "claude-sonnet-4-6",
      // Presence only: the capability probe never decrypts.
      aiAnthropicKeyEncrypted: "v1:presence-only",
      ...overrides,
    },
  });
  await prisma.consentReceipt.create({
    data: {
      userId: user.id,
      kind: "ai_full",
      artefact: "test",
      signedAt: new Date(),
    },
  });
  return user;
}

export async function setSwitches(values: Record<string, unknown>) {
  await getPrismaClient().appSettings.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...values },
    update: values,
  });
}

export async function signIn(userId: string) {
  const session = await getPrismaClient().session.create({
    data: { userId, expiresAt: new Date(Date.now() + 60_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return session;
}

export type StateName = "S0" | "S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S8";

export interface World {
  /** The record the requests read and write. */
  recordId: string;
  /** Who is signed in. */
  actorId: string;
}

/**
 * Build the world for one state and sign in. `seed` runs against the record
 * before the session is opened, so every state reads the same data.
 */
export async function enterState(
  state: StateName,
  seed: (recordId: string) => Promise<void> = async () => {},
): Promise<World> {
  const prisma = getPrismaClient();
  switch (state) {
    case "S0": {
      const user = await makeUser("s0");
      await seed(user.id);
      await signIn(user.id);
      return { recordId: user.id, actorId: user.id };
    }
    case "S1": {
      const user = await makeUser("s1");
      await setSwitches({ assistantEnabled: false });
      await seed(user.id);
      await signIn(user.id);
      return { recordId: user.id, actorId: user.id };
    }
    case "S2": {
      const user = await makeUser("s2");
      await setSwitches({
        assistantInsightStatusEnabled: false,
        assistantCoachEnabled: false,
        assistantBriefingEnabled: false,
      });
      await seed(user.id);
      await signIn(user.id);
      return { recordId: user.id, actorId: user.id };
    }
    case "S3": {
      const user = await makeUser("s3", {
        aiProvider: null,
        aiModel: null,
        aiAnthropicKeyEncrypted: null,
      });
      await seed(user.id);
      await signIn(user.id);
      return { recordId: user.id, actorId: user.id };
    }
    case "S4": {
      const user = await makeUser("s4", {
        aiProvider: null,
        aiModel: null,
        aiAnthropicKeyEncrypted: null,
      });
      await prisma.consentReceipt.deleteMany({ where: { userId: user.id } });
      await setSwitches({
        adminAiKeyEncrypted: "v1:presence-only",
        adminAiModel: "gpt-4o",
      });
      await seed(user.id);
      await signIn(user.id);
      return { recordId: user.id, actorId: user.id };
    }
    case "S5": {
      const user = await makeUser("s5", { disableCoach: true });
      await seed(user.id);
      await signIn(user.id);
      return { recordId: user.id, actorId: user.id };
    }
    case "S6": {
      const user = await makeUser("s6", {
        modulePreferencesJson: { insights: false },
      });
      await seed(user.id);
      await signIn(user.id);
      return { recordId: user.id, actorId: user.id };
    }
    case "S8": {
      const owner = await makeUser("s8-owner");
      const delegate = await makeUser("s8-delegate");
      await prisma.accountGrant.create({
        data: {
          grantorId: owner.id,
          granteeId: delegate.id,
          access: "MANAGE",
          acceptedAt: new Date(),
        },
      });
      await seed(owner.id);
      const session = await signIn(delegate.id);
      await switchSessionTo(session.id, owner.id);
      return { recordId: owner.id, actorId: delegate.id };
    }
  }
}

/**
 * The body with the per-request AI state and the clock stripped, so two
 * states can be compared on their data alone.
 */
export function withoutAiAndClock(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAiAndClock);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (
        key === "ai" ||
        key === "generatedAt" ||
        key === "revalidating" ||
        key === "hasProvider"
      ) {
        continue;
      }
      out[key] = withoutAiAndClock(inner);
    }
    return out;
  }
  return value;
}
