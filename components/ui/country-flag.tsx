"use client";

import { useState } from "react";
import { countryName } from "@/lib/countries";
import { cn } from "@/lib/utils";

/**
 * A player's country marker — a real flag image, on every platform.
 *
 * This used to emit an emoji flag. Emoji flags are regional-indicator letter
 * pairs (US = 🇺🇸 = "U"+"S") that only look like flags where the platform ships
 * flag glyphs. Windows does not: Segoe UI Emoji has no country flags, so
 * Chrome/Edge on desktop drew the two letters instead. Detecting that and
 * substituting an ISO-code chip made desktop *deliberate*, but it was still
 * two letters where a flag belongs.
 *
 * So the artwork no longer comes from the platform at all. The flags the app
 * offers (lib/countries.ts) are served as SVGs from /public/flags, which means
 * every browser draws the same real flag and there is nothing to feature-detect.
 * The ISO chip survives only as the fallback for a code we have no file for.
 */

interface CountryFlagProps {
  /** ISO 3166-1 alpha-2 code. Renders nothing when absent or malformed. */
  code?: string | null;
  /** Overrides the default size — pass width/height classes, e.g. "h-5 w-7". */
  className?: string;
}

export function CountryFlag({ code, className }: CountryFlagProps) {
  const [failed, setFailed] = useState(false);

  if (!code || !/^[A-Za-z]{2}$/.test(code)) return null;

  const upper = code.toUpperCase();
  const label = countryName(upper) ?? upper;

  if (failed) {
    // No flag file for this code (a country outside the offered list, or a
    // stale value from an older profile). Say which country it is rather than
    // showing a broken image.
    return (
      <span
        className={cn(
          "inline-flex shrink-0 items-center rounded-[3px] border border-border/70 bg-secondary/70 px-1 py-px font-mono text-[9px] font-semibold uppercase leading-[1.35] tracking-wide text-muted-foreground",
          className,
        )}
        title={label}
        aria-label={label}
      >
        {upper}
      </span>
    );
  }

  return (
    // A plain <img>: these are tiny local SVGs, so next/image's optimiser has
    // nothing to do and would only add a request through /_next/image.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/flags/${upper}.svg`}
      alt={label}
      title={label}
      width={18}
      height={12}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={cn(
        "inline-block h-3 w-[18px] shrink-0 rounded-[2px] object-cover ring-1 ring-inset ring-black/15",
        className,
      )}
    />
  );
}
