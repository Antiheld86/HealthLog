/**
 * Per-envelope response/consumer guard for the failure visibility contracts
 * exposed by integration status, admin status, and the environment overview.
 *
 * This deliberately does not sweep every response field in the application.
 * Each producer declaration below is paired with the one web subtree that owns
 * its presentation, and every assertion uses an envelope-qualified access. A
 * generic name such as `state` or `failures` elsewhere cannot satisfy it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const STATUS_SCHEMA = join(ROOT, "src/lib/integrations/status.ts");
const JOB_FAILURE_SCHEMA = join(ROOT, "src/lib/jobs/job-failures.ts");
const INTEGRATION_ROUTE = join(
  ROOT,
  "src/app/api/integrations/status/route.ts",
);
const ADMIN_ROUTE = join(ROOT, "src/app/api/admin/status/route.ts");
const ENVIRONMENT_ROUTE = join(ROOT, "src/app/api/environment/route.ts");
const INTEGRATION_CONSUMER = join(
  ROOT,
  "src/components/settings/integrations/shared.tsx",
);
const ADMIN_CONSUMER = join(
  ROOT,
  "src/components/admin/system-status-section.tsx",
);
const ENVIRONMENT_CONSUMER = join(
  ROOT,
  "src/components/settings/environment-section.tsx",
);

function source(path: string): string {
  return readFileSync(path, "utf8");
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    source(path),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function expressionAccessPath(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const base = expressionAccessPath(expression.expression);
    return base === null ? null : `${base}.${expression.name.text}`;
  }
  if (ts.isElementAccessExpression(expression)) {
    const base = expressionAccessPath(expression.expression);
    const key = expression.argumentExpression;
    if (
      base !== null &&
      key &&
      (ts.isStringLiteral(key) || ts.isNumericLiteral(key))
    ) {
      return `${base}.${key.text}`;
    }
    return null;
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return expressionAccessPath(expression.expression);
  }
  return null;
}

function executableAccesses(path: string): Set<string> {
  const accesses = new Set<string>();
  const file = parse(path);
  function visit(node: ts.Node): void {
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const access = expressionAccessPath(node);
      if (access !== null) accesses.add(access);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return accesses;
}

function interfaceFields(path: string, interfaceName: string): string[] {
  const file = parse(path);
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === interfaceName,
  );
  expect(
    declaration,
    `${interfaceName} must remain an interface in ${path}`,
  ).toBeDefined();
  return declaration!.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || member.name === undefined) return [];
    return [member.name.getText(file).replace(/^['"]|['"]$/g, "")];
  });
}

function stringUnionMembers(path: string, typeName: string): string[] {
  const file = parse(path);
  const declaration = file.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  );
  expect(
    declaration,
    `${typeName} must remain a type alias in ${path}`,
  ).toBeDefined();
  expect(ts.isUnionTypeNode(declaration!.type)).toBe(true);
  return (declaration!.type as ts.UnionTypeNode).types.flatMap((member) =>
    ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)
      ? [member.literal.text]
      : [],
  );
}

function propertyName(
  name: ts.PropertyName,
  file: ts.SourceFile,
): string | null {
  if (ts.isComputedPropertyName(name)) return null;
  return name.getText(file).replace(/^['"]|['"]$/g, "");
}

function namedFunctionReturnFields(
  file: ts.SourceFile,
  functionName: string,
): string[] {
  let declaration: ts.FunctionDeclaration | undefined;
  function find(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      expect(
        declaration,
        `${functionName} must have one declaration`,
      ).toBeUndefined();
      declaration = node;
    }
    ts.forEachChild(node, find);
  }
  find(file);
  expect(
    declaration?.body,
    `${functionName} must remain a declared function with a body`,
  ).toBeDefined();

  const branches: string[][] = [];
  function collectReturns(node: ts.Node): void {
    if (ts.isReturnStatement(node)) {
      expect(
        node.expression && ts.isObjectLiteralExpression(node.expression),
        `${functionName} must return an object literal`,
      ).toBe(true);
      if (node.expression && ts.isObjectLiteralExpression(node.expression)) {
        branches.push(
          node.expression.properties.flatMap((property) => {
            expect(
              ts.isPropertyAssignment(property) ||
                ts.isShorthandPropertyAssignment(property),
              `${functionName} contains unsupported return syntax: ${property.getText(file)}`,
            ).toBe(true);
            if (
              !ts.isPropertyAssignment(property) &&
              !ts.isShorthandPropertyAssignment(property)
            ) {
              return [];
            }
            const name = propertyName(property.name, file);
            expect(
              name,
              `${functionName} has a computed response field`,
            ).not.toBeNull();
            return name === null ? [] : [name];
          }),
        );
      }
      return;
    }
    ts.forEachChild(node, collectReturns);
  }
  collectReturns(declaration!.body!);
  expect(
    branches.length,
    `${functionName} must return a payload`,
  ).toBeGreaterThan(0);
  for (const [index, branch] of branches.entries()) {
    expect(
      branch.sort(),
      `${functionName} return branch ${index + 1} must preserve one shape`,
    ).toEqual([...branches[0]].sort());
  }
  return branches[0];
}

function namedFunctionReturnLineage(
  file: ts.SourceFile,
  functionName: string,
): Record<string, string | null> {
  let declaration: ts.FunctionDeclaration | undefined;
  function find(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      expect(
        declaration,
        `${functionName} must have one declaration`,
      ).toBeUndefined();
      declaration = node;
    }
    ts.forEachChild(node, find);
  }
  find(file);
  expect(declaration?.body).toBeDefined();

  const branches: Array<Record<string, string | null>> = [];
  function collectReturns(node: ts.Node): void {
    if (ts.isReturnStatement(node)) {
      expect(
        node.expression && ts.isObjectLiteralExpression(node.expression),
        `${functionName} must return an object literal`,
      ).toBe(true);
      if (node.expression && ts.isObjectLiteralExpression(node.expression)) {
        const lineage: Record<string, string | null> = {};
        for (const property of node.expression.properties) {
          expect(
            ts.isPropertyAssignment(property) ||
              ts.isShorthandPropertyAssignment(property),
            `${functionName} contains unsupported return syntax: ${property.getText(file)}`,
          ).toBe(true);
          if (ts.isPropertyAssignment(property)) {
            const name = propertyName(property.name, file);
            expect(name).not.toBeNull();
            if (name !== null) {
              lineage[name] = expressionAccessPath(property.initializer);
            }
          } else if (ts.isShorthandPropertyAssignment(property)) {
            lineage[property.name.text] = property.name.text;
          }
        }
        branches.push(lineage);
      }
      return;
    }
    ts.forEachChild(node, collectReturns);
  }
  collectReturns(declaration!.body!);
  expect(branches.length).toBeGreaterThan(0);
  for (const [index, branch] of branches.entries()) {
    expect(
      branch,
      `${functionName} return branch ${index + 1} must preserve one lineage`,
    ).toEqual(branches[0]);
  }
  return branches[0];
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function integrationPublishFlow(path: string): {
  publishedFields: string[];
  publishedSnapshots: string[];
  entries: number;
} {
  const file = parse(path);
  const publishedFields = namedFunctionReturnFields(file, "publish");
  const publishedLineage = namedFunctionReturnLineage(file, "publish");
  expect(Object.keys(publishedLineage).sort()).toEqual(
    [...publishedFields].sort(),
  );
  for (const field of publishedFields) {
    expect(
      publishedLineage[field],
      `publish.${field} must come from snapshot.${field}`,
    ).toBe(`snapshot.${field}`);
  }
  const resolvedFields = namedFunctionReturnFields(file, "resolve");
  expect(
    publishedFields.filter((field) => resolvedFields.includes(field)),
    "resolve(...) must not override a field supplied by publish(...)",
  ).toEqual([]);

  let apiSuccessBranches = 0;
  let entries = 0;
  const publishedSnapshots: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "apiSuccess"
    ) {
      apiSuccessBranches += 1;
      const payload = node.arguments[0];
      expect(
        payload && ts.isObjectLiteralExpression(payload),
        "integration status apiSuccess payload must remain an object literal",
      ).toBe(true);
      if (!payload || !ts.isObjectLiteralExpression(payload)) return;

      const threshold = payload.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          propertyName(property.name, file) === "threshold",
      );
      expect(
        threshold && ts.isPropertyAssignment(threshold),
        "integration status must expose threshold",
      ).toBe(true);
      if (threshold && ts.isPropertyAssignment(threshold)) {
        expect(
          ts.isCallExpression(threshold.initializer) &&
            ts.isIdentifier(threshold.initializer.expression) &&
            threshold.initializer.expression.text ===
              "getPersistentFailureThreshold",
          "threshold must come from getPersistentFailureThreshold()",
        ).toBe(true);
      }

      const integrations = payload.properties.find(
        (property) =>
          ts.isPropertyAssignment(property) &&
          propertyName(property.name, file) === "integrations",
      );
      expect(
        integrations && ts.isPropertyAssignment(integrations),
        "integration status must expose integrations",
      ).toBe(true);
      if (!integrations || !ts.isPropertyAssignment(integrations)) return;
      expect(ts.isArrayLiteralExpression(integrations.initializer)).toBe(true);
      if (!ts.isArrayLiteralExpression(integrations.initializer)) return;

      for (const element of integrations.initializer.elements) {
        const entry = unwrapExpression(element);
        expect(
          ts.isObjectLiteralExpression(entry),
          "every integration response entry must remain an object literal",
        ).toBe(true);
        if (!ts.isObjectLiteralExpression(entry)) continue;
        entries += 1;
        let publishSpreads = 0;
        let publishSeen = false;
        for (const property of entry.properties) {
          if (ts.isSpreadAssignment(property)) {
            expect(
              ts.isCallExpression(property.expression) &&
                ts.isIdentifier(property.expression.expression),
              `integration entry has unsupported spread: ${property.getText(file)}`,
            ).toBe(true);
            if (
              !ts.isCallExpression(property.expression) ||
              !ts.isIdentifier(property.expression.expression)
            ) {
              continue;
            }
            const spreadName = property.expression.expression.text;
            expect(
              spreadName === "publish" || spreadName === "resolve",
              `integration entry has unknown spread ${spreadName}(...)`,
            ).toBe(true);
            if (spreadName === "publish") {
              publishSpreads += 1;
              publishSeen = true;
              expect(
                property.expression.arguments.length === 1 &&
                  ts.isIdentifier(property.expression.arguments[0]),
                "publish(...) must receive one provider snapshot variable",
              ).toBe(true);
              if (
                property.expression.arguments.length === 1 &&
                ts.isIdentifier(property.expression.arguments[0])
              ) {
                publishedSnapshots.push(property.expression.arguments[0].text);
              }
            }
            continue;
          }
          expect(
            ts.isPropertyAssignment(property) ||
              ts.isShorthandPropertyAssignment(property),
            `integration entry has unsupported property syntax: ${property.getText(file)}`,
          ).toBe(true);
          if (
            ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)
          ) {
            const name = propertyName(property.name, file);
            expect(
              name,
              "integration entry has a computed field",
            ).not.toBeNull();
            if (publishSeen && name !== null) {
              expect(
                publishedFields,
                `${name} overrides publish(...) later in the same entry`,
              ).not.toContain(name);
            }
          }
        }
        expect(
          publishSpreads,
          "every integration response entry must spread publish(...) exactly once",
        ).toBe(1);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(apiSuccessBranches).toBeGreaterThan(0);
  expect(entries).toBeGreaterThan(0);
  return { publishedFields, publishedSnapshots, entries };
}

function assertBucketConsumerLineage(
  path: string,
  kinds: readonly string[],
): void {
  const file = parse(path);
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "pillFailurePropsFor",
  );
  expect(declaration?.body).toBeDefined();
  let bucketInitializer: string | null = null;
  const accesses = new Set<string>();
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "buckets" &&
      node.initializer
    ) {
      expect(bucketInitializer).toBeNull();
      bucketInitializer = expressionAccessPath(node.initializer);
    }
    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const access = expressionAccessPath(node);
      if (access !== null) accesses.add(access);
    }
    ts.forEachChild(node, visit);
  }
  visit(declaration!.body!);
  expect(
    bucketInitializer,
    "buckets must be read from the integration status response",
  ).toBe("status.consecutiveFailuresByKind");
  for (const kind of kinds) {
    expect(
      accesses,
      `pillFailurePropsFor must read buckets.${kind} from that response value`,
    ).toContain(`buckets.${kind}`);
  }
}

interface ConsumerBinding {
  file: string;
  accesses: readonly string[];
}

function assertBindings(
  leaves: readonly string[],
  bindings: Readonly<Record<string, ConsumerBinding>>,
): void {
  expect(
    Object.keys(bindings).sort(),
    "consumer bindings must exactly match the producer leaves",
  ).toEqual([...leaves].sort());

  const accessesByFile = new Map<string, Set<string>>();
  for (const leaf of leaves) {
    const binding = bindings[leaf];
    expect(binding, `${leaf} has no envelope-owned web consumer`).toBeDefined();
    const accesses =
      accessesByFile.get(binding.file) ?? executableAccesses(binding.file);
    accessesByFile.set(binding.file, accesses);
    for (const access of binding.accesses) {
      expect(
        accesses.has(access),
        `${leaf} no longer reads ${access} in ${binding.file}`,
      ).toBe(true);
    }
  }
}

function assertJsxHandoff(
  path: string,
  componentName: string,
  propName: string,
  access: string,
): void {
  const file = parse(path);
  const handoffs: Array<string | null> = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      ts.isIdentifier(node.tagName) &&
      node.tagName.text === componentName
    ) {
      const attribute = node.attributes.properties.find(
        (property) =>
          ts.isJsxAttribute(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === propName,
      );
      expect(
        attribute && ts.isJsxAttribute(attribute),
        `${componentName} must receive ${propName}`,
      ).toBe(true);
      if (
        attribute &&
        ts.isJsxAttribute(attribute) &&
        attribute.initializer &&
        ts.isJsxExpression(attribute.initializer) &&
        attribute.initializer.expression
      ) {
        handoffs.push(expressionAccessPath(attribute.initializer.expression));
      } else {
        handoffs.push(null);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(
    handoffs,
    `${componentName}.${propName} must receive ${access} exactly once`,
  ).toEqual([access]);
}

describe("integration and background-failure response consumer guard", () => {
  function assertEnvironmentFailureLineage(path: string): void {
    const file = parse(path);
    const bindings: Array<{
      declaration: ts.VariableDeclaration;
      index: number;
    }> = [];
    function findBinding(node: ts.Node): void {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isArrayBindingPattern(node.name)
      ) {
        const index = node.name.elements.findIndex(
          (element) =>
            ts.isBindingElement(element) &&
            ts.isIdentifier(element.name) &&
            element.name.text === "lastFetchFailure",
        );
        if (index >= 0) bindings.push({ declaration: node, index });
      }
      ts.forEachChild(node, findBinding);
    }
    findBinding(file);
    expect(
      bindings,
      "lastFetchFailure must have one Promise.all binding",
    ).toHaveLength(1);
    const { declaration, index } = bindings[0];
    let initializer = declaration.initializer;
    if (initializer && ts.isAwaitExpression(initializer)) {
      initializer = initializer.expression;
    }
    expect(
      initializer &&
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        ts.isIdentifier(initializer.expression.expression) &&
        initializer.expression.expression.text === "Promise" &&
        initializer.expression.name.text === "all" &&
        initializer.arguments.length === 1 &&
        ts.isArrayLiteralExpression(initializer.arguments[0]),
      "lastFetchFailure must be bound from Promise.all([...])",
    ).toBe(true);
    if (
      !initializer ||
      !ts.isCallExpression(initializer) ||
      initializer.arguments.length !== 1 ||
      !ts.isArrayLiteralExpression(initializer.arguments[0])
    ) {
      return;
    }
    const sourceExpression = initializer.arguments[0].elements[index];
    expect(
      sourceExpression &&
        ts.isCallExpression(sourceExpression) &&
        ts.isIdentifier(sourceExpression.expression) &&
        sourceExpression.expression.text === "readQueueFailureForUser" &&
        sourceExpression.arguments.length === 2 &&
        expressionAccessPath(sourceExpression.arguments[0]) ===
          "ENVIRONMENT_FETCH_QUEUE" &&
        expressionAccessPath(sourceExpression.arguments[1]) === "user.id",
      "lastFetchFailure must come from the user's environment fetch queue",
    ).toBe(true);

    const responseSources: Array<string | null> = [];
    function findResponse(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "apiSuccess" &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const property of node.arguments[0].properties) {
          if (
            ts.isShorthandPropertyAssignment(property) &&
            property.name.text === "lastFetchFailure"
          ) {
            responseSources.push(property.name.text);
          } else if (
            ts.isPropertyAssignment(property) &&
            propertyName(property.name, file) === "lastFetchFailure"
          ) {
            responseSources.push(expressionAccessPath(property.initializer));
          }
        }
      }
      ts.forEachChild(node, findResponse);
    }
    findResponse(file);
    expect(
      responseSources,
      "environment response must hand off lastFetchFailure exactly once",
    ).toEqual(["lastFetchFailure"]);
  }
  it("pairs every integration failure-count leaf with the shared card adapter", () => {
    const kinds = stringUnionMembers(STATUS_SCHEMA, "FailureKind");
    expect(kinds).toEqual(["transient", "reauth_required", "persistent"]);

    const flow = integrationPublishFlow(INTEGRATION_ROUTE);
    const expectedPublishFields = interfaceFields(
      STATUS_SCHEMA,
      "IntegrationStatusSnapshot",
    ).filter((field) => field !== "failingSince");
    expect(flow.publishedFields.sort()).toEqual(expectedPublishFields.sort());
    expect(flow.publishedFields).toContain("consecutiveFailuresByKind");
    expect(flow.entries).toBe(
      stringUnionMembers(STATUS_SCHEMA, "IntegrationKey").length,
    );
    const expectedSnapshots = stringUnionMembers(
      STATUS_SCHEMA,
      "IntegrationKey",
    ).map((key) => {
      const camelKey = key.replace(/-([a-z])/g, (_, letter: string) =>
        letter.toUpperCase(),
      );
      return `${camelKey}Status`;
    });
    expect(
      flow.publishedSnapshots.sort(),
      "every provider snapshot must be published exactly once",
    ).toEqual(expectedSnapshots.sort());
    assertBucketConsumerLineage(INTEGRATION_CONSUMER, kinds);

    const leaves = [
      "threshold",
      ...kinds.map((kind) => `consecutiveFailuresByKind.${kind}`),
    ];
    assertBindings(leaves, {
      threshold: {
        file: INTEGRATION_CONSUMER,
        accesses: ["envelope.threshold"],
      },
      "consecutiveFailuresByKind.transient": {
        file: INTEGRATION_CONSUMER,
        accesses: ["buckets.transient"],
      },
      "consecutiveFailuresByKind.reauth_required": {
        file: INTEGRATION_CONSUMER,
        accesses: ["buckets.reauth_required"],
      },
      "consecutiveFailuresByKind.persistent": {
        file: INTEGRATION_CONSUMER,
        accesses: ["buckets.persistent"],
      },
    });
  });

  it("pairs every admin failing-jobs leaf with the failing-jobs card", () => {
    const queueFields = interfaceFields(JOB_FAILURE_SCHEMA, "FailingQueue");
    const route = source(ADMIN_ROUTE);
    expect(route).toMatch(/failingJobs:\s*\n?\s*failingJobs === null/);
    expect(route).toMatch(
      /\{\s*windowHours:\s*JOB_FAILURE_WINDOW_HOURS,\s*queues:\s*failingJobs\s*\}/,
    );
    assertJsxHandoff(
      join(ROOT, "src/components/admin/system-status-section.tsx"),
      "FailingJobsCard",
      "failingJobs",
      "status.failingJobs",
    );

    const leaves = [
      "failingJobs.windowHours",
      ...queueFields.map((field) => `failingJobs.queues.${field}`),
    ];
    assertBindings(leaves, {
      "failingJobs.windowHours": {
        file: ADMIN_CONSUMER,
        accesses: ["failingJobs.windowHours"],
      },
      "failingJobs.queues.queue": {
        file: ADMIN_CONSUMER,
        accesses: ["failingJobs.queues", "queue.queue"],
      },
      "failingJobs.queues.failures": {
        file: ADMIN_CONSUMER,
        accesses: ["failingJobs.queues", "queue.failures"],
      },
      "failingJobs.queues.lastFailedAt": {
        file: ADMIN_CONSUMER,
        accesses: ["failingJobs.queues", "queue.lastFailedAt"],
      },
      "failingJobs.queues.lastError": {
        file: ADMIN_CONSUMER,
        accesses: ["failingJobs.queues", "queue.lastError"],
      },
    });
  });

  it("pairs every account-scoped queue-failure leaf with environment settings", () => {
    const failureFields = interfaceFields(
      JOB_FAILURE_SCHEMA,
      "QueueFailureForUser",
    );
    assertEnvironmentFailureLineage(ENVIRONMENT_ROUTE);

    const leaves = failureFields.map((field) => `lastFetchFailure.${field}`);
    assertBindings(leaves, {
      "lastFetchFailure.lastFailedAt": {
        file: ENVIRONMENT_CONSUMER,
        accesses: ["data.lastFetchFailure.lastFailedAt"],
      },
      "lastFetchFailure.failures": {
        file: ENVIRONMENT_CONSUMER,
        accesses: ["data.lastFetchFailure.failures"],
      },
    });
  });
});
