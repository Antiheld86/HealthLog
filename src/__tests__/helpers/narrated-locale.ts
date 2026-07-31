/**
 * Detector for the "a narrated sentence's locale stays required" guard.
 *
 * Lives beside the guard rather than inside it so the guard's own
 * counter-tests can run this exact code against disguised sources without
 * re-running the guard itself. See `narrated-locale-required-guard.test.ts`
 * for why the rule exists and `narrated-locale-guard-defeat.test.ts` for the
 * disguises it has to see through.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ts from "typescript";

const REPO_ROOT = resolve(__dirname, "../../..");

/**
 * The chain. Each entry is a declaration whose output is, or becomes, prose a
 * person reads. Add to it when a new one joins the chain; never remove one
 * because the check became inconvenient.
 */
export const CHAIN: ReadonlyArray<{ file: string; declaration: string }> = [
  {
    file: "src/lib/insights/correlation-discovery.ts",
    declaration: "discoverCorrelations",
  },
  {
    file: "src/lib/insights/correlation-discovery.ts",
    declaration: "discoverEmergingCorrelations",
  },
  {
    file: "src/lib/insights/correlation-discovery.ts",
    declaration: "discoverLabOutcomeCorrelations",
  },
  {
    file: "src/lib/ai/coach/tools/correlations-read.ts",
    declaration: "readCoachCorrelations",
  },
  {
    file: "src/lib/insights/derived/coach-read.ts",
    declaration: "buildCoachReadStrip",
  },
  {
    file: "src/lib/insights/metric-correlation-context.ts",
    declaration: "getRelevantCorrelationsForMetric",
  },
  {
    file: "src/lib/cycle/phase-crosstab.ts",
    declaration: "discoverPhaseCorrelations",
  },
  {
    file: "src/lib/insights/narrative/period-narrative.ts",
    declaration: "buildPeriodNarrativeContext",
  },
  {
    file: "src/lib/insights/narrative/period-narrative.ts",
    declaration: "assemblePeriodNarrativeContext",
  },
  {
    file: "src/lib/ai/coach/correlations-snapshot.ts",
    declaration: "buildCorrelationsSnapshotBlock",
  },
];

export const WHY_NO_DEFAULT =
  "A locale on this chain must be REQUIRED, with no `?` and no default. " +
  "These functions return finished sentences that a page prints verbatim. " +
  "An optional locale lets a caller say nothing and still get a sentence — " +
  "which is exactly how the metric page's Coach-read strip came to answer a " +
  "German page in English, under a German first line, for months. A default " +
  "cannot fail loudly; a missing argument can. Pass the reader's locale " +
  "instead of restoring the fallback.";

export interface LocaleSite {
  /** Where it sits, for the failure message. */
  where: string;
  optional: boolean;
  hasInitializer: boolean;
}

/** The local name `Locale` is bound to in this file (it may be aliased). */
function localeTypeName(source: ts.SourceFile): string {
  let name = "Locale";
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "Locale") {
        name = element.name.text;
      }
    }
  }
  return name;
}

/** Does this type node denote the locale type (possibly a union with it)? */
function isLocaleType(node: ts.TypeNode | undefined, alias: string): boolean {
  if (!node) return false;
  if (ts.isTypeReferenceNode(node)) return node.typeName.getText() === alias;
  if (ts.isUnionTypeNode(node))
    return node.types.some((t) => isLocaleType(t, alias));
  return false;
}

/** Find a top-level function/interface declaration by name. */
function findDeclaration(
  source: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | ts.InterfaceDeclaration | undefined {
  for (const statement of source.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return statement;
    }
  }
  return undefined;
}

/**
 * Every place a locale is accepted by `declaration` — as a parameter in its own
 * right, as a member of an inline options object, or as a member of a
 * same-file interface used as a parameter type. Keyed on the TYPE, so renaming
 * the parameter changes nothing.
 */
export function localeSites(
  source: ts.SourceFile,
  declarationName: string,
): LocaleSite[] {
  const alias = localeTypeName(source);
  const declaration = findDeclaration(source, declarationName);
  if (!declaration) {
    throw new Error(
      `${WHY_NO_DEFAULT}\n\nGuard could not find \`${declarationName}\` in ` +
        `${source.fileName}. If it was renamed or moved, update the chain ` +
        `list — do not delete the entry.`,
    );
  }

  const sites: LocaleSite[] = [];

  const collectFromMembers = (
    members: ts.NodeArray<ts.TypeElement>,
    owner: string,
    ownerOptional: boolean,
    ownerHasInitializer: boolean,
  ) => {
    for (const member of members) {
      if (!ts.isPropertySignature(member)) continue;
      if (!isLocaleType(member.type, alias)) continue;
      sites.push({
        where: `${owner}.${member.name.getText()}`,
        // The property itself may be required while the object it lives on is
        // optional or defaulted — which puts the silence right back.
        optional: member.questionToken !== undefined || ownerOptional,
        hasInitializer: ownerHasInitializer,
      });
    }
  };

  const visitParameters = (
    parameters: ts.NodeArray<ts.ParameterDeclaration>,
  ) => {
    for (const parameter of parameters) {
      const owner = parameter.name.getText();
      const optional = parameter.questionToken !== undefined;
      const hasInitializer = parameter.initializer !== undefined;
      if (isLocaleType(parameter.type, alias)) {
        sites.push({ where: owner, optional, hasInitializer });
        continue;
      }
      const type = parameter.type;
      if (type && ts.isTypeLiteralNode(type)) {
        collectFromMembers(type.members, owner, optional, hasInitializer);
      } else if (type && ts.isTypeReferenceNode(type)) {
        const referenced = findDeclaration(source, type.typeName.getText());
        if (referenced && ts.isInterfaceDeclaration(referenced)) {
          collectFromMembers(
            referenced.members,
            type.typeName.getText(),
            optional,
            hasInitializer,
          );
        }
      }
    }
  };

  if (ts.isInterfaceDeclaration(declaration)) {
    collectFromMembers(
      declaration.members,
      declaration.name.text,
      false,
      false,
    );
  } else {
    visitParameters(declaration.parameters);
  }

  return sites;
}

/**
 * Every `??` / `||` in the file whose left side reads a locale. This is the
 * "move the default into a variable" escape: `opts.locale ?? fallback` is the
 * same bug as `opts.locale ?? defaultLocale`, and neither is allowed here.
 */
export function localeFallbacks(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken
      ) {
        const left = node.left.getText();
        if (/locale/i.test(left)) found.push(node.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

export function parse(file: string, text?: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    text ?? readFileSync(resolve(REPO_ROOT, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}
