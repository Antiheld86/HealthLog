/**
 * One admin card that throws while rendering paints an error card in its own
 * place, and the page around it keeps working.
 *
 * The component suite renders on the server, where React does not run error
 * boundaries, so the boundary's three moves are exercised directly: a thrown
 * render flips it to the fallback, the fallback is the translated error card
 * with a retry, and the retry puts the card back under a new key so it
 * remounts rather than re-rendering the tree that threw.
 */
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/lib/i18n/context";
import {
  AdminCardBoundary,
  AdminCardError,
  Boundary,
} from "../admin-card-boundary";

function markup(node: ReactNode): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">{node}</I18nProvider>,
  );
}

function boundaryWith(fallback: (retry: () => void) => ReactNode) {
  const boundary = new Boundary({
    renderFallback: fallback,
    children: <p>card body</p>,
  });
  // Outside a mounted tree `setState` does nothing, so apply it in place.
  boundary.setState = ((update: unknown) => {
    const next =
      typeof update === "function"
        ? (update as (s: typeof boundary.state) => object)(boundary.state)
        : (update as object);
    boundary.state = { ...boundary.state, ...next };
  }) as typeof boundary.setState;
  return boundary;
}

describe("AdminCardBoundary", () => {
  it("renders the card untouched while nothing has thrown", () => {
    const html = markup(
      <AdminCardBoundary>
        <p data-slot="healthy-card">card body</p>
      </AdminCardBoundary>,
    );
    expect(html).toContain('data-slot="healthy-card"');
    expect(html).not.toContain('data-slot="query-error-card"');
  });

  it("turns a thrown render into the fallback, not a page failure", () => {
    expect(Boundary.getDerivedStateFromError()).toEqual({ failed: true });

    const fallback = vi.fn(() => <p data-slot="fallback">fallback</p>);
    const boundary = boundaryWith(fallback);
    boundary.setState(Boundary.getDerivedStateFromError());

    expect(markup(boundary.render())).toContain('data-slot="fallback"');
    expect(fallback).toHaveBeenCalledWith(boundary.retry);
  });

  it("paints the translated error card with a keyboard-reachable retry", () => {
    const html = markup(<AdminCardError onRetry={() => {}} />);

    expect(html).toContain('data-slot="query-error-card"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("This part of the page could not be shown");
    expect(html).toContain("The rest of the page still works");
    expect(html).toContain('data-slot="query-error-retry"');
  });

  it("retries by remounting the card under a new key", () => {
    const boundary = boundaryWith(() => null);
    const before = boundary.render() as ReactElement;
    boundary.setState({ failed: true });

    boundary.retry();

    expect(boundary.state.failed).toBe(false);
    const after = boundary.render() as ReactElement;
    expect(after.key).not.toBe(before.key);
    expect(markup(after)).toContain("card body");
  });
});
