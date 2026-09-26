/**
 * Regression test for "everything shows Guest instead of player names" —
 * and for its opposite failure mode: inventing person-like handles.
 *
 * History: the old display path collapsed EVERY signed-out player into the
 * identical word "Guest". The first fix derived name-like handles from the
 * device id ("ZestyPanda66"), which players read as fabricated users — a
 * fair complaint. The settled behavior: guests display as an honest,
 * numbered label ("Guest 4821"), deterministic per player id, clearly not a
 * persona. Real usernames always win.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { displayNameFor, playerHandle } from "@/lib/identity";

test("a real username always wins over the guest label", () => {
  assert.equal(displayNameFor("0xabc", "MagnusC"), "MagnusC");
});

test("two different guests get different stable labels", () => {
  const a = playerHandle("0xaaaaaaaaaaaaaaaaaaaaaaaa");
  const b = playerHandle("0xbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.notEqual(a, b, "two guests must not share one display label");
  assert.equal(a, playerHandle("0xaaaaaaaaaaaaaaaaaaaaaaaa"), "label is stable per id");
});

test("guest labels are honest: numbered, clearly not a persona", () => {
  for (const id of ["0x1234", "acct_deadbeef", "guest_x"]) {
    const handle = playerHandle(id);
    // The label says what it is — a guest — with a distinguishing number.
    assert.match(handle, /^Guest \d{4}$/);
    // But it is never the bare, indistinguishable word.
    assert.notEqual(handle, "Guest");
    // And it never LOOKS like an invented username.
    assert.doesNotMatch(handle, /^[A-Z][a-z]+[A-Z][a-z]+/);
  }
});

test("machine-minted guest artifacts map to the label, real names pass", () => {
  // Both mint formats: device-local (`Guest_7B`) and the profile mirror's
  // `Guest_0X12` (the X defeats a hex-only pattern).
  assert.equal(displayNameFor("0xabc", "Guest_7B"), playerHandle("0xabc"));
  assert.equal(displayNameFor("0xabc", "Guest_0X12"), playerHandle("0xabc"));
  assert.equal(displayNameFor("0xabc", "Guest_3F2A"), playerHandle("0xabc"));
  // The bare word (old records literally stored "Guest") also maps.
  assert.equal(displayNameFor("0xabc", "Guest"), playerHandle("0xabc"));
  // A player who actually named themselves something Guest-ish keeps it.
  assert.equal(displayNameFor("0xabc", "Guesthunter"), "Guesthunter");
});

test("no id and no name falls back rather than throwing", () => {
  assert.equal(playerHandle(null), "Guest");
  assert.equal(displayNameFor(undefined, undefined), "Guest");
});
