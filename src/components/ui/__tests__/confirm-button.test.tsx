/**
 * `<ConfirmButton>` / `<ConfirmDialog>` — the dismissal contract.
 *
 * Every destructive control this repo guards routes through one of these two,
 * so the property "a dismissed dialog does not act" is worth proving ONCE,
 * here, rather than re-proving it per consumer. What makes that compositional
 * argument sound is that the callers really do route through the primitive,
 * which `src/__tests__/destructive-control-guard.test.ts` asserts separately
 * (T2: the claimed mechanism renders; T3: no destroying request fires from a
 * bare handler). Neither half means much alone.
 *
 * The proof is structural because it can be. Both components are hook-free,
 * so the test calls them as plain functions and walks the element tree they
 * return, which is stronger than asserting on markup: it shows WHERE the
 * caller's `onConfirm` is attached, not merely that some button exists.
 *
 *   - the trigger carries no `onClick` at all, so tapping it cannot act;
 *   - `onConfirm` is reachable from exactly one node, the dialog's action;
 *   - the cancel node never receives it;
 *   - and the action lives inside `AlertDialogContent`, which Radix mounts
 *     only while open — so dismissing unmounts the only path to the callback.
 *
 * WHAT IS NOT PROVEN HERE. The project runs SSR-only component tests
 * (`@testing-library/react` is not a dependency), so nothing below clicks
 * Cancel. An earlier draft of this file asserted that a closed dialog renders
 * no confirm control in the SSR markup; that passed with `open` hard-coded to
 * true, because Radix portals do not render server-side at all — it was
 * measuring the renderer, not the component, so it is gone rather than left
 * green. That the content mounts only while open is Radix's own contract, and
 * the rendered dialog is driven by Playwright (`e2e/share-documents.spec.ts`
 * exercises one by role). What IS proven here is the wiring: where the
 * caller's callback goes, and where it does not.
 */
import { describe, it, expect, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

// `ConfirmBody` is invoked as a plain function below so its element tree can
// be walked; that bypasses React's context machinery, so its one hook is
// stubbed. The provider-backed SSR assertions further down use the real one.
vi.mock("@/lib/i18n/context", () => ({
  useTranslations: () => ({ t: (k: string) => k }),
}));

const { ConfirmButton, ConfirmDialog } = await import("../confirm-button");

/** Display name of an element's type, for readable assertions. */
function nameOf(el: ReactElement): string {
  const t = el.type as unknown;
  if (typeof t === "string") return t;
  if (typeof t === "function") return (t as { name?: string }).name || "anon";
  const obj = t as { displayName?: string; name?: string };
  return obj?.displayName ?? obj?.name ?? "unknown";
}

/** Every element in the tree, paired with its resolved name. */
function walk(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, out);
    return out;
  }
  if (!isValidElement(node)) return out;
  out.push(node);
  const props = node.props as { children?: ReactNode };
  if (props?.children) walk(props.children, out);
  return out;
}

const COPY = {
  title: "Clear the note?",
  body: "The note goes; your allergies stay.",
  confirmLabel: "Clear note",
};

describe("<ConfirmButton> — the trigger cannot act on its own", () => {
  const onConfirm = vi.fn();
  const tree = walk(
    ConfirmButton({
      label: "Clear",
      slot: "demo-clear",
      onConfirm,
      ...COPY,
    }) as ReactElement,
  );

  function find(name: string) {
    return tree.filter((el) => nameOf(el) === name);
  }

  it("renders exactly one trigger and one dialog body", () => {
    expect(find("AlertDialogTrigger")).toHaveLength(1);
    expect(find("ConfirmBody")).toHaveLength(1);
  });

  it("the trigger's button has no click handler", () => {
    const [trigger] = find("AlertDialogTrigger");
    const [button] = walk(
      (trigger.props as { children?: ReactNode }).children,
    ).filter((el) => nameOf(el) === "Button");
    expect(button).toBeDefined();
    const props = button.props as Record<string, unknown>;
    expect(
      props.onClick,
      "a trigger that can act is a trigger that fires on a mis-tap",
    ).toBeUndefined();
    expect(props["data-slot"]).toBe("demo-clear");
  });

  it("passes onConfirm to the dialog body and nowhere else", () => {
    const carriers = tree.filter(
      (el) => (el.props as Record<string, unknown>).onConfirm === onConfirm,
    );
    expect(carriers.map(nameOf)).toEqual(["ConfirmBody"]);
  });

  it("never invokes the callback during render", () => {
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("ConfirmBody — the action is the only path to the callback", () => {
  const onConfirm = vi.fn();
  // `ConfirmBody` is internal; reach it through the public component's tree.
  const body = walk(
    ConfirmButton({
      label: "Clear",
      slot: "demo-clear",
      onConfirm,
      ...COPY,
    }) as ReactElement,
  ).find((el) => nameOf(el) === "ConfirmBody")!;

  const rendered = walk(
    (body.type as (p: unknown) => ReactElement)(body.props),
  );

  it("wires the callback to the action node only", () => {
    const carriers = rendered.filter(
      (el) => (el.props as Record<string, unknown>).onClick === onConfirm,
    );
    expect(carriers.map(nameOf)).toEqual(["AlertDialogAction"]);
  });

  it("leaves the cancel node without it", () => {
    const cancel = rendered.find((el) => nameOf(el) === "AlertDialogCancel")!;
    const props = cancel.props as Record<string, unknown>;
    expect(props.onClick).toBeUndefined();
    expect(props.onConfirm).toBeUndefined();
  });

  it("keeps the action inside the dialog content Radix only mounts when open", () => {
    const content = rendered.find((el) => nameOf(el) === "AlertDialogContent")!;
    const inside = walk((content.props as { children?: ReactNode }).children);
    expect(inside.map(nameOf)).toContain("AlertDialogAction");
  });

  it("labels the action with the caller's verb rather than a bare OK", () => {
    const action = rendered.find((el) => nameOf(el) === "AlertDialogAction")!;
    const children = (action.props as { children: unknown }).children;
    expect(JSON.stringify(children)).toContain(COPY.confirmLabel);
  });
});

describe("<ConfirmDialog> — the trigger-less half", () => {
  const onConfirm = vi.fn();
  const tree = walk(
    ConfirmDialog({
      open: false,
      onOpenChange: vi.fn(),
      onConfirm,
      slot: "demo-switch",
      ...COPY,
    }) as ReactElement,
  );

  it("renders no trigger, so only the caller's own control can open it", () => {
    expect(tree.map(nameOf)).not.toContain("AlertDialogTrigger");
  });

  it("hands the dialog its open state rather than owning it", () => {
    const root = tree.find((el) => nameOf(el) === "AlertDialog")!;
    expect((root.props as Record<string, unknown>).open).toBe(false);
  });

  it("passes onConfirm to the dialog body and nowhere else", () => {
    const carriers = tree.filter(
      (el) => (el.props as Record<string, unknown>).onConfirm === onConfirm,
    );
    expect(carriers.map(nameOf)).toEqual(["ConfirmBody"]);
  });
});
