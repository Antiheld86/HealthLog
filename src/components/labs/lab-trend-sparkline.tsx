"use client";

/**
 * v1.17.1 — minimal inline trend sparkline for an analyte's readings.
 *
 * A dependency-free 72×20 SVG polyline. This is DELIBERATELY a different
 * implementation from the detail page's Recharts `<LabBiomarkerChart>`: a
 * list row renders one tiny, axis-less, tooltip-less, interaction-less trend
 * per group (dozens on screen at once), where mounting a Recharts
 * `ResponsiveContainer` each would be heavy and visually noisy. The full
 * interactive chart — axes, reference band, range tabs, rich tooltip — lives
 * only on the single-biomarker detail surface. The same split (inline
 * polyline vs Recharts) is used by the doctor-report PDF. The two are not
 * drift; do not unify them.
 *
 * Rendered only when an analyte has ≥ 2 NUMERIC readings. The calm neutral
 * line preserves the compact graph, while each reading uses the adjacent
 * reference-range bar's semantic colour.
 *
 * `values` are passed oldest → newest. v1.18.9 — qualitative readings carry no
 * number (`null`); they are filtered out here so a series with qualitative
 * entries plots only its numeric points and never a NaN.
 */
export function LabTrendSparkline({
  values: rawValues,
  referenceLow = null,
  referenceHigh = null,
  width = 72,
  height = 20,
}: {
  values: (number | null)[];
  referenceLow?: number | null;
  referenceHigh?: number | null;
  width?: number;
  height?: number;
}) {
  const values = rawValues.filter((v): v is number => v !== null);
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const pad = 2;
  const usableH = height - pad * 2;

  const points = values.map((v, i) => {
    const x = i * stepX;
    // Invert Y so a higher value sits higher on screen.
    const y = pad + usableH - ((v - min) / span) * usableH;
    return { value: v, x, y };
  });
  const polylinePoints = points
    .map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const isValidRange =
    referenceLow !== null &&
    referenceHigh !== null &&
    referenceLow < referenceHigh;
  const pointClassName = (value: number) => {
    if (isValidRange) {
      if (value < referenceLow) return "fill-info";
      if (value > referenceHigh) return "fill-warning";
      return "fill-success";
    }
    // Each one-sided branch requires the OTHER bound to be absent. Without
    // that, a present-but-impossible pair (floor at or above ceiling) reads as
    // "minimum only" and paints a high value green — the wrong direction for a
    // transcription error to fail in. Falling through to the neutral dot
    // matches `lab-reference-range-bar.tsx`, which renders nothing at all for
    // the same input: a range that cannot be true earns no verdict.
    if (referenceLow !== null && referenceHigh === null) {
      return value < referenceLow ? "fill-info" : "fill-success";
    }
    if (referenceHigh !== null && referenceLow === null) {
      return value > referenceHigh ? "fill-warning" : "fill-success";
    }
    return "fill-muted-foreground";
  };

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
      aria-hidden
      role="presentation"
    >
      <polyline
        points={polylinePoints}
        fill="none"
        className="stroke-muted-foreground"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map(({ value, x, y }, index) => (
        <rect
          key={index}
          x={x - 2}
          y={y - 4}
          width={4}
          height={8}
          rx={1}
          className={pointClassName(value)}
        />
      ))}
    </svg>
  );
}
