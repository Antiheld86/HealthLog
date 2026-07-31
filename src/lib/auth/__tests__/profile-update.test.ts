import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth/audit", () => ({
  auditLog: vi.fn().mockResolvedValue(undefined),
}));

import { applyProfileUpdate } from "../profile-update";
import { prisma } from "@/lib/db";

const USER_ID = "user-1";

const STUB_USER = {
  id: USER_ID,
  username: "testuser",
  displayName: null,
  email: null,
  role: "USER",
  heightCm: null,
  dateOfBirth: null,
  gender: null,
  timezone: "Europe/Berlin",
  locale: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prisma.user.update).mockResolvedValue(STUB_USER as never);
});

describe("applyProfileUpdate timezone validation", () => {
  it("accepts a valid IANA zone", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timezone: "Europe/Berlin",
    });
    expect(result.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown zone with 422, naming the field without echoing raw validator prose", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timezone: "Mars/Tharsis",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      // The specific validator reason is relocated to `issues`, not deleted.
      expect(result.issues).toEqual([
        expect.objectContaining({
          path: "timezone",
          message: expect.stringMatching(/Invalid IANA timezone/i),
        }),
      ]);
      // The top-level message stays a sentence for a person: it names the
      // field but never repeats the validator's own prose.
      expect(result.message).toMatch(/nothing was saved/i);
      expect(result.message).toMatch(/timezone/i);
      expect(result.message).not.toMatch(/Invalid IANA timezone/i);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an empty-string timezone", async () => {
    const result = await applyProfileUpdate(USER_ID, { timezone: "" });
    expect(result.ok).toBe(false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an injection-shaped string", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timezone: "Europe/Berlin' OR 1=1",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("applyProfileUpdate insurer IK number", () => {
  it("accepts a valid 9-digit IKNR and writes it field-by-field", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      insurerIkNumber: "101234567",
    });
    expect(result.ok).toBe(true);
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.insurerIkNumber).toBe("101234567");
  });

  it("trims surrounding whitespace before validating", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      insurerIkNumber: "  101234567  ",
    });
    expect(result.ok).toBe(true);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.insurerIkNumber).toBe("101234567");
  });

  it("maps an empty string to null (clears the field)", async () => {
    const result = await applyProfileUpdate(USER_ID, { insurerIkNumber: "" });
    expect(result.ok).toBe(true);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.insurerIkNumber).toBeNull();
  });

  it("maps an explicit null to null", async () => {
    const result = await applyProfileUpdate(USER_ID, { insurerIkNumber: null });
    expect(result.ok).toBe(true);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.insurerIkNumber).toBeNull();
  });

  it("leaves the field untouched when omitted", async () => {
    const result = await applyProfileUpdate(USER_ID, { fullName: "Someone" });
    expect(result.ok).toBe(true);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect("insurerIkNumber" in arg.data).toBe(false);
  });

  it("rejects a non-numeric IKNR with 422, relocating the reason to issues", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      insurerIkNumber: "12345678X",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.issues).toEqual([
        expect.objectContaining({
          path: "insurerIkNumber",
          message: expect.stringMatching(/IK number/i),
        }),
      ]);
      expect(result.message).toMatch(/nothing was saved/i);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an IKNR that is not exactly 9 digits with 422", async () => {
    for (const bad of ["1234567", "1234567890"]) {
      vi.mocked(prisma.user.update).mockClear();
      const result = await applyProfileUpdate(USER_ID, {
        insurerIkNumber: bad,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.status).toBe(422);
      expect(prisma.user.update).not.toHaveBeenCalled();
    }
  });
});

describe("applyProfileUpdate partial-field save", () => {
  // Reported regression: the native client sent a lowercase `gender`
  // alongside a valid `heightCm` in one PUT. Because the whole body was
  // one `safeParse` and one transaction, the gender rejection took the
  // height edit down with it — "editing height and gender together lost
  // both". The profile schema has no cross-field dependency, so the
  // fix is to salvage every field that DOES validate.
  it("writes the valid sibling field when another field in the same body is invalid", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      heightCm: 180,
      gender: "male", // wrong case — the client-side half of the bug
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFields).toEqual([
        expect.objectContaining({ path: "gender" }),
      ]);
    }
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.user.update).mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(arg.data.heightCm).toBe(180);
    expect("gender" in arg.data).toBe(false);
  });

  it("omits `rejectedFields` entirely when every touched field is valid", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      heightCm: 175,
      gender: "FEMALE",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rejectedFields).toBeUndefined();
    }
  });

  it("writes nothing and reports every rejected field when the whole body is invalid", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      gender: "male",
      locale: "fr",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      const paths = result.issues?.map((i) => i.path).sort();
      expect(paths).toEqual(["gender", "locale"]);
      expect(result.message).toMatch(/nothing was saved/i);
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("applyProfileUpdate top-level error message", () => {
  // The `locale`/`timeFormat`/`dateFormat` enums carry no custom Zod
  // `error:` message, unlike `gender` — so an invalid value here is the
  // sharpest regression check available for "does the raw Zod default
  // ever reach the top-level string a person reads". Zod v4's default
  // enum message is shaped like:
  //   Invalid option: expected one of "de"|"en"
  const RAW_ZOD_ENUM_PATTERN = /expected one of/i;

  it("never lets the raw Zod enum message reach the top-level `message`", async () => {
    const result = await applyProfileUpdate(USER_ID, { locale: "fr" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toMatch(RAW_ZOD_ENUM_PATTERN);
      expect(result.message).not.toContain('"de"|"en"');
      // Relocated, not deleted: the same detail is still available for
      // whoever needs it (the iOS `details.issues` contract), just not
      // in the string a person reads first.
      expect(result.issues?.[0]?.path).toBe("locale");
    }
  });

  it("never lets the raw Zod enum message reach `message` for timeFormat either", async () => {
    const result = await applyProfileUpdate(USER_ID, {
      timeFormat: "12h",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toMatch(RAW_ZOD_ENUM_PATTERN);
      expect(result.issues?.[0]?.path).toBe("timeFormat");
    }
  });

  it("carries a stable errorCode so the web client can localize the sentence", async () => {
    const result = await applyProfileUpdate(USER_ID, { locale: "fr" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("profile.update.nothingSaved");
    }
  });
});

describe("applyProfileUpdate email conflict", () => {
  it("carries an errorCode alongside the specific 409 message", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: "someone-else",
    } as never);

    const result = await applyProfileUpdate(USER_ID, {
      email: "taken@example.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.errorCode).toBe("profile.update.emailInUse");
      expect(result.issues).toBeUndefined();
    }
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
