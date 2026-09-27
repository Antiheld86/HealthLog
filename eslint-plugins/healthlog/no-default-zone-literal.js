/**
 * @fileoverview ESLint rule — the default zone is named in one place.
 *
 * `"Europe/Berlin"` was written out in some eighty places: fallbacks for a
 * user with no zone, day keys cut in Berlin whatever the user's zone, a
 * graded series folded on Berlin days, a prompt that labelled every date as
 * Berlin's. Each copy was a place where a user outside that zone got
 * someone else's calendar. `DEFAULT_TIMEZONE` in `src/lib/tz/format.ts` is
 * the one definition; everything else imports it, and a surface that means
 * the user's own zone asks for it (`resolveUserTimezone`).
 *
 * The rule flags a string literal or template element containing
 * `Europe/Berlin` in `src/`, outside `src/lib/tz/` and outside test files
 * (fixtures pick concrete zones on purpose). Comments are not checked.
 *
 * WHAT THIS RULE DOES NOT CATCH
 *
 * A zone assembled from parts (`"Europe/" + city`), a different hard-coded
 * zone, or a Berlin day computed through an `Intl.DateTimeFormat` built from
 * a variable. It removes the literal, not every way to hard-code a calendar.
 *
 */

"use strict";

const ZONE = "Europe/Berlin";

const EXEMPT_ROOTS = ["src/lib/tz/"];

function toPosix(filename) {
  return filename.replace(/\\/g, "/");
}

function isTestFile(posix) {
  return (
    /\.test\.[cm]?[jt]sx?$/.test(posix) ||
    /\.spec\.[cm]?[jt]sx?$/.test(posix) ||
    posix.includes("/__tests__/") ||
    posix.includes("/__mocks__/")
  );
}

function isEnforced(filename) {
  const posix = toPosix(filename);
  if (!posix.includes("/src/") && !posix.startsWith("src/")) return false;
  if (EXEMPT_ROOTS.some((root) => posix.includes(root))) return false;
  if (isTestFile(posix)) return false;
  return true;
}

/** @type {import("eslint").Rule.RuleModule} */
const noDefaultZoneLiteralRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Import DEFAULT_TIMEZONE from @/lib/tz/format instead of writing the zone out.",
    },
    schema: [],
    messages: {
      zoneLiteral:
        'Do not write "Europe/Berlin" out. Import DEFAULT_TIMEZONE from "@/lib/tz/format" for a fallback, or use the user\'s own zone (resolveUserTimezone / the profile timezone) for a day boundary.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename?.();
    if (!filename || !isEnforced(filename)) {
      return {};
    }
    return {
      Literal(node) {
        if (typeof node.value === "string" && node.value.includes(ZONE)) {
          context.report({ node, messageId: "zoneLiteral" });
        }
      },
      TemplateElement(node) {
        const raw = node.value && (node.value.cooked ?? node.value.raw);
        if (typeof raw === "string" && raw.includes(ZONE)) {
          context.report({ node, messageId: "zoneLiteral" });
        }
      },
      JSXText(node) {
        if (typeof node.value === "string" && node.value.includes(ZONE)) {
          context.report({ node, messageId: "zoneLiteral" });
        }
      },
    };
  },
};

module.exports = noDefaultZoneLiteralRule;
