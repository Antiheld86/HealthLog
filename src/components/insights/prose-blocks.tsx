"use client";

import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import { learnUrl } from "@/lib/learn-links";
import { InlineLearnLink } from "@/components/ui/learn-more-link";

/**
 * v1.22 (W5) — shared paragraph renderer for every trusted-as-text AI
 * narrative surface (the Coach, the daily briefing, the per-metric /
 * score insight cards, the period narrative).
 *
 * The AI surfaces render their prose as plain React text children — there
 * is NO markdown library and NO `dangerouslySetInnerHTML` anywhere in the
 * tree (the project's XSS posture). Before this helper, three ad-hoc
 * approaches were in the tree (a single `<p>`, a `whitespace-pre-line`
 * `<p>`, and the Coach's word-span renderer), so a model that emitted real
 * paragraph breaks read as one run-on block.
 *
 * `ProseBlocks` settles that into ONE pure, XSS-safe splitter:
 *   - split a TRUSTED plain string on blank lines into real `<p>` blocks;
 *   - a single `\n` inside a paragraph becomes a `<br/>`;
 *   - recognised `/learn/<slug>` references (catalog-whitelisted, already
 *     post-filtered server-side) render as a real, safe `<a>` via
 *     `InlineLearnLink` — a closed-set linkifier, never model HTML.
 *
 * Everything is `String.prototype.split` + React children — no parser, no
 * markdown dependency, no injected markup. The chart-token strip
 * (`stripChartTokens`) runs PER LINE (not on the whole string): it
 * normalises intra-line whitespace, so running it on the full text would
 * collapse the `\n\n` paragraph breaks before they can be split on. Splitting
 * paragraphs first, then stripping each line, keeps the structure intact
 * while still ensuring a stray `metric:<TYPE>` token never surfaces.
 */

/** Default paragraph styling shared by every prose surface + the Coach
 *  streaming tail, so the streamed and settled renders line up exactly. */
export const PROSE_PARAGRAPH_CLASS =
  // Keep consecutive narrative blocks visually connected. The previous
  // 12px paragraph step made short assessments look like separate cards on
  // mobile, especially directly below a status pill or tile heading.
  "leading-relaxed break-words [&:not(:first-child)]:mt-2";

/**
 * Split a trusted-as-text string into real paragraphs on blank lines.
 * Whitespace-only fragments are dropped. Exported for the streaming
 * paragraph-aware renderer + unit tests.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Catalog-whitelisted `/learn/<slug>` matcher. Mirrors the post-filter's
 * grammar (`learn-link-guard.ts`): the host is optional (relative or the
 * absolute `healthlog.dev/learn/<slug>` form), the slug is the lower-case
 * hyphenated path segment after `/learn/`. The capture is validated against
 * the published catalog (`learnUrl`) before an anchor renders — an unknown
 * slug stays plain text, so a drifted post-filter can never produce a
 * clickable invented link.
 */
const LEARN_URL_RE =
  /(?:https?:\/\/)?(?:[a-z0-9.-]*healthlog\.dev)?\/learn\/[a-z0-9-]+\/?/gi;

/**
 * Turn a trusted single line of text into React children, rendering any
 * catalog-known `/learn/<slug>` reference as a safe `InlineLearnLink` and
 * leaving everything else as plain text nodes. An unknown slug (which the
 * server post-filter should already have stripped) falls through as plain
 * text — fail-closed, never a fabricated anchor.
 */
function linkifyLearnLinks(line: string): ReactNode {
  if (!line.includes("/learn/")) return line;

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  // `matchAll` over a global regex gives each match with its index so we
  // slice the surrounding text verbatim — no mutation of the source.
  for (const match of line.matchAll(LEARN_URL_RE)) {
    const matched = match[0];
    const start = match.index ?? 0;
    // The slug is the path segment after `/learn/`, minus a trailing slash.
    const slug = matched
      .slice(matched.indexOf("/learn/") + "/learn/".length)
      .replace(/\/$/, "")
      .toLowerCase();
    if (learnUrl(slug) == null) continue; // unknown slug → leave as plain text

    if (start > lastIndex) nodes.push(line.slice(lastIndex, start));
    nodes.push(
      <InlineLearnLink key={`learn-${key++}`} slug={slug}>
        {matched}
      </InlineLearnLink>,
    );
    lastIndex = start + matched.length;
  }
  if (nodes.length === 0) return line;
  if (lastIndex < line.length) nodes.push(line.slice(lastIndex));
  return <>{nodes}</>;
}

/**
 * `**bold**` span matcher. The ONLY inline emphasis the formatting contract
 * allows the models; anything else (headings, underscores, backticks) stays
 * literal text. No `*` or `\n` inside the span, so an unclosed `**` or a
 * stray asterisk falls through verbatim — fail-closed, never swallowed.
 */
const BOLD_SPAN_RE = /\*\*([^*\n]+)\*\*/g;

/**
 * Render one line's inline content: closed-set `**bold**` spans become
 * `<strong>`, and each plain/bold fragment runs through the catalog-
 * whitelisted Learn linkifier. Pure `matchAll` + slicing over the trusted
 * string — no parser, no markup passthrough.
 */
function renderInline(line: string, linkify: boolean): ReactNode {
  const linkified = (s: string) => (linkify ? linkifyLearnLinks(s) : s);
  if (!line.includes("**")) return linkified(line);

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of line.matchAll(BOLD_SPAN_RE)) {
    const start = match.index ?? 0;
    if (start > lastIndex)
      nodes.push(
        <Fragment key={`t-${key++}`}>
          {linkified(line.slice(lastIndex, start))}
        </Fragment>,
      );
    nodes.push(<strong key={`b-${key++}`}>{linkified(match[1])}</strong>);
    lastIndex = start + match[0].length;
  }
  if (nodes.length === 0) return linkified(line);
  if (lastIndex < line.length)
    nodes.push(
      <Fragment key={`t-${key++}`}>
        {linkified(line.slice(lastIndex))}
      </Fragment>,
    );
  return <>{nodes}</>;
}

/**
 * Render one paragraph's inner text: each single `\n` becomes a `<br/>`, each
 * line is (optionally) chart-token-stripped, then run through the closed-set
 * inline renderer (`**bold**` + the catalog-whitelisted Learn linkifier).
 * Stripping per LINE preserves the `\n` breaks that a whole-string strip
 * would collapse. Exported so the Coach streaming renderer can settle
 * completed paragraphs with the same markup the non-streaming path produces.
 */
export function ParagraphText({
  text,
  strip = false,
  linkify = true,
}: {
  text: string;
  strip?: boolean;
  linkify?: boolean;
}) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const cleaned = strip ? stripChartTokens(line) : line;
        return (
          <Fragment key={i}>
            {i > 0 && <br />}
            {renderInline(cleaned, linkify)}
          </Fragment>
        );
      })}
    </>
  );
}

/** `- ` / `– ` / `• ` list-item marker (leading whitespace tolerated). */
const BULLET_LINE_RE = /^\s*[-–•]\s+/;

/**
 * Render ONE blank-line-delimited block: consecutive `- ` lines group into a
 * real `<ul>` (marker stripped, one `<li>` per line), the remaining line runs
 * render as `<p>` with `<br/>` joins — so a model reply that enumerates
 * ("- option one\n- option two") reads as a list instead of dash-prefixed
 * text lines. Same pure line-splitting as everything else here: no parser,
 * no markup passthrough. Exported for the Coach streaming renderer.
 */
export function ProseBlock({
  text,
  strip = false,
  linkify = true,
  paragraphClassName,
}: {
  text: string;
  strip?: boolean;
  linkify?: boolean;
  paragraphClassName?: string;
}) {
  const blockClass = cn(paragraphClassName ?? PROSE_PARAGRAPH_CLASS);
  const lines = text.split("\n");
  const runs: Array<{ bullets: boolean; lines: string[] }> = [];
  for (const line of lines) {
    const bullets = BULLET_LINE_RE.test(line);
    const last = runs[runs.length - 1];
    if (last && last.bullets === bullets) last.lines.push(line);
    else runs.push({ bullets, lines: [line] });
  }
  return (
    <>
      {runs.map((run, i) =>
        run.bullets ? (
          <ul key={i} className={cn(blockClass, "list-disc space-y-1 pl-5")}>
            {run.lines.map((line, j) => (
              <li key={j}>
                <ParagraphText
                  text={line.replace(BULLET_LINE_RE, "")}
                  strip={strip}
                  linkify={linkify}
                />
              </li>
            ))}
          </ul>
        ) : (
          <p key={i} className={blockClass}>
            <ParagraphText
              text={run.lines.join("\n")}
              strip={strip}
              linkify={linkify}
            />
          </p>
        ),
      )}
    </>
  );
}

export interface ProseBlocksProps {
  /** Trusted-as-text prose (model output already verified server-side). */
  text: string;
  /**
   * Strip stray `metric:<TYPE>` chart tokens first (defence-in-depth).
   * Defaults true for AI prose; pass false for already-cleaned input or
   * for plain user text where a literal `metric:` substring is meaningful.
   */
  strip?: boolean;
  /** Linkify catalog-known `/learn/<slug>` references. Default true. */
  linkify?: boolean;
  /** Per-paragraph class override (defaults to `PROSE_PARAGRAPH_CLASS`). */
  paragraphClassName?: string;
}

export function ProseBlocks({
  text,
  strip = true,
  linkify = true,
  paragraphClassName,
}: ProseBlocksProps) {
  // Split on blank lines FIRST (raw text), then strip per line inside
  // `ParagraphText` — a whole-string strip would collapse the breaks.
  // Drop a paragraph that is empty once its tokens are stripped (a rare
  // token-only line), so no hollow `<p>` renders.
  const paras = splitParagraphs(text).filter(
    (p) => !strip || stripChartTokens(p).length > 0,
  );
  return (
    <>
      {paras.map((p, i) => (
        <ProseBlock
          key={i}
          text={p}
          strip={strip}
          linkify={linkify}
          paragraphClassName={paragraphClassName}
        />
      ))}
    </>
  );
}
