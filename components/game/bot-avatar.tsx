"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import { aiLevelFor } from "@/lib/types";

/**
 * The bots' faces — modern, dimensional, detailed.
 *
 * Rebuilt from the flat busts after feedback: each portrait is now composed
 * like a modern game-avatar render — a lit environment behind the character,
 * a cast shadow, layered hair/headwear drawn OVER the head (never clipped
 * by it), facial structure with cheek/jaw shading, specular eye highlights,
 * and rim light on the collar. Every level keeps its own identity: palette,
 * headwear, and expression grow with the strength ladder.
 */

interface BotAvatarProps {
  /** The level id ("beginner" … "apex", "stockfish"). Unknown → generic bot. */
  level?: string | null;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}

const SIZES = {
  xs: "h-4 w-4",
  sm: "h-7 w-7",
  md: "h-9 w-9",
  lg: "h-14 w-14",
} as const;

interface Palette {
  /** Environment backdrop, top light → bottom depth. */
  bg: [string, string, string];
  /** Clothing, lit → shaded. */
  cloth: [string, string];
  /** Skin, highlight → base → shadow. */
  skin: [string, string, string];
  /** Headwear / signature accent, lit → shaded. */
  accent: [string, string];
  /** Hair colour. */
  hair: string;
  /** Rim light colour. */
  rim: string;
}

const PALETTES: Record<string, Palette> = {
  // Pawn — the student: study green, flat cap, friendly round face.
  beginner: {
    bg: ["#DCEBD0", "#B9D3A4", "#7E9E68"],
    cloth: ["#5F8A4C", "#3A5A2E"],
    skin: ["#F7D2AC", "#EAB489", "#C98F63"],
    accent: ["#86AC66", "#5B7E42"],
    hair: "#4A3626",
    rim: "#F2FFDF",
  },
  // Nova — the optimist: amber energy, swept hair, bright grin.
  casual: {
    bg: ["#FFEFD3", "#F0C48E", "#C08B4E"],
    cloth: ["#E0842B", "#A85414"],
    skin: ["#F7D2AC", "#EAB489", "#C98F63"],
    accent: ["#F2A84B", "#BC6F1D"],
    hair: "#6B4226",
    rim: "#FFE9C4",
  },
  // Atlas — the club player: focused blue, sweatband, set jaw.
  club: {
    bg: ["#D7E8F7", "#9DBEDD", "#5F87AC"],
    cloth: ["#2F6090", "#1C3F63"],
    skin: ["#F2C79D", "#E3AC7F", "#BD8355"],
    accent: ["#5D93C4", "#33608D"],
    hair: "#2E2015",
    rim: "#DFF1FF",
  },
  // Onyx — the tactician: violet night, dark shades, cool smirk.
  advanced: {
    bg: ["#E3DCF4", "#A793CC", "#6D559B"],
    cloth: ["#46306F", "#291C48"],
    skin: ["#EFC295", "#DFA97B", "#B57C4F"],
    accent: ["#1E1730", "#0C0918"],
    hair: "#141020",
    rim: "#E9DFFF",
  },
  // Zenith — the master: teal robes, gold circlet, serene.
  expert: {
    bg: ["#D3EDE7", "#93C8BE", "#5B948A"],
    cloth: ["#17685C", "#0C443C"],
    skin: ["#EFC295", "#DFA97B", "#B57C4F"],
    accent: ["#F1CF77", "#B38B37"],
    hair: "#3A2C1C",
    rim: "#D9FFF4",
  },
  // Sovereign — the regent: purple mantle, full crown, regal calm.
  sovereign: {
    bg: ["#EBDEF6", "#B795D6", "#7E5AA6"],
    cloth: ["#5B2C85", "#381A57"],
    skin: ["#EFC295", "#DFA97B", "#B57C4F"],
    accent: ["#F6D67E", "#BE9134"],
    hair: "#241A10",
    rim: "#F3E4FF",
  },
  // Apex — the hooded grandmaster: near-black hood, sharp gaze, gold clasp.
  apex: {
    bg: ["#E2DFD8", "#A29A8D", "#655E52"],
    cloth: ["#26262D", "#101014"],
    skin: ["#E3B88F", "#CE9A6B", "#A26C42"],
    accent: ["#E3BC5F", "#A87E2C"],
    hair: "#141419",
    rim: "#FFEFC2",
  },
  // Stockfish — the engine: cold water, chrome sheen, the fish itself.
  stockfish: {
    bg: ["#D9EDF4", "#84B8CA", "#4B8299"],
    cloth: ["#3A7A93", "#1F4B61"],
    skin: ["#C6DEE8", "#9CC0CD", "#6D97A6"],
    accent: ["#F1CF77", "#B38B37"],
    hair: "#5E8694",
    rim: "#E4F7FF",
  },
};

/** The generic palette for an unknown level id. */
const FALLBACK = PALETTES.beginner!;

export function BotAvatar({ level, size = "sm", className }: BotAvatarProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const p = PALETTES[level ?? ""] ?? FALLBACK;
  const isFish = level === "stockfish";
  const bgId = `bg${uid}`;
  const clothId = `cl${uid}`;
  const clothDeepId = `cd${uid}`;
  const skinId = `sk${uid}`;
  const accentId = `ac${uid}`;
  const rimId = `rm${uid}`;
  const faceShadeId = `fs${uid}`;

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={aiLevelFor(level ?? undefined).name}
      className={cn("shrink-0 select-none rounded-full shadow-elevation-1 ring-1 ring-border/50", SIZES[size], className)}
    >
      <defs>
        {/* Environment: three-stop sky, light source top-left */}
        <linearGradient id={bgId} x1="0.2" y1="0" x2="0.6" y2="1">
          <stop offset="0%" stopColor={p.bg[0]} />
          <stop offset="55%" stopColor={p.bg[1]} />
          <stop offset="100%" stopColor={p.bg[2]} />
        </linearGradient>
        {/* Cloth with a soft top-light falloff */}
        <linearGradient id={clothId} x1="0.3" y1="0" x2="0.5" y2="1">
          <stop offset="0%" stopColor={p.cloth[0]} />
          <stop offset="100%" stopColor={p.cloth[1]} />
        </linearGradient>
        <linearGradient id={clothDeepId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={p.cloth[1]} />
          <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
        </linearGradient>
        {/* Skin: highlight → base → shadow */}
        <linearGradient id={skinId} x1="0.25" y1="0.1" x2="0.7" y2="1">
          <stop offset="0%" stopColor={p.skin[0]} />
          <stop offset="55%" stopColor={p.skin[1]} />
          <stop offset="100%" stopColor={p.skin[2]} />
        </linearGradient>
        <linearGradient id={accentId} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor={p.accent[0]} />
          <stop offset="100%" stopColor={p.accent[1]} />
        </linearGradient>
        {/* Rim light along the silhouette */}
        <linearGradient id={rimId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={p.rim} />
          <stop offset="100%" stopColor={p.rim} stopOpacity="0" />
        </linearGradient>
        {/* Ambient occlusion where the head meets the collar */}
        <radialGradient id={faceShadeId} cx="0.5" cy="0.42" r="0.65">
          <stop offset="60%" stopColor="#000" stopOpacity="0" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.22" />
        </radialGradient>
      </defs>

      {/* Environment + floor shadow */}
      <circle cx="32" cy="32" r="32" fill={`url(#${bgId})`} />
      <ellipse cx="32" cy="60" rx="26" ry="7.5" fill="#000" opacity="0.18" />

      {isFish ? (
        <g>
          {/* The engine: layered chrome fish, fin highlights, water gleam */}
          <ellipse cx="30" cy="38" rx="24" ry="9" fill="#fff" opacity="0.14" />
          <path
            d="M8 35c5.5-11 17.5-17.5 30.5-14.5 7.5 1.8 13 6 15.2 11.2 1.2 2.8-1.6 6-6 8.2-9.5 5-25.5 5.5-35-1.2-2.6-1.8-4.2-2.7-4.7-3.7z"
            fill={`url(#${clothId})`}
          />
          <path
            d="M8 35c5.5-11 17.5-17.5 30.5-14.5-9 3.5-16 9.5-19.5 17.5-4.5-0.6-8.5-1.6-11-3z"
            fill="#fff"
            opacity="0.14"
          />
          <path d="M9 35l-4.5-9.5 7 2.4 1.4-8 5.8 6.8z" fill={`url(#${accentId})`} />
          <path d="M33 21.5c4.5-5.6 10-7 14.5-5.8-2.4 3.3-5.6 5.6-9 6.9z" fill={`url(#${accentId})`} opacity="0.9" />
          <path d="M22 44.5c7 3.2 16 3.2 23-0.2" stroke="#0E1418" strokeOpacity="0.3" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          {/* Gill + scale glints */}
          <path d="M40 26.5c-2.5 3-3.5 6.5-3 10" stroke="#0E1418" strokeOpacity="0.35" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <circle cx="24" cy="31" r="1.1" fill="#fff" opacity="0.55" />
          <circle cx="29" cy="28" r="0.9" fill="#fff" opacity="0.4" />
          <circle cx="47" cy="30.5" r="3.6" fill="#F7FBFC" />
          <circle cx="48" cy="30.7" r="1.9" fill="#0E1418" />
          <circle cx="47.2" cy="29.8" r="0.7" fill="#fff" />
          {/* Rim light on the back */}
          <path d="M14 25.5c6-5.5 13.5-8 21-7.8" stroke={`url(#${rimId})`} strokeWidth="1.6" fill="none" strokeLinecap="round" opacity="0.8" />
        </g>
      ) : (
        <g>
          {/* Shoulders: robe with layered collar and cast shadow under the chin */}
          <path d="M10.5 64c1.2-13.5 9.5-21 21.5-21s20.3 7.5 21.5 21z" fill={`url(#${clothId})`} />
          <path d="M10.5 64c1.2-13.5 9.5-21 21.5-21h.4C21.5 44.5 15 51 14 64z" fill="#fff" opacity="0.10" />
          <path d="M10.5 64c.6-6.6 2.8-11.8 6.6-15.6L32 58l14.9-9.6c3.8 3.8 6 9 6.6 15.6z" fill={`url(#${clothDeepId})`} opacity="0.5" />
          {/* Collar opening with ambient occlusion behind the neck */}
          <path d="M23 44c2.4 4.6 5.6 7 9 7s6.6-2.4 9-7c-2.4-1.2-5.6-1.9-9-1.9s-6.6.7-9 1.9z" fill="#000" opacity="0.22" />
          <path d="M23.6 44.6c2.2 4.2 5.1 6.4 8.4 6.4s6.2-2.2 8.4-6.4l-1.5-.9c-1.9 3.4-4.2 5.3-6.9 5.3s-5-1.9-6.9-5.3z" fill="#fff" opacity="0.12" />

          {/* Neck */}
          <path d="M28.5 40.5h7v6c0 1.9-1.6 3.4-3.5 3.4s-3.5-1.5-3.5-3.4z" fill={p.skin[2]} />
          <path d="M28.5 40.5h7v2.6c-1.1.8-2.3 1.2-3.5 1.2s-2.4-.4-3.5-1.2z" fill="#000" opacity="0.18" />

          {/* Head: structured skull + jaw, shaded */}
          <path
            d="M32 12.5c7.6 0 13.4 5.9 13.4 14.2 0 5.2-1.5 9.8-4.2 12.9-2.2 2.5-5.4 4-9.2 4s-7-1.5-9.2-4c-2.7-3.1-4.2-7.7-4.2-12.9 0-8.3 5.8-14.2 13.4-14.2z"
            fill={`url(#${skinId})`}
          />
          {/* Cheek structure: soft shadow along the right side */}
          <path d="M40.5 24c2 2.6 2.8 6 2.3 9.6-.4 3-1.7 5.5-3.6 7.2 2.4-1.4 4.4-3.7 5.6-6.8.9-2.3 1.3-4.9 1.2-7.6-1.6-1.2-3.5-2-5.5-2.4z" fill="#000" opacity="0.10" />
          {/* Forehead highlight */}
          <ellipse cx="28" cy="21.5" rx="6.5" ry="4" fill="#fff" opacity="0.20" />

          {/* Ears with inner shading */}
          <path d="M18.8 29.5c-1.8-.3-3.3.8-3.4 2.6-.1 1.9 1.2 3.5 3 3.7" fill={p.skin[1]} />
          <path d="M18.8 29.5c-1.8-.3-3.3.8-3.4 2.6" fill="none" stroke="#000" strokeOpacity="0.15" strokeWidth="1" />
          <path d="M45.2 29.5c1.8-.3 3.3.8 3.4 2.6.1 1.9-1.2 3.5-3 3.7" fill={p.skin[1]} />
          <path d="M45.2 29.5c1.8-.3 3.3.8 3.4 2.6" fill="none" stroke="#000" strokeOpacity="0.15" strokeWidth="1" />

          {/* Brows, eyes with specular catchlights, nose, mouth */}
          <path d="M24.2 27.3c1.7-1.5 4.2-1.7 6-.6" stroke={p.hair} strokeWidth="1.7" fill="none" strokeLinecap="round" />
          <path d="M33.8 26.7c1.8-1.1 4.3-.9 6 .6" stroke={p.hair} strokeWidth="1.7" fill="none" strokeLinecap="round" />
          <ellipse cx="27.2" cy="31.2" rx="2.1" ry="2.3" fill="#fff" />
          <ellipse cx="36.8" cy="31.2" rx="2.1" ry="2.3" fill="#fff" />
          <circle cx="27.4" cy="31.4" r="1.15" fill="#221A14" />
          <circle cx="37" cy="31.4" r="1.15" fill="#221A14" />
          <circle cx="26.9" cy="30.8" r="0.42" fill="#fff" />
          <circle cx="36.5" cy="30.8" r="0.42" fill="#fff" />
          <path d="M31.2 31.5c-.3 2-.6 3.6-1.4 4.7-.4.6-.1 1.2.6 1.2h3.2" stroke={p.skin[2]} strokeWidth="1.3" fill="none" strokeLinecap="round" />
          <path d="M28.6 41.2c2.1 1.7 4.7 1.7 6.8 0" stroke="#7A4B33" strokeOpacity="0.75" strokeWidth="1.6" fill="none" strokeLinecap="round" />

          {/* Per-level headwear + hair, drawn over the head */}
          {headwear(level, { accentId, hair: p.hair, rimId })}
          {/* Rim light down the right of the face */}
          <path d="M44.6 22.5c1 2.4 1.5 5 1.3 7.8-.2 3.3-1.3 6.3-3.1 8.6" stroke={`url(#${rimId})`} strokeWidth="1.4" fill="none" strokeLinecap="round" opacity="0.9" />
          {/* Global face shading to sit the head in the light */}
          <circle cx="32" cy="30" r="19" fill={`url(#${faceShadeId})`} />
        </g>
      )}
      {/* Frame: inner vignette + hairline */}
      <circle cx="32" cy="32" r="30.5" fill="none" stroke="#000" strokeOpacity="0.10" strokeWidth="3" />
    </svg>
  );
}

/** Headwear signature per level, layered over the shared structured face. */
function headwear(
  level: string | null | undefined,
  p: { accentId: string; hair: string; rimId: string },
) {
  switch (level) {
    case "beginner": // the student's flat cap
      return (
        <g>
          <path d="M20.5 22.5c1.2-8.5 5.6-13.5 11.5-13.5s10.3 5 11.5 13.5c-7.6 2.2-15.4 2.2-23 0z" fill={`url(#${p.accentId})`} />
          <path d="M20.5 22.5c-1.6.4-2.6 1.4-2.4 2.4.3 1.4 2.2 2.2 5 2.4l21.8 1.6c2.8-.1 4.7-.9 5-2.3.2-1-.8-2-2.4-2.4-7.6 2.2-15.4 2.2-23 0z" fill="#000" opacity="0.28" />
          <path d="M21.5 20c1-6.5 4.6-10.5 10.5-10.5 3.4 0 6.2 1.4 8.2 3.8-6.2 1.4-12.4 3.4-18.7 6.7z" fill="#fff" opacity="0.16" />
        </g>
      );
    case "casual": // windswept fringe + scarf over the shoulder
      return (
        <g>
          <path d="M19.5 24.5c-.4-9.5 5-16.5 12.5-16.5s12.9 7 12.5 16.5c-1.4-2.3-2.5-4.4-3.4-6.6-1.9 1.9-4 2.8-6.6 2.6-1.4-2.1-2.4-3.6-3.4-5.4-3.6 3.4-7.4 6.4-11.6 9.4z" fill={p.hair} />
          <path d="M21 17.5c2.2-4.8 5.9-7.5 11-7.5 2.6 0 4.9.8 6.8 2.2-6 .8-11.8 2.4-17.8 5.3z" fill="#fff" opacity="0.13" />
          <path d="M13.5 51.5c4.2-3.6 8.6-4.8 13.2-3.6l-2.2 7c-4.4-1.2-7.8-.8-11 2.6z" fill={`url(#${p.accentId})`} />
          <path d="M15 50.6c3.6-2.6 7.3-3.6 11-2.8" stroke="#000" strokeOpacity="0.2" strokeWidth="1.2" fill="none" />
          <path d="M24.5 48l1.8 5.2" stroke="#000" strokeOpacity="0.18" strokeWidth="1.1" />
        </g>
      );
    case "club": // cropped hair + sweatband
      return (
        <g>
          <path d="M19.8 24c-.2-9 5.2-15.5 12.2-15.5S44.4 15 44.2 24c-8-3.4-16.4-3.4-24.4 0z" fill={p.hair} />
          <path d="M22.5 15.5C25 12.5 28.2 11 32 11c2.5 0 4.7.6 6.7 1.9-5.3.6-10.6 1.4-16.2 2.6z" fill="#fff" opacity="0.12" />
          <rect x="19" y="22" width="26" height="5" rx="2.5" fill={`url(#${p.accentId})`} />
          <path d="M19 24.5h26" stroke="#000" strokeOpacity="0.2" strokeWidth="1" />
          <path d="M44 22.5l3 1.5-3 1.5" fill={`url(#${p.accentId})`} stroke="#000" strokeOpacity="0.15" strokeWidth="0.8" />
        </g>
      );
    case "advanced": // slicked back + angled dark shades
      return (
        <g>
          <path d="M20 24c-.4-9.5 5-15 12-15s12.4 5.5 12 15c-1.6-2.6-2.4-4.6-3-7-2.4 1.5-4.8 2-7.4 1.6-1-1.7-1.8-3-2.6-4.4-3.2 3.6-6.8 6.8-11 9.8z" fill={p.hair} />
          <path d="M22.5 15.5C25 12.5 28.2 11 32 11c2.6 0 4.9.8 6.8 2.2-5.4.7-10.8 1.5-16.3 2.3z" fill="#fff" opacity="0.12" />
          {/* Shades: two angled lenses joined by a bridge */}
          <path d="M21 29h9.4l1.3 2.6 1.3-2.6H43c.9 0 1.6.9 1.4 1.9l-.9 3.6c-.5 1.9-2.2 3.3-4.2 3.3h-4.8c-1.6 0-3-1-3.5-2.5l-.3-.9c-.3-.9-1.5-.9-1.8 0l-.3.9c-.5 1.5-1.9 2.5-3.5 2.5h-4.8c-2 0-3.7-1.4-4.2-3.3l-.9-3.6c-.2-1 .5-1.9 1.4-1.9z" fill={`url(#${p.accentId})`} />
          <path d="M23.5 30.2h5.6l1 2-1.2 3.4c-1.2.3-2.6-.2-3.4-1.4-.9-1.2-1.6-2.6-2-4z" fill="#fff" opacity="0.16" />
          <path d="M36 30.2h5.8l-1 4.6c-.3 1-1.1 1.7-2.1 1.9" stroke="#fff" strokeOpacity="0.22" strokeWidth="1.1" fill="none" />
        </g>
      );
    case "expert": // long hair + the gold circlet with a set gem
      return (
        <g>
          <path d="M18.5 34c-1.5-4.5-1.8-9.5.2-14.5C20.8 14.4 25.6 11 32 11s11.2 3.4 13.3 8.5c2 5 1.7 10 .2 14.5-.6-3-1.2-5.5-2-8-8-3.2-15.9-3.2-23.9 0-.8 2.5-1.5 5-2.1 8z" fill={p.hair} />
          <path d="M19.5 22c2-5.6 6.4-9 12.5-9 2.9 0 5.5.8 7.7 2.3-6.6 1.2-13.2 3.4-20.2 6.7z" fill="#fff" opacity="0.11" />
          <rect x="20" y="20.5" width="24" height="4.4" rx="2.2" fill={`url(#${p.accentId})`} />
          <path d="M20.5 23h23" stroke="#000" strokeOpacity="0.18" strokeWidth="0.9" />
          <path d="M32 15.2l2 3.4-2 2-2-2z" fill={`url(#${p.accentId})`} stroke="#000" strokeOpacity="0.2" strokeWidth="0.7" />
          <circle cx="32" cy="18.6" r="0.9" fill="#fff" opacity="0.7" />
        </g>
      );
    case "sovereign": // the full crown with jewels, over swept hair
      return (
        <g>
          <path d="M19.5 25.5c-.5-5 .2-10 2.5-13 2 1.6 3.7 3 5.4 4.6C29.2 13 30.8 10 32 8.6c1.2 1.4 2.8 4.4 4.6 8.5 1.7-1.6 3.4-3 5.4-4.6 2.3 3 3 8 2.5 13-8-3.2-16-3.2-25 0z" fill={p.hair} />
          <path d="M19 21.5l1.8-10.4 5.6 5.2L32 8l5.6 8.3 5.6-5.2L45 21.5c-8.5-3.4-17.5-3.4-26 0z" fill={`url(#${p.accentId})`} />
          <path d="M19 21.5c8.5 3.4 17.5 3.4 26 0l.4 2.4c-.4 1-1.4 1.5-3 1.3-7-1.2-14-1.2-20.8 0-1.6.2-2.6-.3-3-1.3z" fill={`url(#${p.accentId})`} />
          <path d="M19.5 20c-.5-.5-.7-1.2-.5-2l1.6-9 4.4 4.1-2.4 7.5c-1 .1-2-.1-3.1-.6z" fill="#fff" opacity="0.18" />
          <circle cx="32" cy="19.5" r="1.7" fill="#8F2F3B" />
          <circle cx="31.5" cy="19" r="0.6" fill="#fff" opacity="0.75" />
          <circle cx="23.8" cy="20" r="1.3" fill="#2F5E8F" />
          <circle cx="23.5" cy="19.6" r="0.45" fill="#fff" opacity="0.75" />
          <circle cx="40.2" cy="20" r="1.3" fill="#2F8F5B" />
          <circle cx="39.9" cy="19.6" r="0.45" fill="#fff" opacity="0.75" />
        </g>
      );
    case "apex": // the hood: deep drape, shadowed face, gold clasp
      return (
        <g>
          <path d="M32 7.5c11.5 0 19 9.5 19 23.5l-3.2 7c-.4-11-6.3-17.5-15.8-17.5S16.6 27 16.2 38L13 31C13 17 20.5 7.5 32 7.5z" fill={`url(#${p.accentId})`} opacity="0.001" />
          <path d="M32 7.5c11.5 0 19 9.5 19 23.5l-3.2 7c-.4-11-6.3-17.5-15.8-17.5S16.6 27 16.2 38L13 31C13 17 20.5 7.5 32 7.5z" fill={`url(#${p.rimId})`} opacity="0.25" />
          <path d="M32 7.5c11.5 0 19 9.5 19 23.5l-3.2 7c-.4-11-6.3-17.5-15.8-17.5S16.6 27 16.2 38L13 31C13 17 20.5 7.5 32 7.5z" fill="#26262D" />
          <path d="M32 9.5c9.5 0 15.9 7.6 16.7 18.7-.9-9.4-6.9-15.2-16.7-15.2S16.2 18.8 15.3 28.2C16.1 17.1 22.5 9.5 32 9.5z" fill="#fff" opacity="0.10" />
          {/* Inner shadow across the eyes */}
          <path d="M20 33c2.3-7.3 6.3-11.3 12-11.3s9.7 4 12 11.3c-7.5-4.3-16.5-4.3-24 0z" fill="#000" opacity="0.4" />
          <path d="M21 31.5c2.2-6.5 6-10 11-10s8.8 3.5 11 10c-7-3.8-15-3.8-22 0z" fill="#000" opacity="0.35" />
          {/* Clasp */}
          <circle cx="32" cy="45.5" r="2" fill="#E3BC5F" />
          <circle cx="31.4" cy="44.9" r="0.7" fill="#FFF3D0" />
        </g>
      );
    default: // unknown level: a neutral band
      return <rect x="20" y="21.5" width="24" height="4.4" rx="2.2" fill={`url(#${p.accentId})`} />;
  }
}
