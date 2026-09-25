"use client";

import { useId } from "react";
import { cn } from "@/lib/utils";
import { aiLevelFor } from "@/lib/types";

/**
 * The bots' faces.
 *
 * Every opponent in the ChainMate Grandmaster roster wears a classic painted
 * portrait — a bust in a circular frame, shaded with layered gradients the
 * way old chess-program opponents (and chess.com's own bots) are drawn, so a
 * bot reads as a CHARACTER you can lose to, not a gear icon. Each level keeps
 * its own palette and headwear, following the strength ladder upward:
 * a student's cap, a scarf, a headband, dark shades, a circlet, a crown, a
 * hood — and, at the very top, the fish itself.
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
  /** Backdrop glow, centre → edge. */
  bg: [string, string];
  /** Clothing, lit → shaded. */
  cloth: [string, string];
  /** Skin, lit → shaded (ignored for the fish). */
  skin: [string, string];
  /** Headwear / signature accent. */
  accent: [string, string];
}

const PALETTES: Record<string, Palette> = {
  // Pawn — the student: warm study-room green, flat cap.
  beginner: { bg: ["#EAF3E2", "#B7CEA4"], cloth: ["#5B7F4A", "#3C5A31"], skin: ["#F3C9A5", "#D9A276"], accent: ["#7BA05B", "#54763C"] },
  // Nova — the optimist: bright amber, scarf.
  casual: { bg: ["#FDF0DC", "#EBBE8A"], cloth: ["#D97B29", "#A85615"], skin: ["#F3C9A5", "#D9A276"], accent: ["#E89A3C", "#B96A1D"] },
  // Atlas — the club player: steady blue, sweatband.
  club: { bg: ["#DDEBF7", "#93B8D9"], cloth: ["#33628F", "#1F4568"], skin: ["#EDB98B", "#C98F60"], accent: ["#4A7FAE", "#2C5680"] },
  // Onyx — the tactician: violet night, dark shades.
  advanced: { bg: ["#E6DFF3", "#A58FCB"], cloth: ["#4B3577", "#2F2050"], skin: ["#E8B088", "#BE7F55"], accent: ["#241B3A", "#120D20"] },
  // Zenith — the master: deep teal robes, gold circlet.
  expert: { bg: ["#D8EEEA", "#8FC4BC"], cloth: ["#1F6E63", "#124A42"], skin: ["#E8B088", "#BE7F55"], accent: ["#E7C46A", "#B08D3A"] },
  // Sovereign — the regent: royal purple mantle, full gold crown.
  sovereign: { bg: ["#EBDFF5", "#B493D3"], cloth: ["#5E2F87", "#3D1C5C"], skin: ["#E8B088", "#BE7F55"], accent: ["#F0CE6E", "#BC9238"] },
  // Apex — the hooded grandmaster: near-black hood, gold clasp.
  apex: { bg: ["#E3E0DA", "#9B948A"], cloth: ["#2B2B31", "#141419"], skin: ["#D9A87E", "#AE7A50"], accent: ["#D9B45C", "#A57F2E"] },
  // Stockfish — the fish: cold steel-water, the engine itself.
  stockfish: { bg: ["#DDEEF2", "#7FB4C4"], cloth: ["#3E7E96", "#24536A"], skin: ["#BFD9E2", "#8FB6C4"], accent: ["#E7C46A", "#B08D3A"] },
};

/** The generic palette for an unknown level id. */
const FALLBACK = PALETTES.beginner!;

export function BotAvatar({ level, size = "sm", className }: BotAvatarProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const p = PALETTES[level ?? ""] ?? FALLBACK;
  const isFish = level === "stockfish";
  const bgId = `bg${uid}`;
  const clothId = `cl${uid}`;
  const skinId = `sk${uid}`;
  const accentId = `ac${uid}`;

  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={aiLevelFor(level ?? undefined).name}
      className={cn("shrink-0 select-none rounded-full shadow-elevation-1 ring-1 ring-border/60", SIZES[size], className)}
    >
      <defs>
        <radialGradient id={bgId} cx="38%" cy="30%" r="80%">
          <stop offset="0%" stopColor={p.bg[0]} />
          <stop offset="100%" stopColor={p.bg[1]} />
        </radialGradient>
        <linearGradient id={clothId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={p.cloth[0]} />
          <stop offset="100%" stopColor={p.cloth[1]} />
        </linearGradient>
        <linearGradient id={skinId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={p.skin[0]} />
          <stop offset="100%" stopColor={p.skin[1]} />
        </linearGradient>
        <linearGradient id={accentId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={p.accent[0]} />
          <stop offset="100%" stopColor={p.accent[1]} />
        </linearGradient>
      </defs>

      {/* Portrait backdrop */}
      <circle cx="32" cy="32" r="32" fill={`url(#${bgId})`} />
      {/* Ground shadow behind the bust */}
      <ellipse cx="32" cy="58" rx="24" ry="8" fill="#000" opacity="0.14" />

      {isFish ? (
        <g>
          {/* The fish — engine-shaped, engine-coloured */}
          <path
            d="M10 34c6-10 18-16 30-13 7 2 12 6 14 11 1 3-2 6-6 8-9 5-24 5-33-2-3-2-5-3-5-4z"
            fill={`url(#${clothId})`}
          />
          <path d="M10 34l-4-8 6 2 1-7 5 6z" fill={`url(#${accentId})`} />
          <path d="M34 22c4-5 9-6 13-5-2 3-5 5-8 6z" fill={`url(#${accentId})`} opacity="0.85" />
          <circle cx="46" cy="31" r="3.4" fill="#fff" />
          <circle cx="47" cy="31" r="1.7" fill="#101418" />
          <path d="M22 40c6 3 14 3 20 0" stroke="#101418" strokeOpacity="0.25" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <ellipse cx="18" cy="30" rx="9" ry="4" fill="#fff" opacity="0.16" />
        </g>
      ) : (
        <g>
          {/* Shoulders / robe */}
          <path
            d="M12 64c1-13 9-20 20-20s19 7 20 20z"
            fill={`url(#${clothId})`}
          />
          {/* Collar shadow */}
          <path d="M24 46c2 4 5 6 8 6s6-2 8-6c-2-1-5-2-8-2s-6 1-8 2z" fill="#000" opacity="0.18" />
          {/* Head */}
          <ellipse cx="32" cy="30" rx="12.5" ry="14" fill={`url(#${skinId})`} />
          {/* Ears */}
          <circle cx="19.5" cy="31" r="3" fill={`url(#${skinId})`} />
          <circle cx="44.5" cy="31" r="3" fill={`url(#${skinId})`} />
          {/* Eyes + brows (calm, classic) */}
          <circle cx="27" cy="31" r="1.7" fill="#1F1A16" />
          <circle cx="37" cy="31" r="1.7" fill="#1F1A16" />
          <path d="M24.5 27.5c1.5-1.2 3.5-1.2 5 0M34.5 27.5c1.5-1.2 3.5-1.2 5 0" stroke="#1F1A16" strokeOpacity="0.55" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          {/* Nose + mouth */}
          <path d="M32 32.5v4.5" stroke="#000" strokeOpacity="0.22" strokeWidth="1.4" strokeLinecap="round" />
          <path d="M28.5 40c2 1.6 5 1.6 7 0" stroke="#000" strokeOpacity="0.4" strokeWidth="1.5" fill="none" strokeLinecap="round" />
          {/* Cheek light — the painted-portrait sheen */}
          <ellipse cx="26" cy="25" rx="6" ry="4" fill="#fff" opacity="0.18" />
          {headwear(level, accentId)}
        </g>
      )}
      {/* Frame vignette */}
      <circle cx="32" cy="32" r="31" fill="none" stroke="#000" strokeOpacity="0.12" strokeWidth="2" />
    </svg>
  );
}

/** The per-level signature: headwear drawn over the shared face. */
function headwear(level: string | null | undefined, id: string) {
  switch (level) {
    case "beginner": // the student's flat cap
      return (
        <g>
          <path d="M19 24c1-8 6-13 13-13s12 5 13 13c-8 2-18 2-26 0z" fill={`url(#${id})`} />
          <path d="M18 24c9 2 19 2 28 0 1 2-1 3-3 3-7 1-15 1-22 0-2 0-4-1-3-3z" fill="#000" opacity="0.22" />
        </g>
      );
    case "casual": // windswept fringe + the scarf at the shoulders
      return (
        <g>
          <path d="M20 26c0-9 5-15 12-15s12 6 12 15c-3-4-7-6-12-6s-9 2-12 6z" fill="#6B4A2F" />
          <path d="M14 50c4-3 8-4 12-3l-2 6c-4-1-7-1-10 3z" fill={`url(#${id})`} />
        </g>
      );
    case "club": // sweatband over short hair
      return (
        <g>
          <path d="M20 25c0-8 5-14 12-14s12 6 12 14c-8-3-16-3-24 0z" fill="#3A2A1E" />
          <rect x="19" y="23" width="26" height="4.5" rx="2.2" fill={`url(#${id})`} />
        </g>
      );
    case "advanced": // slicked back + the dark shades
      return (
        <g>
          <path d="M20 24c1-9 5-14 12-14s11 5 12 14c-8-2-16-2-24 0z" fill="#17141C" />
          <path d="M21.5 30h9l1.5 2.5 1.5-2.5h9c.8 0 1.4.8 1.2 1.7l-.8 3.3c-.4 1.7-2 3-3.8 3h-4.4c-1.4 0-2.6-.9-3-2.2l-.2-.8c-.2-.8-1.4-.8-1.6 0l-.2.8c-.4 1.3-1.6 2.2-3 2.2h-4.4c-1.8 0-3.4-1.3-3.8-3l-.8-3.3c-.2-.9.4-1.7 1.2-1.7z" fill={`url(#${id})`} />
        </g>
      );
    case "expert": // the gold circlet
      return (
        <g>
          <path d="M20 24c0-8 5-14 12-14s12 6 12 14c-8-3-16-3-24 0z" fill="#4A3826" />
          <rect x="20" y="21.5" width="24" height="4" rx="2" fill={`url(#${id})`} />
          <circle cx="32" cy="20" r="2" fill={`url(#${id})`} />
        </g>
      );
    case "sovereign": // the full crown
      return (
        <g>
          <path d="M19 22l2-11 5 5 6-8 6 8 5-5 2 11c-8-3-18-3-26 0z" fill={`url(#${id})`} />
          <rect x="19" y="21" width="26" height="4" rx="2" fill={`url(#${id})`} />
          <circle cx="32" cy="23" r="1.8" fill="#8F2F3B" />
          <circle cx="24" cy="23" r="1.4" fill="#2F5E8F" />
          <circle cx="40" cy="23" r="1.4" fill="#2F5E8F" />
        </g>
      );
    case "apex": // the hood
      return (
        <g>
          <path d="M32 8c11 0 18 9 18 22l-3 6c-1-10-6-16-15-16s-14 6-15 16l-3-6C14 17 21 8 32 8z" fill={`url(#${id})`} />
          <path d="M20 33c2-7 6-11 12-11s10 4 12 11c-7-4-17-4-24 0z" fill="#000" opacity="0.35" />
          <circle cx="32" cy="44" r="1.8" fill={`url(#${id})`} />
        </g>
      );
    default: // unknown level: a neutral bot band
      return <rect x="20" y="22" width="24" height="4" rx="2" fill={`url(#${id})`} />;
  }
}
