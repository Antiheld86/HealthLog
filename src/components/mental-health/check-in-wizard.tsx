"use client";

/**
 * v1.25.3 — one-question-at-a-time check-in, rendered INLINE on the page
 * (not a modal), because here the page *is* the surface.
 *
 * v1.27.6 — slimmed to questions only. The question-overview strip (the
 * dot/jump row borrowed from the medication wizard) and the "N of N
 * answered" review interstitial are gone: a screening is a quiet, linear
 * moment, not a form to audit. The Back button stays; a small "3 / 9"
 * caption keeps orientation without turning progress into a scoreboard.
 * Answering the last question arms the submit directly — the next thing
 * the user sees is the dignified result view.
 *
 * v1.27.9 — the wizard drives from the instrument registry instead of a
 * hard-wired 0–3 scale: option values/order, option-label scheme (shared
 * anchors vs the SCI's per-item anchor groups), and the recall-stem caption
 * (the WHO-5 / SCI items are fragments under a shared stem on the source
 * forms) all come from `INSTRUMENTS`. Locales without a validated item
 * translation (SCI outside English) get an honest chrome note; the items
 * themselves stay in the validated source language.
 *
 * Header: instrument title + ONE standardized explanation line, NO
 * disclaimer (§2 — the "voluntary self-test, not a diagnosis" disclaimer
 * renders only on the landing, never while taking the test).
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import {
  INSTRUMENTS,
  hasValidatedItems,
  optionLabelKey,
  stemKey,
} from "@/lib/mental-health/instruments";

import {
  isComplete,
  isLastStep,
  nextStep,
  prevStep,
  UNANSWERED,
} from "./check-in-nav";
import type { InstrumentId } from "./types";

const FUNCTIONAL_SCALE = [0, 1, 2, 3] as const;

export function CheckInWizard({
  instrument,
  onSubmit,
  onBack,
  isPending,
  isError,
}: {
  instrument: InstrumentId;
  /** Submit the completed check-in (+ the optional PHQ-9 follow-up). */
  onSubmit: (items: number[], functionalDifficulty?: number) => void;
  /** Return to the landing (abandons the in-progress check-in). */
  onBack: () => void;
  isPending: boolean;
  isError: boolean;
}) {
  const { t, locale } = useTranslations();
  const def = INSTRUMENTS[instrument];
  const key = def.i18nKey;
  const itemCount = def.itemCount;
  // v1.27.8 — the PHQ-9 asks its validated functional-impairment
  // follow-up as a regular LAST question (10 of 10) instead of a
  // separate review-step widget. It is OPTIONAL per the instrument
  // (answering is not required to submit) and never scores into the
  // total — the value rides the existing `functionalDifficulty` API
  // field. The other instruments have no such item.
  const hasFunctionalStep = instrument === "PHQ9";
  const totalSteps = itemCount + (hasFunctionalStep ? 1 : 0);

  const [step, setStep] = useState(1);
  const [items, setItems] = useState<number[]>(() =>
    Array(itemCount).fill(UNANSWERED),
  );
  const [functional, setFunctional] = useState<number>(UNANSWERED);

  const onFunctionalStep = hasFunctionalStep && step === itemCount + 1;
  const onLast = isLastStep(step, totalSteps);
  const questionIndex = step - 1; // 0-based item index for the current question
  const complete = isComplete(items);
  const questionLabel = onFunctionalStep
    ? t("mentalHealth.functionalTitle")
    : t(`mentalHealth.items.${key}.${step}`);
  // Recall-stem caption above the question (WHO-5 / SCI fragments).
  const stem = onFunctionalStep ? null : stemKey(instrument, questionIndex);
  const scale = onFunctionalStep ? FUNCTIONAL_SCALE : def.optionOrder;

  // a11y: announce each step by moving focus to its heading (the question
  // text). Mirrors the medication dialog's per-step title focus so a
  // keyboard / screen-reader user hears the new question after an
  // auto-advance, not silence.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: false });
  }, [step]);

  function selectAnswer(value: number) {
    if (onFunctionalStep) {
      // Optional follow-up: selecting never advances (it IS the last
      // step) and tapping the selected option again clears it — the
      // answer stays skippable right up to submit.
      setFunctional((prev) => (prev === value ? UNANSWERED : value));
      return;
    }
    setItems((prev) => {
      const next = [...prev];
      next[questionIndex] = value;
      return next;
    });
    // Forward-on-select: advance to the next question. On the last question
    // the selection stays visible and the footer submit arms — submitting is
    // a deliberate second tap, never a side effect of answering.
    if (!onLast) setStep((s) => nextStep(s, totalSteps));
  }

  return (
    <section
      className="flex flex-col gap-4"
      data-slot="mental-health-check-in"
      aria-busy={isPending || undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 w-fit"
        onClick={onBack}
        data-slot="check-in-back-to-landing"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        {t("mentalHealth.backToList")}
      </Button>

      {/* In-test header — instrument title + ONE standardized explanation line.
          No disclaimer here (§2); the landing carries it. */}
      <header className="flex flex-col gap-1">
        {/* Wizard hero H1: intentionally semibold, same hero exception as onboarding (UI-STANDARDS §5). Do not sweep to font-bold. */}
        <h1 className="text-2xl font-semibold">
          {t(`mentalHealth.instrument.${key}`)}
        </h1>
        <p className="text-muted-foreground text-sm">
          {t(`mentalHealth.instrumentDescription.${key}`)}
        </p>
        {/* Honest translation note: the instrument is validated in its source
            language; the surrounding chrome stays localized. */}
        {!hasValidatedItems(instrument, locale) && (
          <p
            className="text-muted-foreground text-xs"
            data-slot="check-in-validated-note"
          >
            {t("mentalHealth.validatedInEnglishNote")}
          </p>
        )}
      </header>

      <Card className="gap-0 p-0">
        <CardContent className="flex flex-col gap-4 p-4 md:p-6">
          <div className="flex flex-col gap-4">
            <p className="text-muted-foreground text-xs">
              {t("mentalHealth.progress", {
                current: step,
                total: totalSteps,
              })}
            </p>
            {stem && (
              <p className="text-sm" data-slot="check-in-stem">
                {t(`mentalHealth.stems.${stem}`)}
              </p>
            )}
            <h2
              ref={headingRef}
              tabIndex={-1}
              className="scroll-mt-4 text-base font-medium outline-none"
            >
              {questionLabel}
            </h2>
            {onFunctionalStep && (
              <p className="text-muted-foreground text-xs">
                {t("mentalHealth.functionalOptionalHint")}
              </p>
            )}
            <div
              className="flex flex-col gap-2"
              role="group"
              aria-label={questionLabel}
            >
              {scale.map((v) => {
                const selected = onFunctionalStep
                  ? functional === v
                  : items[questionIndex] === v;
                return (
                  <Button
                    key={v}
                    type="button"
                    // 44px touch-target floor (WCAG 2.5.5).
                    className="min-h-11 justify-start"
                    variant={selected ? "default" : "outline"}
                    aria-pressed={selected}
                    onClick={() => selectAnswer(v)}
                    disabled={isPending}
                  >
                    {onFunctionalStep
                      ? t(`mentalHealth.functional.${v}`)
                      : t(optionLabelKey(instrument, questionIndex, v))}
                  </Button>
                );
              })}
            </div>

            {isError && (
              <p className="text-destructive text-sm" role="alert">
                {t("mentalHealth.error")}
              </p>
            )}
          </div>
        </CardContent>

        <div className="border-border/70 flex items-center justify-between gap-2 border-t p-4 md:p-6">
          <Button
            type="button"
            variant="ghost"
            className="h-11"
            onClick={() => setStep((s) => prevStep(s))}
            disabled={step === 1 || isPending}
            data-slot="check-in-back"
          >
            {t("mentalHealth.back")}
          </Button>
          {!onLast ? (
            <Button
              type="button"
              className="h-11"
              onClick={() => setStep((s) => nextStep(s, totalSteps))}
              disabled={items[questionIndex] < 0}
              data-slot="check-in-next"
            >
              {t("mentalHealth.next")}
            </Button>
          ) : (
            <Button
              type="button"
              className="h-11"
              onClick={() =>
                onSubmit(items, functional >= 0 ? functional : undefined)
              }
              disabled={!complete || isPending}
              aria-busy={isPending || undefined}
              data-slot="check-in-submit"
            >
              {isPending
                ? t("mentalHealth.submitting")
                : t("mentalHealth.submit")}
            </Button>
          )}
        </div>
      </Card>
    </section>
  );
}
