import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Destructive controls ask first.
 *
 * Signing every other device out, and revoking a trusted device, used to fire
 * on a single tap. Neither is undoable — the other devices simply have to log
 * in again, and a revoked trusted device asks for a second factor next time —
 * while every other destructive surface in the app confirmed. On a shared
 * screen a mis-tap is a support call.
 *
 * The sweep that followed found fourteen more of the same shape, and this file
 * grew to hold them. It reads the sources rather than rendering, because what
 * it pins is structural: that these particular controls route through
 * `ConfirmButton` / `ConfirmDialog` and never call a destroying mutation
 * straight from an `onClick`. A render test would prove a dialog exists in one
 * arrangement; this proves no control on these surfaces can go back to firing
 * directly.
 *
 * It is one leg of three, and none of them stands alone:
 *
 *   - here: each named control routes through the primitive;
 *   - `src/components/ui/__tests__/confirm-button.test.tsx`: the primitive
 *     hands the caller's callback to the dialog action and nowhere else, so a
 *     dismissal cannot act;
 *   - `src/__tests__/destructive-control-guard.test.ts`: no NEW destructive
 *     control can arrive without being written down.
 *
 * Together those give "each guarded control refuses to act on a dismissed
 * dialog" without a click-through the SSR-only test setup cannot perform.
 */

function source(rel: string) {
  return readFileSync(join(process.cwd(), "src", rel), "utf8");
}

/**
 * Every control that must open a confirmation before it destroys anything,
 * keyed by the `slot` it hands the primitive. A slot that disappears from its
 * file means the control was renamed, moved, or unwired — all three are worth
 * a red test.
 */
const CONTROLS: { file: string; slots: string[] }[] = [
  {
    file: "components/settings/security-sessions-card.tsx",
    slots: ["revoke-session", "sign-out-everywhere"],
  },
  {
    file: "components/settings/trusted-devices-card.tsx",
    slots: ["revoke-trusted-device", "revoke-all-trusted-devices"],
  },
  // The note wipe. Scoped to the note as well as gated — see
  // `about-me-clear-scope.test.tsx` for the payload half. #159 — the panel
  // moved to the Anamnese as `about-me-note-manager.tsx`.
  {
    file: "components/records/about-me-note-manager.tsx",
    slots: ["settings-about-me-clear"],
  },
  {
    file: "components/settings/ai/codex-provider-form.tsx",
    slots: ["settings-codex-disconnect"],
  },
  {
    file: "components/admin/central-codex-section.tsx",
    slots: ["admin-central-codex-disconnect"],
  },
  {
    file: "components/admin/ai-server-key-section.tsx",
    slots: ["admin-ai-server-key-remove"],
  },
  {
    file: "components/settings/account-section/avatar-section.tsx",
    slots: ["settings-avatar-remove"],
  },
  {
    file: "components/settings/coach-memory-section.tsx",
    slots: ["settings-coach-memory-forget"],
  },
  {
    file: "components/settings/sources-section.tsx",
    slots: ["settings-sources-reset"],
  },
  {
    file: "components/settings/dashboard-layout-section.tsx",
    slots: ["settings-dashboard-layout-reset"],
  },
  {
    file: "components/insights/insights-edit-mode.tsx",
    slots: ["insights-edit-reset"],
  },
  {
    file: "components/targets/target-edit-sheet.tsx",
    slots: ["target-edit-reset"],
  },
  { file: "app/coach/plans/page.tsx", slots: ["coach-plan-delete"] },
  {
    file: "components/cycle/log-day-sheet.tsx",
    slots: ["cycle-day-delete", "cycle-custom-symptom-remove"],
  },
  // Two controls, one interpolated slot each: the per-metric reset and the
  // override switch, which delete the same stored range.
  {
    file: "components/settings/thresholds-editor-section.tsx",
    slots: [
      "settings-thresholds-reset-all",
      "settings-thresholds-reset-${metric}",
      "settings-thresholds-override-off-${metric}",
    ],
  },
];

describe("destructive controls confirm before firing", () => {
  for (const control of CONTROLS) {
    describe(control.file, () => {
      const src = source(control.file);

      it("routes every named control through the shared confirmation", () => {
        expect(src).toMatch(/<Confirm(Button|Dialog)\b/);
        for (const slot of control.slots) {
          // A slot naming a metric is written as a template literal at the
          // call site; a fixed one is a plain string attribute.
          const written = slot.includes("${")
            ? `slot={\`${slot}\`}`
            : `slot="${slot}"`;
          expect(src, `${control.file} lost slot ${slot}`).toContain(written);
        }
      });

      it("names the consequence in surface-specific copy", () => {
        // A dialog that says "Are you sure?" makes the person guess what they
        // are agreeing to, so every body is a key belonging to this surface.
        // Two controls MAY share one — the per-metric threshold reset and the
        // override switch do, because they perform the identical delete — so
        // what is pinned is the provenance of the copy, not its cardinality.
        const bodies = [...src.matchAll(/\bbody=\{([\s\S]{0,200}?)\}\n/g)].map(
          (m) => m[1],
        );
        expect(
          bodies.length,
          `${control.file}: no confirmation body found`,
        ).toBeGreaterThan(0);
        const keys = bodies.flatMap((b) =>
          [...b.matchAll(/t\("([^"]+)"/g)].map((m) => m[1]),
        );
        expect(keys.length).toBeGreaterThanOrEqual(bodies.length);
        for (const key of keys) {
          expect(key, `${control.file}: generic dialog copy`).not.toMatch(
            /^common\./,
          );
        }
      });
    });
  }
});

describe("the threshold override switch deletes behind the same dialog", () => {
  /**
   * The switch labelled "Custom range" performs the same irreversible delete
   * as the Reset button beside it — flipping it off drops the stored range —
   * from a control that reads as a display toggle. It was the one destructive
   * path in this sweep that no earlier pass named, precisely because it is not
   * shaped like a delete. `ConfirmButton` cannot wrap a switch, which is why
   * `ConfirmDialog` exists.
   */
  const src = source("components/settings/thresholds-editor-section.tsx");
  const handler = src.slice(
    src.indexOf("onCheckedChange={(next)"),
    src.indexOf("disabled={busy}", src.indexOf("onCheckedChange={(next)")),
  );

  it("does not reset straight from the switch handler", () => {
    expect(handler).toContain("setConfirmSwitchOff(true)");
    expect(
      handler,
      "flipping the switch must open the dialog, not perform the delete",
    ).not.toMatch(/onReset\(\)/);
  });

  it("leaves the switch on when the dialog is dismissed", () => {
    // `setOverrideMode(false)` lives inside `onConfirm`, not in the handler,
    // so a cancelled dialog leaves both the switch and the stored range alone.
    const confirmArm = src.slice(
      src.indexOf("<ConfirmDialog"),
      src.indexOf("/>", src.indexOf("<ConfirmDialog")),
    );
    expect(confirmArm).toContain("setOverrideMode(false)");
    expect(confirmArm).toContain("onReset()");
    expect(handler).not.toContain("setOverrideMode(false)");
  });
});
