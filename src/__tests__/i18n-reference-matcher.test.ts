/**
 * v1.32.36 — unit tests for the reverse-i18n reachability matcher.
 *
 * The reverse-coverage guard is a pair guard, and a pair guard is worthless the
 * moment its matcher over-accepts: it stays green while proving nothing. That
 * is what happened here — one template anchored at a bare `settings.` marked
 * several thousand keys reachable and nobody could tell from the green run.
 *
 * So the matcher gets its own tests over synthetic sources, where the expected
 * answer is known exactly. The first test below is the regression: it plants
 * the old hole and asserts the collector now refuses it out loud.
 */
import { describe, it, expect } from "vitest";

import { collectReferences, isReferenced } from "./helpers/i18n-reference";

const NAMESPACES = new Set([
  "settings",
  "cycle",
  "measurementReminders",
  "notifications",
  "insights",
]);

function run(source: string, nodes: string[] = []) {
  return collectReferences(source, new Set(nodes), NAMESPACES);
}

describe("i18n reference matcher", () => {
  describe("bare top-level namespaces", () => {
    it("refuses a suffix-less template anchored at a bare namespace", () => {
      const { violations } = run("t(`measurementReminders.${due.key}`)");

      expect(violations).toHaveLength(1);
      expect(violations[0].literal).toContain("measurementReminders.");
    });

    it("does not silently whitelist the namespace it refused", () => {
      const { ref } = run("t(`measurementReminders.${due.key}`)");

      expect(isReferenced("measurementReminders.somethingDead", ref)).toBe(
        false,
      );
    });

    it("refuses the same shape arriving through the concat arm", () => {
      const { violations, ref } = run('const k = "settings." + provider;');

      expect(violations).toHaveLength(1);
      expect(violations[0].arm).toBe("concat");
      expect(isReferenced("settings.anythingAtAll", ref)).toBe(false);
    });

    it("refuses the same shape arriving outside a t() call", () => {
      const { violations } = run("const key = `cycle.${phase}`;");

      expect(violations[0].arm).toBe("assignment");
    });

    it("accepts a deep prefix, which confines itself", () => {
      const { violations, ref } = run("t(`cycle.phase.${phase}`)");

      expect(violations).toHaveLength(0);
      expect(isReferenced("cycle.phase.follicular", ref)).toBe(true);
      expect(isReferenced("cycle.somethingElse", ref)).toBe(false);
    });
  });

  describe("pair templates", () => {
    it("covers only leaves matching both ends", () => {
      const { violations, ref } = run(
        "t(`settings.${provider}OauthConnected`)",
      );

      expect(violations).toHaveLength(0);
      expect(isReferenced("settings.polarOauthConnected", ref)).toBe(true);
      expect(isReferenced("settings.withingsOauthConnected", ref)).toBe(true);
      expect(isReferenced("settings.anythingElse", ref)).toBe(false);
      expect(isReferenced("settings.polarOauthFailed", ref)).toBe(false);
    });

    it("honours a dot-rooted suffix as a path boundary", () => {
      const { ref } = run("t(`insights.section.${slug}.title`)");

      expect(isReferenced("insights.section.sleep.title", ref)).toBe(true);
      // `subtitle` ends in "title" but not in ".title".
      expect(isReferenced("insights.section.sleep.subtitle", ref)).toBe(false);
    });
  });

  describe("suffix templates", () => {
    it("means nothing without a base another arm established", () => {
      const { ref } = run("t(`${i18nPrefix}SyncResult`)");

      expect(isReferenced("settings.withingsSyncResult", ref)).toBe(false);
    });

    it("attaches to a declared i18nPrefix base", () => {
      const { ref } = run(
        'i18nPrefix="settings.withings"\nt(`${i18nPrefix}SyncResult`)',
      );

      expect(isReferenced("settings.withingsSyncResult", ref)).toBe(true);
      expect(isReferenced("settings.withings", ref)).toBe(true);
      // The declaration is a base, not a subtree licence.
      expect(isReferenced("settings.withingsSomethingDead", ref)).toBe(false);
      expect(isReferenced("settings.polarSyncResult", ref)).toBe(false);
    });

    it("attaches to a base established by a literal node path", () => {
      const { ref } = run(
        'const p = "insights.walkingSpeed";\nt(`${p}.title`)',
        ["insights.walkingSpeed"],
      );

      expect(isReferenced("insights.walkingSpeed.title", ref)).toBe(true);
    });
  });

  describe("literal keys", () => {
    it("covers the key and its subtree", () => {
      const { ref } = run('t("settings.export.title")\nt("cycle.phase")');

      expect(isReferenced("settings.export.title", ref)).toBe(true);
      expect(isReferenced("cycle.phase.luteal", ref)).toBe(true);
      expect(isReferenced("settings.export.subtitle", ref)).toBe(false);
    });

    it("covers exactly the three plural tiers of a counted key", () => {
      const { ref } = run('tCount("insights.staleWeeks", n)');

      expect(isReferenced("insights.staleWeeksOne", ref)).toBe(true);
      expect(isReferenced("insights.staleWeeksFew", ref)).toBe(true);
      expect(isReferenced("insights.staleWeeksOther", ref)).toBe(true);
      expect(isReferenced("insights.staleWeeksMany", ref)).toBe(false);
    });
  });

  describe("scope", () => {
    it("ignores an interpolating template that is not namespace-rooted", () => {
      const { violations, ref } = run("const cacheKey = `coach.${userId}`;");

      expect(violations).toHaveLength(0);
      expect(isReferenced("coach.anything", ref)).toBe(false);
    });
  });
});
