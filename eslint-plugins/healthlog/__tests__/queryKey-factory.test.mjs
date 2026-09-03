import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import plugin from "../queryKey-factory.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const rule = plugin.rules["queryKey-factory"];

ruleTester.run("queryKey-factory", rule, {
  valid: [
    {
      code: "useQuery({ queryKey: queryKeys.example(id) });",
      filename: "/repo/src/components/example.tsx",
    },
    {
      code: "const key = queryKeys.example(id); useQuery({ queryKey: key });",
      filename: "/repo/src/hooks/use-example.ts",
    },
    {
      code: 'export const example = () => ["example"];',
      filename: "/repo/src/lib/query-keys/example.ts",
    },
    {
      code: 'useQuery({ queryKey: ["fixture"] });',
      filename: "/repo/src/components/__tests__/example.test.tsx",
    },
    // A server module outside every guarded root stays unguarded — the roots
    // are the scope decision, not an accident of this fixture.
    {
      code: 'useQuery({ queryKey: ["server-only-lib"] });',
      filename: "/repo/src/lib/reports/build-report.ts",
    },
    // The positional cache API, used correctly: the key still comes from the
    // factory, so the shape that poisons the cache never arises.
    {
      code: "queryClient.setQueryData(queryKeys.example(id), next);",
      filename: "/repo/src/app/page.tsx",
    },
    {
      code: "const key = queryKeys.example(id); queryClient.setQueryData(key, next);",
      filename: "/repo/src/components/example.tsx",
    },
    // Tests seed caches with literal tuples on purpose; the factory directory
    // constructs them by definition. Both stay exempt on the positional form
    // exactly as they are on the object-property form.
    {
      code: 'client.setQueryData(["fixture"], 1);',
      filename: "/repo/src/hooks/__tests__/use-example.test.ts",
    },
    {
      code: 'client.setQueryData(["fixture"], 1);',
      filename: "/repo/src/lib/query-keys/__fixtures__/seed.ts",
    },
  ],
  invalid: [
    {
      code: 'useQuery({ queryKey: ["unguarded-component"] });',
      filename: "/repo/src/components/custom-metrics/example.tsx",
      errors: [{ messageId: "bareArray" }],
    },
    {
      code: 'useMutation({ mutationKey: ["unguarded-hook"] });',
      filename: "/repo/src/hooks/use-example.ts",
      errors: [{ messageId: "bareArray" }],
    },
    {
      code: '"use client"; useQuery({ queryKey: ["client-app"] });',
      filename: "/repo/src/app/previously-unguarded/page.tsx",
      errors: [{ messageId: "bareArray" }],
    },
    {
      code: '"use client"; useQuery({ queryKey: ["client-lib"] });',
      filename: "/repo/src/lib/client-state.tsx",
      errors: [{ messageId: "bareArray" }],
    },
    // src/app is where the server prefetch pages build the keys the client
    // then reads. A key that differs from the client's is a cache miss at
    // best and a poisoned cell at worst, and without `"use client"` on the
    // page the rule used to skip the file entirely.
    {
      code: 'useQuery({ queryKey: ["server-prefetch"] });',
      filename: "/repo/src/app/server-page.tsx",
      errors: [{ messageId: "bareArray" }],
    },
    {
      code: 'queryClient.prefetchQuery({ queryKey: ["dashboard"], queryFn: load });',
      filename: "/repo/src/app/coach/page.tsx",
      errors: [{ messageId: "bareArray" }],
    },
    // The positional form of the same mistake. `setQueryData` seeds a cache
    // cell by key exactly as `queryKey:` reads one, so a bare array here is
    // the same defect written differently.
    {
      code: 'queryClient.setQueryData(["bare", "positional"], 1);',
      filename: "/repo/src/app/coach/page.tsx",
      errors: [{ messageId: "positionalArray" }],
    },
    {
      code: 'const cached = queryClient.getQueryData(["bare"]);',
      filename: "/repo/src/hooks/use-example.ts",
      errors: [{ messageId: "positionalArray" }],
    },
    {
      code: 'queryClient.getQueryState(["bare"]);',
      filename: "/repo/src/components/example.tsx",
      errors: [{ messageId: "positionalArray" }],
    },
    {
      code: 'queryClient.setQueryDefaults(["bare"], { staleTime: 0 });',
      filename: "/repo/src/lib/queries/use-example.ts",
      errors: [{ messageId: "positionalArray" }],
    },
    {
      code: 'queryClient.setMutationDefaults(["bare"], { retry: 0 });',
      filename: "/repo/src/components/example.tsx",
      errors: [{ messageId: "positionalArray" }],
    },
    // Destructured off the client, and reached through a computed member —
    // both spell the same call and both must be seen.
    {
      code: 'const { setQueryData } = useQueryClient(); setQueryData(["bare"], 1);',
      filename: "/repo/src/components/example.tsx",
      errors: [{ messageId: "positionalArray" }],
    },
    {
      code: 'queryClient["setQueryData"](["bare"], 1);',
      filename: "/repo/src/components/example.tsx",
      errors: [{ messageId: "positionalArray" }],
    },
    // Both holes in one file, which is the probe that found them.
    {
      code: 'queryClient.setQueryData(["bare", "positional"], 1); useQuery({ queryKey: ["bare", "object-property"] });',
      filename: "/repo/src/app/coach/page.tsx",
      errors: [{ messageId: "positionalArray" }, { messageId: "bareArray" }],
    },
  ],
});
