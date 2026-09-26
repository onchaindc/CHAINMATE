/**
 * The server's clock, as seen from the browser.
 *
 * Chess clocks count SERVER-stamped move times, but the live readout ticked
 * against the DEVICE clock — a device running seconds ahead showed the
 * opponent (or itself) losing time it hadn't lost, and a device running
 * behind showed time still on the clock that the server had already flagged.
 * That mismatch read as the clock "glitching": digits lurching whenever a
 * fresh poll landed.
 *
 * Each game fetch carries a server-now anchor; adjusted for transport (half
 * the request→response round trip) it becomes an offset this module
 * remembers, and `serverNow()` is what the tick loop reads. Samples are
 * smoothed (the network jitters by tens of milliseconds between polls) and
 * implausible ones are ignored — a single honest sample beats a dishonest
 * one. Local games never call in, so their offset stays 0 and everything
 * falls back to the device clock, which is correct there.
 */

/** Server ms − device ms. Starts at "trust the device" until a sample lands. */
let offsetMs = 0;

/** Beyond this the "server" is a stale cache or a lying proxy, not a clock. */
const MAX_PLAUSIBLE_OFFSET_MS = 5 * 60_000;

/** How hard new samples pull the running estimate (0 = never, 1 = fully). */
const SMOOTHING = 0.5;

/**
 * Feed one { serverNow, sent, received } sample from a completed fetch.
 * `sent`/`received` bracket the request on the DEVICE clock; the halfway
 * point estimates transport delay, which is added back to the server's
 * snapshot so the offset describes "server time, right now".
 */
export function learnServerClockOffset(serverNow: number, sent: number, received: number): void {
  if (!Number.isFinite(serverNow) || serverNow <= 0) return;
  if (!Number.isFinite(sent) || !Number.isFinite(received) || received < sent) return;
  const sample = serverNow + (received - sent) / 2 - received;
  if (Math.abs(sample) > MAX_PLAUSIBLE_OFFSET_MS) return;
  offsetMs = offsetMs * (1 - SMOOTHING) + sample * SMOOTHING;
}

/** The server's estimate of "now", in the same unix-ms space as move stamps. */
export function serverNow(): number {
  return Date.now() + offsetMs;
}
