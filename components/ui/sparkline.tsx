"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import type { RatingChangeEntry } from "@/lib/types";

/**
 * A rating history, as a line.
 *
 * `PlayerStats.ratingHistory` has been recorded since ratings were added — the
 * rating test is even named "rating history records the game, so the profile can
 * chart it" — and nothing ever drew it. The numbers were all there; the profile
 * showed a single current rating and threw the shape of how it got there away.
 *
 * Deliberately not a charting library: this is one polyline over a handful of
 * points, and a dependency for it would outweigh the drawing.
 */

/** Viewbox units. The drawing is stretched to whatever box the caller gives it. */
const W = 100;
const H = 32;
/** Keeps the stroke and the end cap clear of the edges of the viewbox. */
const PAD = 3;

/**
 * Rating after each game, oldest first — the series a chart wants, from the
 * newest-first record the server keeps.
 *
 * The opening point is the *before* rating of the earliest game, so a player
 * with a single rated game gets a line (where they started, where they landed)
 * rather than one lonely dot.
 */
export function ratingSeries(history: RatingChangeEntry[]): number[] {
  if (history.length === 0) return [];
  const oldestFirst = [...history].reverse();
  return [
    oldestFirst[0].ratingBefore,
    ...oldestFirst.map((h) => h.ratingAfter),
  ];
}

export function Sparkline({
  values,
  className,
  label,
}: {
  /** Oldest first. Fewer than two points is not a line — renders nothing. */
  values: number[];
  className?: string;
  /** Screen-reader description; the drawing itself carries no text. */
  label?: string;
}) {
  /* One gradient id per instance. Two sparklines on a page sharing a hardcoded
     id would both resolve to whichever <defs> the browser parsed last. */
  const gradientId = useId();

  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const last = values.length - 1;

  const x = (i: number) => PAD + (i * (W - PAD * 2)) / last;
  /* A player whose rating never moved has no range to scale against, so the
     line is drawn down the middle rather than dividing by zero. */
  const y = (v: number) =>
    span === 0 ? H / 2 : H - PAD - ((v - min) / span) * (H - PAD * 2);

  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const rising = values[last] >= values[0];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      /* Stretched to fill the caller's box: a sparkline that letterboxed itself
         to keep 100:32 would leave the trend floating in dead space. The stroke
         is held to its own scale below, so a wide short box doesn't smear it. */
      preserveAspectRatio="none"
      role="img"
      aria-label={label ?? `Rating history, ${values[0]} to ${values[last]}`}
      /* The trend colour is set here, on the root, and not on the shapes: a
         gradient stop's `currentColor` resolves against the gradient element's
         own inherited colour, so colouring the <polygon> would leave the fill
         resolving against nothing. */
      className={cn(
        "h-8 w-full overflow-visible",
        rising ? "text-primary" : "text-negative",
        className,
      )}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.18} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>

      <polygon
        /* The fill is the line closed against the baseline, so it reads as
           weight under the trend rather than as a second shape. */
        points={`${x(0)},${H} ${points} ${x(last)},${H}`}
        fill={`url(#${gradientId})`}
      />
      <polyline
        points={points}
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        className="stroke-current"
      />
      {/* The latest rating, marked. A <circle> would be stretched into an
          ellipse by the aspect ratio above, so this is a zero-length subpath
          with a round cap — spec-guaranteed to render, and a non-scaling stroke
          keeps it perfectly round at any box size. */}
      <path
        d={`M ${x(last)},${y(values[last])} L ${x(last)},${y(values[last])}`}
        strokeWidth={4}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        className="stroke-current"
      />
    </svg>
  );
}
