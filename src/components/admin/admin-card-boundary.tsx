"use client";

import { Component, Fragment, type ReactNode } from "react";

import { QueryErrorCard } from "@/components/ui/query-error-card";
import { useTranslations } from "@/lib/i18n/context";

/**
 * One admin card's error boundary.
 *
 * An admin page stacks independent cards, each reading its own endpoint. A
 * card that threw while rendering took the whole page with it: a field the
 * off-host card read and a stale payload did not carry left the backups page
 * without its snapshot table, the one card the operator had come for. Each
 * card now fails alone, as a `QueryErrorCard` in its place, and the others
 * keep working. "Try again" remounts the card, which refetches what it reads;
 * the error still reaches the client error tracker.
 */
export function AdminCardBoundary({ children }: { children: ReactNode }) {
  return (
    <Boundary renderFallback={(retry) => <AdminCardError onRetry={retry} />}>
      {children}
    </Boundary>
  );
}

/** What a failed card paints in its place. */
export function AdminCardError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslations();
  return (
    <QueryErrorCard
      title={t("admin.cardError.title")}
      description={t("admin.cardError.description")}
      onRetry={onRetry}
    />
  );
}

export interface BoundaryProps {
  renderFallback: (retry: () => void) => ReactNode;
  children: ReactNode;
}

interface BoundaryState {
  failed: boolean;
  attempt: number;
}

/** The boundary itself, exported for its unit test. */
export class Boundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false, attempt: 0 };

  static getDerivedStateFromError(): Pick<BoundaryState, "failed"> {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    if (typeof window !== "undefined") {
      const g = window as typeof window & {
        __healthlog_onError?: (err: Error) => void;
      };
      g.__healthlog_onError?.(error);
    }
  }

  retry = (): void => {
    this.setState((s) => ({ failed: false, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    if (this.state.failed) return this.props.renderFallback(this.retry);
    // A new key on retry remounts the card, so it starts from a clean state
    // rather than re-rendering the tree that threw.
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
