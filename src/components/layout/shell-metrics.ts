/**
 * Shared scroll-floor for the two-column sub-shells (Settings, Admin).
 *
 * Scroll height is shell-owned (over-scroll class, #154 lineage): only
 * `AuthShell` owns the scroll container's height and bottom padding — the
 * `<main>` clears the mobile bottom-nav and its wrapper clears the Coach FAB.
 * A sub-shell must NEVER re-declare a bottom gutter (`pb-*`) or a viewport
 * reserve (`min-h-[calc(100dvh-…)]`) on its own content column: a nested
 * reserve stacks on the shell budget and scrolls past the last card.
 *
 * The one sanctioned reserve is this loading-jump floor, applied to the
 * sub-shell GRID (not to a column): it keeps the page height stable while a
 * freshly-navigated section is still fetching, without over-shooting the
 * viewport on a short section. The `<main>`/cards column is the grid's `1fr`
 * row, so it stretches to fill exactly and never over-scrolls.
 *
 * Both sub-shells derive the floor from THIS single constant so the two can
 * never drift — Admin previously carried a stale, all-breakpoint
 * `min-h-[calc(100dvh-12rem)]` column reserve that this de-duplication retires.
 *
 * Budget: top bar 4rem + the AuthShell wrapper's `pt-6` (1.5rem) + `pb-20`
 * (5rem) = 10.5rem. Retune here — and only here — if those shell paddings
 * change. (Latent follow-up: this constant assumes zero banners above `<main>`;
 * a locale/offline/demo banner or an iOS PWA safe-area inset makes it
 * over-reserve. A fully self-accounting `min-h-full` chain would need the
 * AuthShell content wrapper to pass a definite height through, which is out of
 * scope for the shell-only over-scroll fix.)
 */
export const SUB_SHELL_GRID_FLOOR = "md:min-h-[calc(100dvh-10.5rem)]";

/**
 * The app-chrome header band: one 4rem strip whose bottom border draws the
 * single horizontal line across the top of the app.
 *
 * Two elements paint that line. The top bar (`top-bar.tsx`) draws it over the
 * content column, the sidebar logo band (`sidebar-nav.tsx`) draws it over the
 * rail, and the two live in different columns of the shell flex row, so
 * nothing in the layout makes them agree. Each used to declare `h-16` on its
 * own, and the two lines still landed a pixel apart: every box in the app is
 * `border-box`, so `h-16 border-b` on ONE element puts the line inside the
 * 4rem (63 to 64 px) while `h-16` on a child of a `border-b` wrapper puts it
 * after the 4rem (64 to 65 px). Same number, different line.
 *
 * The height and the border therefore travel together, from here. The element
 * that carries this class IS the band; neither call site restates a height,
 * and anything nested inside stretches with `h-full`.
 *
 * Border COLOUR stays per-surface (`border-border` on the top bar,
 * `border-sidebar-border` on the rail): the two chrome surfaces are tinted
 * apart by design and only the geometry has to match.
 *
 * Guards: `chrome-header-seam.test.tsx` asserts both elements render this
 * exact class and declare no height of their own;
 * `e2e/chrome-header-seam.spec.ts` measures the two painted borders at four
 * widths in both the expanded and the collapsed rail.
 */
export const SHELL_HEADER_BAND = "h-16 border-b";
