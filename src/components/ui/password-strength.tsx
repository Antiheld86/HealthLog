"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { getZxcvbnTranslations } from "@/lib/zxcvbn-i18n";
import { useTranslations } from "@/lib/i18n/context";

interface PasswordStrengthProps {
  password: string;
  minLength?: number;
}

// Both the bar fill and the label route through the AA-tuned semantic tokens
// — the raw Tailwind 500 tones failed contrast against the white card and
// drift off the app's token vocabulary. Weakest two bands are destructive,
// the middle band warning, the strong two bands success; fill and text share
// the same tone per score so the meter reads as one signal.
const SCORE_COLORS = [
  { color: "bg-destructive", textColor: "text-destructive" },
  { color: "bg-destructive", textColor: "text-destructive" },
  { color: "bg-warning", textColor: "text-warning" },
  { color: "bg-success", textColor: "text-success" },
  { color: "bg-success", textColor: "text-success" },
];

export function PasswordStrength({
  password,
  minLength = 12,
}: PasswordStrengthProps) {
  const { t, locale } = useTranslations();
  const { translate } = useMemo(() => getZxcvbnTranslations(locale), [locale]);
  const [result, setResult] = useState<{
    score: number;
    feedback: { warning: string; suggestions: string[] };
  } | null>(null);
  const zxcvbnRef = useRef<typeof import("zxcvbn-typescript").default | null>(
    null,
  );

  useEffect(() => {
    if (!password) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResult(null);
      return;
    }
    let cancelled = false;
    (async () => {
      if (!zxcvbnRef.current) {
        const mod = await import("zxcvbn-typescript");
        zxcvbnRef.current = mod.default;
      }
      if (!cancelled) {
        setResult(zxcvbnRef.current(password));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [password]);

  if (!password) return null;

  const score = result?.score ?? 0;
  const colors = SCORE_COLORS[score];
  const scoreLabels = [
    t("passwordStrength.veryWeak"),
    t("passwordStrength.weak"),
    t("passwordStrength.acceptable"),
    t("passwordStrength.strong"),
    t("passwordStrength.veryStrong"),
  ];
  const isTooShort = password.length < minLength;
  const labelColor = isTooShort ? "text-destructive" : colors.textColor;

  // Collect feedback
  const feedback: string[] = [];
  if (isTooShort) {
    feedback.push(t("passwordStrength.minLength", { count: minLength }));
  }
  if (result?.feedback?.warning) {
    feedback.push(translate(result.feedback.warning));
  }
  if (result?.feedback?.suggestions) {
    feedback.push(...result.feedback.suggestions.map(translate));
  }

  return (
    <div className="space-y-1.5">
      {/* Bar segments */}
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cn(
              "h-1.5 flex-1 rounded-full transition-colors",
              i <= score && !isTooShort ? colors.color : "bg-muted",
            )}
          />
        ))}
      </div>

      {/* Label */}
      <div className="flex items-center justify-between">
        <span className={cn("text-xs font-medium", labelColor)}>
          {isTooShort ? t("passwordStrength.tooShort") : scoreLabels[score]}
        </span>
        <span className="text-muted-foreground text-xs">
          {password.length}/{minLength}+ {t("passwordStrength.characters")}
        </span>
      </div>

      {/* Feedback */}
      {feedback.length > 0 && (
        <ul className="text-muted-foreground space-y-0.5 text-xs">
          {feedback.map((f, i) => (
            <li key={i}>• {f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
