/**
 * The detector behind the cycle-verdict single-decider guard.
 *
 * The cycle ring's day count, its phase arcs and the judgement that a period is
 * late are resolved once, on the server, and published on
 * `GET /api/cycle/calendar`. A second copy of that reasoning in client code is
 * not a duplicate detail; it is a second answer about a person's body, and the
 * last time it existed it froze someone's ring on a day their record did not
 * hold.
 *
 * A text search would not hold this line. The grace window can be renamed,
 * inlined as a bare `14`, or lifted into a variable one statement above the
 * comparison — a defeat this repo has already watched happen to a different
 * guard. So this reads the syntax tree and looks for three things:
 *
 *   1. a numeric constant named like a grace / overdue window;
 *   2. a binding named like an overdue verdict whose value is COMPUTED from a
 *      comparison rather than read from the published `state`;
 *   3. the threshold shape itself — a cycle-day count compared against a sum —
 *      whatever the pieces happen to be called.
 *
 * Rule 3 is what survives the rename: the constant can go anywhere, but the
 * comparison has to exist somewhere for the client to reach a verdict, and it
 * has the same shape wherever it hides.
 */
import ts from "typescript";

export type FindingKind =
  "grace-constant" | "client-derived-verdict" | "day-count-threshold";

export interface Finding {
  kind: FindingKind;
  /** The binding or expression text that tripped the rule. */
  where: string;
  file: string;
  line: number;
}

/** Names that read as a grace / overdue window. */
const GRACE_NAME = /grace|overdue/i;
/** Names that read as "is the period late?". */
const VERDICT_NAME = /overdue|periodlate|islate|isoverdue/i;
/** Names that read as a cycle-day count. */
const DAY_COUNT_NAME = /day.?of.?cycle|cycleday|cyclerun|runlength/i;

/**
 * Markers that put a file in cycle territory. "Overdue" is a word other parts
 * of the product use honestly — a medication dose is overdue, a screening is
 * overdue — so the rules below only apply where the cycle's own vocabulary is
 * present. A file cannot re-derive the cycle verdict without touching the
 * calendar's types, its phase names, or the verdict's own fields, so nothing
 * that could actually commit the defect escapes by renaming one identifier.
 */
const CYCLE_MARKERS = new Set([
  "CalendarDay",
  "CalendarResponse",
  "CyclePhase",
  "CycleVerdict",
  "CycleVerdictState",
  "useCycleCalendar",
  "dayOfCycle",
  "cycleLength",
  "cycleStartDate",
  "typicalCycleLength",
  "lutealPhaseLength",
  "periodOverdue",
  "MENSTRUAL",
  "FOLLICULAR",
  "OVULATORY",
  "LUTEAL",
]);

/** The published states. A comparison against one of these is a READ. */
const PUBLISHED_STATES = new Set(["IN_CYCLE", "OVERDUE", "INSUFFICIENT_DATA"]);

const COMPARISON_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);

const ARITHMETIC_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
]);

export function parse(fileName: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Strip parentheses, `as`, `satisfies`, `!` so the shape underneath shows. */
function unwrap(node: ts.Expression): ts.Expression {
  let cur = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
}

/** A plain number literal, with or without a leading minus. */
function isNumericConstant(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  const inner = unwrap(node);
  if (ts.isNumericLiteral(inner)) return true;
  return (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(inner.operand)
  );
}

/** Every identifier-ish name appearing anywhere under `node`. */
function namesUnder(node: ts.Node): string[] {
  const out: string[] = [];
  function visit(n: ts.Node): void {
    if (ts.isIdentifier(n)) out.push(n.text);
    ts.forEachChild(n, visit);
  }
  visit(node);
  return out;
}

/** Whether the expression compares against the PUBLISHED verdict state. */
function readsPublishedState(node: ts.Node): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isStringLiteral(n) && PUBLISHED_STATES.has(n.text)) {
      found = true;
      return;
    }
    if (
      (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) &&
      ts.isPropertyAccessExpression(n) &&
      n.name.text === "state"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/** Whether a comparison lives anywhere under `node`. */
function containsComparison(node: ts.Node): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      COMPARISON_OPERATORS.has(n.operatorToken.kind)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/** The name of a declaration, when it has a plain one. */
function declaredName(
  name: ts.Node | undefined,
  file: ts.SourceFile,
): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return null;
  if (ts.isPrivateIdentifier(name)) return name.text;
  return name.getText(file);
}

/** Every `const NAME = <expr>` in the file, so one line up is not a hiding place. */
function localBindings(file: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return bindings;
}

/**
 * Whether the expression is a sum, following local `const` bindings.
 *
 * `dayOfCycle > typical + grace` and
 * `const ceiling = typical + grace; dayOfCycle > ceiling` are the same
 * derivation written two ways, and lifting the sum into a variable one line
 * above the comparison is precisely how a structural guard was talked around
 * here before. Two hops is enough for any readable version of the move.
 */
function isSumLike(
  node: ts.Expression,
  bindings: Map<string, ts.Expression>,
  seen: Set<string> = new Set(),
  depth = 0,
): boolean {
  const inner = unwrap(node);
  if (
    ts.isBinaryExpression(inner) &&
    ARITHMETIC_OPERATORS.has(inner.operatorToken.kind)
  ) {
    return true;
  }
  if (depth >= 3) return false;
  if (ts.isIdentifier(inner) && !seen.has(inner.text)) {
    const bound = bindings.get(inner.text);
    if (bound) {
      return isSumLike(
        bound,
        bindings,
        new Set(seen).add(inner.text),
        depth + 1,
      );
    }
  }
  return false;
}

/** Whether the file speaks the cycle's vocabulary at all. */
export function isCycleContext(file: ts.SourceFile): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(n) && CYCLE_MARKERS.has(n.text)) {
      found = true;
      return;
    }
    if (ts.isStringLiteral(n) && CYCLE_MARKERS.has(n.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  }
  visit(file);
  return found;
}

/**
 * Every way the cycle verdict could be decided again in the file.
 * An empty array is the only acceptable result for client code.
 */
export function derivationFindings(file: ts.SourceFile): Finding[] {
  const out: Finding[] = [];
  if (!isCycleContext(file)) return out;
  const bindings = localBindings(file);

  function record(kind: FindingKind, node: ts.Node, where: string): void {
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    out.push({ kind, where, file: file.fileName, line: line + 1 });
  }

  function checkBinding(
    node: ts.Node,
    nameNode: ts.Node | undefined,
    initializer: ts.Expression | undefined,
  ): void {
    const name = declaredName(nameNode, file);
    if (name === null || initializer === undefined) return;

    // 1. A grace / overdue window pinned to a number.
    if (GRACE_NAME.test(name) && isNumericConstant(initializer)) {
      record("grace-constant", node, name);
      return;
    }

    // 2. An overdue verdict COMPUTED here. Reading the published `state` is
    //    exactly what the client is supposed to do, so that shape is allowed.
    if (
      VERDICT_NAME.test(name) &&
      containsComparison(initializer) &&
      !readsPublishedState(initializer)
    ) {
      record("client-derived-verdict", node, name);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      checkBinding(node, node.name, node.initializer);
    } else if (ts.isPropertyAssignment(node)) {
      checkBinding(node, node.name, node.initializer);
    } else if (ts.isPropertyDeclaration(node)) {
      checkBinding(node, node.name, node.initializer);
    } else if (ts.isParameter(node)) {
      checkBinding(node, node.name, node.initializer);
    } else if (ts.isEnumMember(node)) {
      checkBinding(node, node.name, node.initializer);
    }

    // 3. The threshold shape: a cycle-day count compared against a sum. The
    //    constant can be renamed, inlined, or lifted into a variable one line
    //    up; this comparison still has to exist for a client to decide.
    if (
      ts.isBinaryExpression(node) &&
      COMPARISON_OPERATORS.has(node.operatorToken.kind)
    ) {
      const hasSum = [node.left, node.right].some((side) =>
        isSumLike(side, bindings),
      );
      const mentionsDayCount = namesUnder(node).some((n) =>
        DAY_COUNT_NAME.test(n),
      );
      if (hasSum && mentionsDayCount) {
        record("day-count-threshold", node, node.getText(file).slice(0, 120));
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(file);
  return out;
}

/** Every property-access path in the file, e.g. `calendar.data.verdict`. */
export function accessPaths(file: ts.SourceFile): Set<string> {
  const paths = new Set<string>();
  function pathOf(expression: ts.Expression): string | null {
    const inner = unwrap(expression);
    if (ts.isIdentifier(inner)) return inner.text;
    if (ts.isPropertyAccessExpression(inner)) {
      const base = pathOf(inner.expression);
      return base === null ? null : `${base}.${inner.name.text}`;
    }
    return null;
  }
  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node)) {
      const p = pathOf(node);
      if (p !== null) paths.add(p);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return paths;
}
