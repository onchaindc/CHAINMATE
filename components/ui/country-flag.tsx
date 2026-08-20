"use client";

import { useEffect, useState } from "react";
import { countryName, flagFor } from "@/lib/countries";
import { cn } from "@/lib/utils";

/**
 * A player's country marker.
 *
 * Emoji flags are regional-indicator letter pairs (US = 🇺🇸 = "U"+"S"), and
 * they only look like flags if the platform ships flag glyphs. Windows does
 * not: Segoe UI Emoji has no country flags, so Chrome/Edge on desktop fall
 * back to rendering the two letters. That is why flags appeared on phones but
 * showed as bare initials on PC — the app was emitting the same characters in
 * both places and only mobile could draw them.
 *
 * So: detect support once, then render a real flag where one exists and a
 * deliberate ISO-code chip where it does not. The chip is a designed element
 * rather than accidental fallback text, so desktop reads as intentional
 * instead of broken.
 */

type FlagSupport = "unknown" | "yes" | "no";

let cachedSupport: FlagSupport = "unknown";

/**
 * Can this browser draw emoji flags? A supported platform composes the two
 * regional indicators into ONE glyph, so the pair measures narrower than the
 * two indicators drawn separately. Windows draws two letter boxes, so the
 * widths match. Measured once per page load and cached.
 */
function detectFlagSupport(): FlagSupport {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return "no";
    ctx.font = "16px sans-serif";
    const pair = ctx.measureText("\u{1F1FA}\u{1F1F8}").width; // 🇺🇸
    const single = ctx.measureText("\u{1F1FA}").width; // 🇺 alone
    if (!pair || !single) return "no";
    // Composed into one flag glyph → clearly narrower than two indicators.
    return pair < single * 1.5 ? "yes" : "no";
  } catch {
    return "no";
  }
}

interface CountryFlagProps {
  /** ISO 3166-1 alpha-2 code. Renders nothing when absent or malformed. */
  code?: string | null;
  className?: string;
}

export function CountryFlag({ code, className }: CountryFlagProps) {
  // Start in the code-chip form: it is what the server renders, so the first
  // client paint matches and hydration stays clean. The upgrade to a real
  // flag happens in the effect below, after hydration.
  const [support, setSupport] = useState<FlagSupport>(cachedSupport);

  useEffect(() => {
    if (cachedSupport === "unknown") cachedSupport = detectFlagSupport();
    setSupport(cachedSupport);
  }, []);

  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;

  const upper = code.toUpperCase();
  const label = countryName(upper) ?? upper;

  if (support === "yes") {
    return (
      <span
        className={cn("shrink-0 text-sm leading-none", className)}
        title={label}
        aria-label={label}
        role="img"
      >
        {flagFor(upper)}
      </span>
    );
  }

  return (
    <span
      className={cn(
        "shrink-0 rounded-[3px] border border-border/70 bg-secondary/70 px-1 py-px font-mono text-[9px] font-semibold uppercase leading-[1.35] tracking-wide text-muted-foreground",
        className,
      )}
      title={label}
      aria-label={label}
    >
      {upper}
    </span>
  );
}
