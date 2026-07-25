/**
 * v1.32.36 — the reachability matcher behind `i18n-reverse-coverage.test.ts`,
 * extracted so it can be unit-tested in isolation.
 *
 * The reverse guard asserts that every leaf in `messages/en.json` is reachable
 * from at least one call site. It is a pair guard: one end is the bundle, the
 * other end is the tree. A pair guard is only worth its green state while its
 * matcher stays honest, and this one had degraded — see the bare-namespace note
 * below.
 *
 * ## Recognised construction patterns
 *
 * - a literal t("a.b.c"), and a t("a.b") that returns a subtree;
 * - pluralKey("a.b", n) / tCount("a.b", n), which resolve to the three
 *   One / Few / Other tiers and nothing else;
 * - a **pair template** — a t(template) call carrying BOTH a literal prefix and
 *   a literal suffix, as in the per-provider OAuth status keys. Both ends must
 *   match, so the template covers settings.polarOauthConnected and nothing else
 *   under settings.;
 * - a **prefix template** — a literal prefix and no suffix, as in the cycle
 *   phase labels, covering the cycle.phase.* subtree;
 * - a **suffix template** — a leading interpolation and a literal tail, as in
 *   the per-metric insight page titles. The tail alone means nothing, so it is
 *   matched only against a base that some other arm has established;
 * - a declared i18n base — a dotted literal assigned to an `i18nPrefix` prop or
 *   variable. This is the convention the OAuth provider card, the cadence
 *   picker and the HealthKit metric page already follow. A declared base covers
 *   the exact key and serves as the base half of a suffix template; it does NOT
 *   open its subtree;
 * - a full string-literal node path, covering the subtree it names (map values
 *   handed to t());
 * - an explicit allowlist for keys resolved through a DB column.
 *
 * ## Why a bare namespace is refused rather than accepted
 *
 * Before v1.32.36, a prefix ending in a dot was recorded as a subtree base
 * regardless of depth. The per-provider OAuth template therefore registered the
 * base `settings` and marked every one of the several thousand keys under
 * settings.* as reachable, and a second instance did the same for
 * measurementReminders.*. The guard still passed, so the degradation was
 * invisible: a pair guard had quietly become a one-end guard.
 *
 * Accepting a bare namespace silently is a false pass. Refusing it silently
 * would only trade that for a false orphan report. So a suffix-less template
 * rooted at a bare top-level namespace is a **collector violation**: the guard
 * fails and names the template. The two honest remedies are to build a
 * fully-qualified key at the call site (as the measurement-reminder due helpers
 * do) or to give the template a literal suffix so it becomes a pair.
 */

/** A template whose prefix is a bare top-level namespace and which has no suffix. */
export interface BareNamespaceViolation {
  /** The offending literal, as it appears in the source. */
  literal: string;
  /** Which ingestion arm saw it first. */
  arm: "template" | "assignment" | "concat";
}

/** A template carrying both a literal prefix and a literal suffix. */
interface KeyPair {
  /** Raw leading literal, dot-terminated or not. */
  prefix: string;
  /** Raw trailing literal, leading dot preserved. */
  suffix: string;
}

export interface Reference {
  /** Literal t("…") keys plus the plural tiers. */
  literalKeys: Set<string>;
  /** Dotted bases (deep prefix template / a full string-literal node path): cover the subtree. */
  dottedBases: Set<string>;
  /** Dot-less concat prefixes: cover any leaf that string-starts with them. */
  concatPrefixes: Set<string>;
  /** Prefix+suffix templates: both ends must match. */
  pairs: KeyPair[];
  /** Trailing literals of a leading-interpolation template. */
  suffixes: Set<string>;
  /** Bases declared through an `i18nPrefix` literal. Exact match plus suffix base. */
  declaredPrefixes: Set<string>;
}

export interface CollectResult {
  ref: Reference;
  violations: BareNamespaceViolation[];
}

/** `settings` is bare; `settings.sections` is not. */
function isBareNamespace(base: string): boolean {
  return !base.includes(".");
}

/**
 * Split a template body into its leading and trailing literals: the admin
 * section title template yields the prefix "admin.section." and the suffix
 * ".title".
 */
function splitTemplate(content: string): {
  prefix: string | null;
  suffix: string | null;
} {
  const open = content.indexOf("${");
  if (open === -1) return { prefix: null, suffix: null };
  const rawPrefix = open > 0 ? content.slice(0, open) : "";
  const close = content.lastIndexOf("}");
  const rawSuffix =
    close !== -1 && close < content.length - 1 ? content.slice(close + 1) : "";
  return {
    // A prefix with no dot is not an i18n path root; ignore it.
    prefix: rawPrefix.includes(".") ? rawPrefix : null,
    suffix: rawSuffix || null,
  };
}

/**
 * Body of the template literal whose opening backtick sits at `start`.
 *
 * Scanning forward from a known opening backtick rather than pairing backticks
 * across the whole tree matters: the concatenated sources hold tens of
 * thousands of backticks, plenty of them inside comments and strings, so naive
 * pairing silently shifts and whole files fall out of the scan. That is how a
 * matcher stops seeing call sites without anyone noticing.
 */
function templateBodyAt(text: string, start: number): string | null {
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "$" && text[i + 1] === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}" && depth > 0) {
      depth--;
      continue;
    }
    if (c === "`" && depth === 0) return text.slice(start + 1, i);
  }
  return null;
}

export function collectReferences(
  allText: string,
  allNodes: Set<string>,
  topNamespaces: Set<string>,
): CollectResult {
  const literalKeys = new Set<string>();
  const dottedBases = new Set<string>();
  const concatPrefixes = new Set<string>();
  const suffixes = new Set<string>();
  const declaredPrefixes = new Set<string>();
  const pairs: KeyPair[] = [];
  const pairSeen = new Set<string>();
  const violations: BareNamespaceViolation[] = [];
  const violationSeen = new Set<string>();

  const addPair = (prefix: string, suffix: string) => {
    const id = [prefix, suffix].join(" ");
    if (pairSeen.has(id)) return;
    pairSeen.add(id);
    pairs.push({ prefix, suffix });
  };

  /**
   * The single door into `dottedBases` for every ingestion arm. A bare
   * top-level namespace never opens a subtree — it is reported instead.
   * Violations dedupe on the literal, not on the arm: one template is seen by
   * both the t() arm and the generic backtick arm, and it is one defect.
   */
  const addDottedBase = (
    base: string,
    arm: BareNamespaceViolation["arm"],
    literal: string,
  ) => {
    if (isBareNamespace(base)) {
      if (violationSeen.has(literal)) return;
      violationSeen.add(literal);
      violations.push({ literal, arm });
      return;
    }
    dottedBases.add(base);
  };

  const literalKeyRe =
    /(?<![a-zA-Z0-9_])t\(\s*["']([a-zA-Z][a-zA-Z0-9_.-]+)["']/g;
  for (const m of allText.matchAll(literalKeyRe)) literalKeys.add(m[1]);

  // Plural-tier composition: tCount("dashboard.staleHintWeeks", n) and the
  // underlying pluralKey("…", n, locale) both resolve to <base>One / <base>Few
  // / <base>Other at runtime, so the base literal accounts for exactly those
  // three leaves and no others. Kept as an explicit tier list rather than a
  // prefix match so a stray sibling key under the same base still reports as
  // an orphan.
  const pluralKeyRe =
    /(?:pluralKey|tCount)\(\s*["']([a-zA-Z][a-zA-Z0-9_.-]+)["']/g;
  for (const m of allText.matchAll(pluralKeyRe)) {
    for (const tier of ["One", "Few", "Other"])
      literalKeys.add(`${m[1]}${tier}`);
  }

  const ingestTemplate = (
    content: string,
    arm: BareNamespaceViolation["arm"],
  ) => {
    const { prefix, suffix } = splitTemplate(content);
    if (prefix && suffix) {
      addPair(prefix, suffix);
      return;
    }
    if (prefix) {
      if (prefix.endsWith("."))
        addDottedBase(prefix.slice(0, -1), arm, content);
      else concatPrefixes.add(prefix);
      return;
    }
    if (suffix) suffixes.add(suffix);
  };

  // Templates passed directly to t(…).
  const tStartRe = /(?<![a-zA-Z0-9_])t\(\s*`/g;
  for (const m of allText.matchAll(tStartRe)) {
    const body = templateBodyAt(allText, m.index + m[0].length - 1);
    if (body && body.includes("${")) ingestTemplate(body, "template");
  }

  // Key strings assembled outside the call and handed to t() (the
  // describeInjectionSite pattern). Recognised only when the template's
  // leading literal is rooted at a real top-level i18n namespace, so a cache
  // key / action name that interpolates can't mask a dead key.
  const templateStartRe = /`[a-zA-Z][a-zA-Z0-9_.-]*\$\{/g;
  for (const m of allText.matchAll(templateStartRe)) {
    const body = templateBodyAt(allText, m.index);
    if (!body) continue;
    const { prefix } = splitTemplate(body);
    if (!prefix) continue;
    if (!topNamespaces.has(prefix.split(".")[0])) continue;
    ingestTemplate(body, "assignment");
  }

  // String-concatenation prefixes: "notifications.event" + eventType builds
  // keys like notifications.eventMoodReminder. Recognised only when the
  // literal is rooted at a real top-level namespace. The concat arm sees no
  // suffix, so a dot-terminated namespace root here is the same hole shape the
  // template arm refuses.
  const plusConcatRe = /["']([a-zA-Z][a-zA-Z0-9_.]*)["']\s*\+/g;
  for (const m of allText.matchAll(plusConcatRe)) {
    const lit = m[1];
    if (!lit.includes(".")) continue;
    if (!topNamespaces.has(lit.split(".")[0])) continue;
    if (lit.endsWith(".")) addDottedBase(lit.slice(0, -1), "concat", lit);
    else concatPrefixes.add(lit);
  }

  // Declared i18n bases. The component that receives one builds keys by
  // appending a literal suffix, whose trailing literals live in `suffixes`;
  // the declaration supplies the base half. Deliberately NOT a subtree base —
  // only the exact key and the suffix pairing.
  const declaredPrefixRe = /i18nPrefix\s*[=:]\s*["']([a-zA-Z][\w.-]*)["']/g;
  for (const m of allText.matchAll(declaredPrefixRe)) {
    const lit = m[1];
    if (!lit.includes(".")) continue;
    if (!topNamespaces.has(lit.split(".")[0])) continue;
    declaredPrefixes.add(lit);
  }

  // Full string-literal node paths (covers map values returned to t()).
  const litPathRe = /["']([a-zA-Z][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)+)["']/g;
  for (const m of allText.matchAll(litPathRe)) {
    if (allNodes.has(m[1])) dottedBases.add(m[1]);
  }

  return {
    ref: {
      literalKeys,
      dottedBases,
      concatPrefixes,
      pairs,
      suffixes,
      declaredPrefixes,
    },
    violations,
  };
}

/** Bases a suffix template may attach to. */
function suffixBaseMatches(base: string, ref: Reference): boolean {
  for (const b of ref.dottedBases) {
    if (base === b || base.startsWith(`${b}.`) || b.startsWith(`${base}.`)) {
      return true;
    }
  }
  for (const ck of ref.literalKeys) {
    if (base === ck || base.startsWith(`${ck}.`) || ck.startsWith(`${base}.`)) {
      return true;
    }
  }
  for (const pre of ref.concatPrefixes) {
    if (base.startsWith(pre)) return true;
  }
  return ref.declaredPrefixes.has(base);
}

export function isReferenced(leaf: string, ref: Reference): boolean {
  if (ref.literalKeys.has(leaf)) return true;
  for (const ck of ref.literalKeys) {
    if (leaf.startsWith(`${ck}.`)) return true;
  }
  for (const base of ref.dottedBases) {
    if (leaf === base || leaf.startsWith(`${base}.`)) return true;
  }
  for (const pre of ref.concatPrefixes) {
    if (leaf.startsWith(pre)) return true;
  }
  if (ref.declaredPrefixes.has(leaf)) return true;
  for (const { prefix, suffix } of ref.pairs) {
    if (
      leaf.length > prefix.length + suffix.length &&
      leaf.startsWith(prefix) &&
      leaf.endsWith(suffix)
    ) {
      return true;
    }
  }
  for (const suffix of ref.suffixes) {
    if (!leaf.endsWith(suffix) || leaf.length === suffix.length) continue;
    const base = leaf.slice(0, leaf.length - suffix.length).replace(/\.$/, "");
    if (!base) continue;
    if (suffixBaseMatches(base, ref)) return true;
  }
  return false;
}
