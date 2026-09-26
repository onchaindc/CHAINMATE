/**
 * Regression tests for guest naming.
 *
 * History: the first display path collapsed every signed-out player into the
 * identical word "Guest". The first fix minted person-like handles from the
 * device id ("ZestyPanda66"), which players read as fabricated users; the
 * second minted numbered labels ("Guest 4821"); the third let the machine
 * string "Guest_7B" through verbatim — each rejected. Settled behavior: a
 * guest displays as the single word "Guest". Alone. No numbers, no suffix,
 * nothing derived. Real usernames always pass through verbatim.
 *
 * Run: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as identityModule from "@/lib/identity";
import {
  GUEST_NAME,
  UNNAMED_NAME,
  displayNameFor,
  guestDisplayName,
  playerHandle,
} from "@/lib/identity";

test("a guest displays as the single word Guest — alone", () => {
  assert.equal(GUEST_NAME, "Guest");
  // The bare word (old records literally stored "Guest").
  assert.equal(guestDisplayName("Guest"), "Guest");
  // Every machine-minted artifact format ever stored on a guest record.
  assert.equal(guestDisplayName("Guest_7B"), "Guest");
  assert.equal(guestDisplayName("Guest_0X12"), "Guest");
  assert.equal(guestDisplayName("Guest_3F2A"), "Guest");
});

test("no guest display ever contains digits or an underscore", () => {
  for (const stored of ["Guest", "Guest_7B", "Guest_0X12", "Guest_3F2A"]) {
    const shown = guestDisplayName(stored);
    assert.doesNotMatch(shown, /\d/, `"${shown}" must not contain digits`);
    assert.doesNotMatch(shown, /_/, `"${shown}" must not contain an underscore`);
    assert.doesNotMatch(shown, /\s/, `"${shown}" must not contain whitespace`);
  }
});

test("real usernames pass through verbatim", () => {
  assert.equal(displayNameFor("0xabc", "MagnusC"), "MagnusC");
  assert.equal(guestDisplayName("Guesthunter"), "Guesthunter");
  assert.equal(guestDisplayName("AbdulXBT"), "AbdulXBT");
  // A name that merely contains the word keeps itself.
  assert.equal(guestDisplayName("Guest_Only_In_Name"), "Guest_Only_In_Name");
});

test("no recorded name yields empty — never a derived label", () => {
  assert.equal(displayNameFor("0xaaaaaaaaaaaaaaaaaaaaaaaa"), "");
  assert.equal(displayNameFor("0xbbbbbbbbbbbbbbbbbbbbbbbb", null), "");
  assert.equal(displayNameFor(undefined, undefined), "");
  assert.equal(displayNameFor(null, ""), "");
  assert.equal(guestDisplayName(undefined), "");
});

test("no function in the identity module derives a name from an id", () => {
  // Whatever remains of the old label API must not fabricate anything.
  assert.equal(playerHandle(), "");
  // The only string it exports for a blank slot is punctuation, not a name.
  assert.match(UNNAMED_NAME, /^[—-]$/);
});

test("no vocabulary of invented handles exists anywhere", () => {
  // Guarded by construction: the identity module exports no adjective or
  // animal lists. If someone reintroduces them under a new name, this fails.
  for (const key of Object.keys(identityModule)) {
    assert.doesNotMatch(key, /adjective|animal|persona|zesty|falcon/i);
  }
});
