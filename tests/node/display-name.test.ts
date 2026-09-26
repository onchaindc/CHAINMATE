/**
 * Regression test for "everything shows Guest instead of player names".
 *
 * The old display path collapsed EVERY signed-out player into the identical
 * word "Guest" — an opponent in your history, the leaderboard, a live watch
 * row and a tournament bracket all read the same, which looked like a data
 * bug. Guests have no account name, but each has a stable device id, so the
 * fix is a deterministic per-player handle ("SwiftFalcon42") that is stable
 * across every surface and never collides between two guests in one list.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { displayNameFor, playerHandle } from "@/lib/identity";

test("a real username always wins over the handle", () => {
  assert.equal(displayNameFor("0xabc", "MagnusC"), "MagnusC");
});

test("two different guests get different stable handles", () => {
  const a = playerHandle("0xaaaaaaaaaaaaaaaaaaaaaaaa");
  const b = playerHandle("0xbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.notEqual(a, b, "two guests must not share one display name");
  assert.equal(a, playerHandle("0xaaaaaaaaaaaaaaaaaaaaaaaa"), "handle is stable per id");
});

test("handles read like player names, not the word Guest", () => {
  for (const id of ["0x1234", "acct_deadbeef", "guest_x"]) {
    const handle = playerHandle(id);
    assert.notEqual(handle, "Guest");
    assert.match(handle, /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/);
  }
});

test("machine-minted Guest_XXXX artifacts map to the handle, real names pass", () => {
  // Both mint formats: device-local (`Guest_7B`) and the profile mirror's
  // `Guest_0X12` (the X defeats a hex-only pattern).
  assert.equal(displayNameFor("0xabc", "Guest_7B"), playerHandle("0xabc"));
  assert.equal(displayNameFor("0xabc", "Guest_0X12"), playerHandle("0xabc"));
  assert.equal(displayNameFor("0xabc", "Guest_3F2A"), playerHandle("0xabc"));
  // A player who actually named themselves something Guest-ish keeps it.
  assert.equal(displayNameFor("0xabc", "Guesthunter"), "Guesthunter");
});

test("no id and no name falls back rather than throwing", () => {
  assert.equal(playerHandle(null), "Guest");
  assert.equal(displayNameFor(undefined, undefined), "Guest");
});
