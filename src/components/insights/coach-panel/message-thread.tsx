"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import { scrollBehaviorForUser } from "@/lib/motion";
import { useTranslations } from "@/lib/i18n/context";

import { PlanProposalCards } from "./plan-proposal-card";
import { ChatBubble } from "./chat-bubble";
import { CoachFollowUpChips } from "./follow-up-chips";
import { CoachMessageDatesProvider } from "./coach-results";
import type {
  CoachConversationDetailDTO,
  CoachOptimisticUserMessage,
  CoachStreamingMessage,
} from "./use-coach";
import type {
  CoachClarification,
  CoachFollowUp,
  CoachMessageDTO,
} from "@/lib/ai/coach/types";

// v1.28.26 file-size split (pure code motion): the bubble renderer +
// per-message actions live in `chat-bubble.tsx`, the read-aloud stack in
// `read-aloud.tsx`. The previously public names re-export from here so
// external call sites are unchanged.
export {
  TypingDots,
  errorCodeToI18nKey,
  selectCoachChartTokens,
} from "./chat-bubble";

/**
 * v1.4.20 phase B2b — message-thread renderer.
 *
 * Mounted inside the centre column of the Coach drawer. Renders the
 * persisted message history (decrypted server-side and delivered as
 * `CoachMessageDTO[]`) + an optional in-flight assistant bubble fed
 * by the streaming hook.
 *
 * Auto-scroll behaviour: scrolls to the bottom whenever the message
 * list grows OR the streaming-content length changes. The user can
 * scroll up to read history; we suppress auto-scroll until the next
 * "new message" tick if they're not already pinned to the bottom.
 *
 * Visual identity: user bubbles right-aligned, Dracula purple accent;
 * assistant bubbles left-aligned with the gradient sparkle avatar
 * from the artboard.
 */
export interface MessageThreadProps {
  conversation: CoachConversationDetailDTO | null;
  /** Optional in-flight bubble from `useSendCoachMessage()`. */
  streaming?: CoachStreamingMessage;
  /**
   * v1.4.25 W5 — optimistic user message surfaced by the send hook so
   * the user sees their own bubble before the "Thinking…" placeholder.
   * Cleared by the hook once the SSE `done` frame fires (the persisted
   * twin lands via the invalidate-refetch). When the persisted twin is
   * already in `conversation.messages` we suppress the optimistic copy
   * so the user never sees the same bubble twice.
   */
  optimisticUser?: CoachOptimisticUserMessage | null;
  /** Empty-state copy when no conversation is loaded yet. */
  emptyHint?: string;
  /**
   * v1.16.5 — locally-rendered bubbles the guided clarifying-questions
   * flow interleaves with the persisted history (deterministic Coach
   * questions + the closing summary). Items anchored on an answer
   * render immediately before the user message that answered them;
   * unanchored items render at the thread tail. See `placeInterleaved`.
   */
  interleaved?: InterleavedThreadItem[];
  /**
   * v1.22 — "Try again" on an assistant turn. The thread resolves the user
   * message that produced the reply and hands its text up; the surface
   * resubmits it as a fresh turn. Omitted → the regenerate action is hidden.
   */
  onRegenerate?: (userText: string) => void;
  /**
   * v1.39.4 — a follow-up chip was tapped. Omitted → no chips are shown.
   */
  onFollowUp?: (followUp: CoachFollowUp, messageId: string) => void;
}

/**
 * v1.39.4 — the open clarifying question: the latest assistant turn's
 * choices, whether it is the just-settled streamed turn or the last
 * persisted message. None while a turn is in flight, and none once the
 * person has answered (their message is then the last one).
 */
export function latestClarification(
  messages: CoachMessageDTO[],
  streaming: CoachStreamingMessage | undefined,
): { messageId: string; clarification: CoachClarification } | null {
  if (streaming?.inProgress) return null;
  if (streaming?.messageId && streaming.clarification) {
    return {
      messageId: streaming.messageId,
      clarification: streaming.clarification,
    };
  }
  const last = messages[messages.length - 1];
  if (streaming?.messageId && streaming.messageId !== last?.id) return null;
  if (last?.role !== "assistant") return null;
  const clarification = last.metricSource?.clarification;
  return clarification ? { messageId: last.id, clarification } : null;
}

/**
 * v1.39.4 — the chips to offer, and the message that offered them: the
 * latest assistant turn only, whether it is the just-settled streamed turn
 * or the last persisted message. None while a turn is in flight.
 */
export function latestFollowUps(
  messages: CoachMessageDTO[],
  streaming: CoachStreamingMessage | undefined,
): { messageId: string; followUps: CoachFollowUp[] } | null {
  if (streaming?.inProgress) return null;
  if (streaming?.messageId && streaming.followUps.length > 0) {
    return { messageId: streaming.messageId, followUps: streaming.followUps };
  }
  const last = messages[messages.length - 1];
  if (streaming?.messageId && streaming.messageId !== last?.id) return null;
  if (last?.role !== "assistant") return null;
  const followUps = last.metricSource?.followUps ?? [];
  return followUps.length > 0 ? { messageId: last.id, followUps } : null;
}

/**
 * v1.16.5 — one locally-rendered thread bubble contributed by the
 * guided clarifying-questions flow. The thread owns only the placement;
 * the node's behaviour lives with the flow in `coach-conversation`.
 */
export interface InterleavedThreadItem {
  key: string;
  /**
   * Content of the user message this item precedes (a guided question
   * renders above its answer). `null` → render at the thread tail
   * (the current question / the summary).
   */
  anchorAnswer: string | null;
  node: React.ReactNode;
}

/**
 * Pure placement for interleaved items, exported for unit tests.
 * Items are chronological by construction (the guided flow emits them
 * in question order), so a single forward pointer suffices: each
 * anchored item consumes the first remaining user message whose
 * content equals its anchor. Anchors that never match (e.g. an errored
 * turn whose message was never persisted) fall through to the tail so
 * no bubble is ever silently dropped.
 */
export function placeInterleaved(
  items: InterleavedThreadItem[],
  messages: { id: string; role: string; content: string }[],
  optimisticContent: string | null,
): {
  before: Map<string, InterleavedThreadItem>;
  beforeOptimistic: InterleavedThreadItem[];
  tail: InterleavedThreadItem[];
} {
  const anchored = items.filter((i) => i.anchorAnswer !== null);
  const before = new Map<string, InterleavedThreadItem>();
  let p = 0;
  for (const m of messages) {
    if (p >= anchored.length) break;
    if (m.role === "user" && m.content === anchored[p].anchorAnswer) {
      before.set(m.id, anchored[p]);
      p += 1;
    }
  }
  const beforeOptimistic: InterleavedThreadItem[] = [];
  if (
    p < anchored.length &&
    optimisticContent !== null &&
    optimisticContent === anchored[p].anchorAnswer
  ) {
    beforeOptimistic.push(anchored[p]);
    p += 1;
  }
  const tail = [
    ...anchored.slice(p),
    ...items.filter((i) => i.anchorAnswer === null),
  ];
  return { before, beforeOptimistic, tail };
}

/**
 * v1.18.7 — shared thin/rounded/subtle scrollbar styling for the Coach
 * scroll regions (the message thread + the history list). Kept as a
 * Tailwind-arbitrary class string so the styling is component-scoped —
 * the parallel agent owns `globals.css` and we must not touch it.
 *
 * Firefox: `scrollbar-width: thin` + a tinted thumb on a transparent
 * track. WebKit: an 8 px overlay-style thumb with a fully rounded
 * radius and no arrow buttons, brightening on hover. The Dracula purple
 * is mixed down so the bar reads as a hairline accent, not a hard edge.
 */
export const COACH_SCROLLBAR = cn(
  "[scrollbar-color:color-mix(in_srgb,var(--primary)_30%,transparent)_transparent] [scrollbar-width:thin]",
  "[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar]:h-2",
  "[&::-webkit-scrollbar-track]:bg-transparent",
  "[&::-webkit-scrollbar-button]:hidden [&::-webkit-scrollbar-button]:size-0",
  "[&::-webkit-scrollbar-thumb]:rounded-full",
  "[&::-webkit-scrollbar-thumb]:border-[3px] [&::-webkit-scrollbar-thumb]:border-transparent [&::-webkit-scrollbar-thumb]:bg-clip-content",
  "[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--primary)_30%,transparent)]",
  "hover:[&::-webkit-scrollbar-thumb]:bg-[color-mix(in_srgb,var(--primary)_45%,transparent)]",
);

function isPinnedToBottom(el: HTMLElement, slack = 64): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack;
}

export function MessageThread({
  conversation,
  streaming,
  optimisticUser,
  emptyHint,
  interleaved,
  onRegenerate,
  onFollowUp,
}: MessageThreadProps) {
  const { t } = useTranslations();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const wasPinnedRef = useRef(true);

  // v1.4.27 F14 — the evidence disclosure used to honour an opt-in
  // `coachPrefs.showEvidenceByDefault` flag that surfaced the raw
  // measurement values unconditionally. The flag created an UX trap
  // (the maintainer 2026-05-15: "literal metric values exposed under every
  // bubble") so the disclosure is now collapsed by default for every
  // reply. The user expands by click; the pref is retired in the
  // settings sheet so nothing flips it back on.

  const messages: CoachMessageDTO[] = useMemo(
    () => conversation?.messages ?? [],
    [conversation?.messages],
  );
  // v1.39.4 — when each message was written, so a table copied from an
  // earlier answer can name that answer's date.
  const messageDates = useMemo(
    () => new Map(messages.map((m) => [m.id, m.createdAt])),
    [messages],
  );
  // v1.16.5 — locally-rendered guided bubbles (see `placeInterleaved`).
  const interleavedItems = interleaved ?? [];
  // v1.4.20.1 — once the SSE stream emits `done`, the route's
  // invalidate-then-refetch pulls the persisted assistant message into
  // `conversation.messages`. The streaming bubble was still rendering
  // because the hook keeps `streaming.content` populated to support
  // the in-flight render path; the result was two assistant bubbles
  // side by side until the next `send` reset the streaming state.
  // Suppress the streaming bubble at render time as soon as the
  // persisted twin lands — comparing on `messageId` keeps the
  // transition seamless while never accidentally hiding an in-flight
  // bubble (during streaming `messageId` is null).
  // v1.4.22 W5 reconcile (Code-MED-3) — streaming/persisted-twin
  // race. On slow connections SSE `done` fires before the
  // invalidate-refetch resolves; the persisted twin lands while the
  // streaming bubble is still painted, producing a 200-500ms
  // duplicate render. Hide the persisted twin (matched on
  // streaming.messageId) for a 150ms grace window after it first
  // appears so the streaming bubble stays alone until the streaming
  // state cleans up naturally on the next `send`.
  const [graceWindow, setGraceWindow] = useState(false);
  const lastPersistedIdRef = useRef<string | null>(null);
  useEffect(() => {
    const persistedId = streaming?.messageId ?? null;
    if (
      persistedId &&
      persistedId !== lastPersistedIdRef.current &&
      messages.some((m) => m.id === persistedId)
    ) {
      lastPersistedIdRef.current = persistedId;
      setGraceWindow(true);
      const handle = setTimeout(() => setGraceWindow(false), 150);
      return () => clearTimeout(handle);
    }
  }, [streaming?.messageId, messages]);
  const suppressedTwinId = graceWindow ? streaming?.messageId : null;

  const streamingPersisted =
    !graceWindow &&
    streaming?.messageId != null &&
    messages.some((m) => m.id === streaming.messageId);
  const streamingActive =
    !streamingPersisted &&
    (!!streaming?.inProgress || !!streaming?.content || !!streaming?.errorCode);

  // v1.4.25 W5 — render the optimistic user bubble only when the
  // persisted twin hasn't landed yet. We match on (role=user, content
  // equality, no later persisted user message). The server is the
  // source of truth — once the persisted user message lands (via the
  // invalidate-refetch the SSE `done` frame triggers), the optimistic
  // copy is dropped so the user never sees their bubble twice.
  const optimisticActive = (() => {
    if (!optimisticUser) return false;
    // Suppress if the persisted history already contains the same
    // user content as the last user message — the twin has landed.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (lastUser && lastUser.content === optimisticUser.content) return false;
    return true;
  })();

  // v1.16.5 — slot the guided bubbles around the persisted history,
  // the optimistic user bubble, and the streaming tail. Cheap on every
  // render: at most a handful of items over a single message walk.
  const placement = placeInterleaved(
    interleavedItems,
    messages,
    optimisticActive && optimisticUser ? optimisticUser.content : null,
  );

  const chips = latestFollowUps(messages, streaming);

  // Track scroll position so we don't yank the viewport when the user
  // is browsing earlier turns.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      wasPinnedRef.current = isPinnedToBottom(el);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll on new messages OR streaming-content growth, but only
  // when the user was already at the bottom. v1.4.25 W5 — the
  // optimistic user bubble counts as a new message; scroll on its
  // localId so the user sees their own bubble land at the bottom.
  // v1.16.5 — guided bubbles count as new messages for the auto-scroll.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (wasPinnedRef.current) {
      // v1.4.43 W5-H5 — respect `prefers-reduced-motion`.
      el.scrollTo({ top: el.scrollHeight, behavior: scrollBehaviorForUser() });
    }
  }, [
    messages.length,
    streaming?.content,
    optimisticUser?.localId,
    interleavedItems.length,
  ]);

  // v1.4.27 R3d MB4 / CF-74 — re-pin to the bottom when the
  // visual viewport shrinks (typically the soft keyboard opening on
  // a phone). Without this the last bubble drifts behind the keyboard
  // because the scroller's `scrollHeight` references the layout
  // viewport, not the visible region. Listening on
  // `window.visualViewport.resize` and re-issuing the scroll keeps the
  // tail of the thread visible as the keyboard slides in and out.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const vv = window.visualViewport;
    if (!vv) return;
    const handleResize = () => {
      const el = scrollerRef.current;
      if (!el) return;
      if (wasPinnedRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      }
    };
    vv.addEventListener("resize", handleResize);
    return () => vv.removeEventListener("resize", handleResize);
  }, []);

  if (
    messages.length === 0 &&
    !streamingActive &&
    !optimisticActive &&
    interleavedItems.length === 0
  ) {
    return (
      <div
        data-slot="coach-message-thread"
        role="status"
        aria-live="polite"
        className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center"
      >
        <div
          aria-hidden="true"
          className="from-primary to-brand-pink flex size-12 items-center justify-center rounded-full bg-gradient-to-br"
        >
          <Sparkles className="text-background size-5" />
        </div>
        <p className="max-w-sm text-sm leading-relaxed">
          {emptyHint ?? t("insights.coach.threadEmpty")}
        </p>
      </div>
    );
  }

  return (
    <CoachMessageDatesProvider dates={messageDates}>
      <div
        ref={scrollerRef}
        data-slot="coach-message-thread"
        className={cn(
          // v1.18.6.1 — `min-h-0 flex-1` (not `h-full`) so the scroll region
          // resolves its height from the flex parent rather than a 100%-of-auto
          // chain that let the thread grow instead of scroll.
          // v1.18.7 — calmer vertical rhythm (gap-6) and more generous top/
          // bottom breathing room so the conversation reads like a document,
          // not a chat log packed against the chrome.
          "flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-6 sm:px-6",
          // v1.18.6 (CCH-01) / v1.18.7 — on the wide page surface an edge-to-
          // edge thread sprawled the prose past a readable measure. Centre the
          // content on a narrower, calmer Claude/ChatGPT-like column
          // (`max-w-2xl`) via an `mx-auto` inner gutter; the scrollbar still
          // rides the surface edge. The drawer surface is already narrow, so
          // the cap only bites on the wide page surface.
          "[&>*]:mx-auto [&>*]:w-full [&>*]:max-w-2xl",
          "scroll-smooth",
          // v1.18.7 — thin, rounded, subtle scrollbar (WebKit + Firefox),
          // component-scoped via Tailwind arbitrary variants so globals.css
          // stays untouched. Replaces the default boxy/angular track.
          COACH_SCROLLBAR,
        )}
      >
        {messages.map((m, idx) => {
          // v1.4.22 W5 reconcile (Code-MED-3) — suppress the persisted
          // twin during the 150ms grace window so the streaming bubble
          // stays alone on slow connections.
          if (m.id === suppressedTwinId) return null;
          // v1.16.5 — a guided question renders directly above the user
          // message that answered it.
          const guidedBefore = placement.before.get(m.id);
          // v1.22 — "Try again": resolve the user message that produced this
          // assistant reply (the nearest preceding user turn) so the surface
          // can resubmit it. Null when there is none → no regenerate action.
          let precedingUserContent: string | null = null;
          if (m.role === "assistant" && onRegenerate) {
            for (let j = idx - 1; j >= 0; j--) {
              if (messages[j].role === "user") {
                precedingUserContent = messages[j].content;
                break;
              }
            }
          }
          return (
            <Fragment key={m.id}>
              {guidedBefore?.node}
              <ChatBubble
                role={m.role}
                content={m.content}
                metricSource={m.metricSource}
                conversationId={conversation?.id ?? null}
                providerType={m.providerType}
                messageId={m.id}
                tokensUsed={m.tokensUsed}
                model={m.model}
                createdAt={m.createdAt}
                onRegenerate={
                  precedingUserContent !== null && onRegenerate
                    ? () => onRegenerate(precedingUserContent as string)
                    : undefined
                }
              />
            </Fragment>
          );
        })}
        {/* v1.4.25 W5 — optimistic user bubble surfaces between the
          persisted history and the streaming assistant placeholder so
          the visible order matches the user's mental model. The
          send-hook drops it as soon as the SSE `done` frame fires +
          the invalidate-refetch lands the persisted twin. */}
        {/* v1.16.5 — guided question whose answer is still optimistic-only. */}
        {placement.beforeOptimistic.map((i) => (
          <Fragment key={i.key}>{i.node}</Fragment>
        ))}
        {optimisticActive && optimisticUser && (
          <ChatBubble
            key={optimisticUser.localId}
            role="user"
            content={optimisticUser.content}
          />
        )}
        {streamingActive && streaming && (
          // role=log + aria-live=polite so screen-reader users hear the
          // assistant prose announce as tokens land. aria-relevant=text
          // limits announcements to the streamed content; additions
          // covers the bubble-mount edge case.
          <div
            role="log"
            aria-live="polite"
            aria-relevant="additions text"
            // v1.18.7 — a soft fade/slide-in on the assistant turn so the
            // hand-off from the thinking beat to the first streamed tokens
            // reads as one continuous motion, not a hard swap. v1.18.9 — the
            // per-word fade now lives in <StreamedProse>; this stays a light
            // container fade for the disclosure → prose transition.
            className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-1 motion-safe:duration-300"
          >
            <ChatBubble
              role="assistant"
              content={streaming.content}
              metricSource={streaming.metricSource}
              suggestion={streaming.suggestion}
              suggestedAction={streaming.suggestedAction}
              steps={streaming.steps}
              results={streaming.results}
              providerType={streaming.inProgress ? "streaming" : null}
              inProgress={streaming.inProgress}
              errorCode={streaming.errorCode}
              // v1.18.9 — live word-fade + the just-landed token footer.
              streaming
              usage={streaming.usage}
            />
          </div>
        )}
        {/* v1.39.4 — follow-up chips under the latest assistant turn only. */}
        {onFollowUp && chips ? (
          <CoachFollowUpChips
            followUps={chips.followUps}
            messageId={chips.messageId}
            disabled={!!streaming?.inProgress}
            onSelect={onFollowUp}
          />
        ) : null}
        {/* v1.16.5 — thread tail: the current guided question and/or the
          closing summary follow the last completed turn. */}
        {placement.tail.map((i) => (
          <Fragment key={i.key}>{i.node}</Fragment>
        ))}
        {/* Plan-proposal confirm cards for THIS conversation. The extractor
          runs after the turn (memory-refresh worker), so the block appears at
          the thread tail once the proposal lands rather than under a specific
          bubble; the component itself slow-polls and renders nothing while
          the conversation has no open proposal. */}
        {conversation ? (
          <PlanProposalCards conversationId={conversation.id} />
        ) : null}
      </div>
    </CoachMessageDatesProvider>
  );
}
