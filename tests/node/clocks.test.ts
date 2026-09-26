/**
 * Clock display and live-tick regressions.
 *
 * Covers the two user-visible failures this module had:
 *  - the countdown "repeating" around the 20s boundary (whole seconds above
 *    it were CEILed, tenths below it were FLOORed, so 20.0 → 20.0);
 *  - tenths rendering below 20s (the "super fast" countdown is honest — it
 *    is showing the tenth-seconds a scramble is actually decided by).
 *
 * The live ticking itself lives in a React hook (untestable here); the math
 * it renders lives in lib/clocks.ts and is fully covered below.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  formatClockLive,
  parseTimeControl,
  TENTH_THRESHOLD_MS,
} from "@/lib/clocks";

test("the countdown flows through the 20s boundary without repeating", () => {
  // Above the boundary the whole seconds are CEILed; below it, tenths are.
  // Both round UP, so time only ever flows forward across the switch.
  assert.equal(formatClockLive(TENTH_THRESHOLD_MS), "00:20");
  assert.equal(formatClockLive(TENTH_THRESHOLD_MS - 1), "20.0");
  // The old floor put a full second back here: 20.0 → 20.0 → 19.9.
  assert.equal(formatClockLive(19_950), "20.0");
  assert.equal(formatClockLive(19_900), "19.9");
  assert.equal(formatClockLive(19_899), "19.9");
  assert.equal(formatClockLive(19_800), "19.8");
});

test("tenths show under the threshold and each tenth lasts exactly 100ms", () => {
  // Ceiling semantics: the readout never under-shows the remaining time,
  // so the tail of one second can round up to the next tenth.
  assert.equal(formatClockLive(9_999), "10.0");
  assert.equal(formatClockLive(9_990), "10.0");
  assert.equal(formatClockLive(9_889), "09.9");
  assert.equal(formatClockLive(9_800), "09.8");
  assert.equal(formatClockLive(500), "00.5");
  assert.equal(formatClockLive(99), "00.1");
  assert.equal(formatClockLive(0), "00.0");
  // Negative (a clock that mathematically dipped past zero) clamps.
  assert.equal(formatClockLive(-1), "00.0");
});

test("whole seconds stay calm above the threshold", () => {
  assert.equal(formatClockLive(TENTH_THRESHOLD_MS), "00:20");
  // Ceil semantics: 59.4s remaining reads 1:00 (standard chess-clock behavior —
  // never show less time than is left), while a flat 59s reads 00:59.
  assert.equal(formatClockLive(59_400), "01:00");
  assert.equal(formatClockLive(59_000), "00:59");
  assert.equal(formatClockLive(125_000), "02:05");
});

test("the threshold is exported so the tick loop and the format agree", () => {
  assert.equal(typeof TENTH_THRESHOLD_MS, "number");
  assert.ok(TENTH_THRESHOLD_MS > 0);
});

test("time controls still parse (the clock's raw material)", () => {
  assert.deepEqual(parseTimeControl("1 + 0"), { baseMs: 60_000, incrementMs: 0 });
  assert.deepEqual(parseTimeControl("5 + 3"), { baseMs: 300_000, incrementMs: 3_000 });
  assert.deepEqual(parseTimeControl("3m 45s"), { baseMs: 225_000, incrementMs: 0 });
  assert.deepEqual(parseTimeControl("1d"), { baseMs: 86_400_000, incrementMs: 0 });
  assert.equal(parseTimeControl(undefined), null);
  assert.equal(parseTimeControl("banana"), null);
});
