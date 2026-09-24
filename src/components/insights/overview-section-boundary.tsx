"use client";

import { Component, type ReactNode } from "react";

import { QueryErrorRow } from "@/components/ui/query-error-row";
import { useTranslations } from "@/lib/i18n/context";

/**
 * One Insights overview section, fenced.
 *
 * The overview is a stack of independent sections, each with its own read.
 * A section that fails to load already shows its own error row; this fence
 * covers the other failure, a section that throws while rendering (a payload
 * shape it did not expect, a chunk that no longer exists after a deploy).
 * Without it the throw reaches the route boundary and replaces the whole
 * page, so one broken card takes the hero, the scores and every other
 * section down with it. Inside the fence the failed section becomes one row
 * with a retry, and the rest of the page stays.
 *
 * Retry clears the fence and renders the section again; a section whose
 * failure was transient comes back, one whose failure is permanent shows the
 * row again.
 */
interface FenceProps {
  sectionId: string;
  message: string;
  retryLabel: string;
  children: ReactNode;
}

interface FenceState {
  failed: boolean;
}

class SectionFence extends Component<FenceProps, FenceState> {
  state: FenceState = { failed: false };

  static getDerivedStateFromError(): FenceState {
    return { failed: true };
  }

  componentDidCatch(error: Error): void {
    // Same hand-off the chart boundary uses: the section degrades quietly,
    // the failure still reaches the client error tracker.
    if (typeof window !== "undefined") {
      const g = window as typeof window & {
        __healthlog_onError?: (err: Error) => void;
      };
      g.__healthlog_onError?.(error);
    }
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section
        data-slot="insights-overview-section-error"
        data-section={this.props.sectionId}
      >
        <QueryErrorRow
          message={this.props.message}
          retryLabel={this.props.retryLabel}
          onRetry={() => this.setState({ failed: false })}
        />
      </section>
    );
  }
}

export function OverviewSectionBoundary({
  sectionId,
  children,
}: {
  sectionId: string;
  children: ReactNode;
}) {
  const { t } = useTranslations();
  return (
    <SectionFence
      sectionId={sectionId}
      message={t("insights.sectionLoadError")}
      retryLabel={t("common.retry")}
    >
      {children}
    </SectionFence>
  );
}
