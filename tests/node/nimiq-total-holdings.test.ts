import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isOwnedWrapperContract,
  type NimiqRpcAccount,
} from "@/lib/server/nimiq/rpc";

const NOW = 1_800_000_000_000; // fixed "now" for determinism
const CREATOR = "NQ64 66X5 1RHD 3TE7 X1XJ QSLC FL8X 17JA QB93";

function htlc(overrides: Partial<NimiqRpcAccount> = {}): NimiqRpcAccount {
  return {
    address: "NQ54 LQQN 8MKE 0VS0 NJAN U9G2 X89F 4N2Q G65R",
    balance: "245358488",
    type: "htlc",
    sender: CREATOR,
    timeout: NOW + 86_400_000, // future
    ...overrides,
  } as NimiqRpcAccount;
}

function vesting(overrides: Partial<NimiqRpcAccount> = {}): NimiqRpcAccount {
  return {
    address: "NQ41 GQ5N 6VUP 7DQE DG1H B2P9 XTXH JUFF Q5FM",
    balance: "100000",
    type: "vesting",
    owner: CREATOR,
    ...overrides,
  } as NimiqRpcAccount;
}

test("isOwnedWrapperContract: future-timeout HTLC created by the address counts", () => {
  assert.equal(isOwnedWrapperContract(htlc(), CREATOR, NOW), true);
});

test("isOwnedWrapperContract: expired HTLC does not count (funds return to basic)", () => {
  assert.equal(isOwnedWrapperContract(htlc({ timeout: NOW - 1 }), CREATOR, NOW), false);
});

test("isOwnedWrapperContract: HTLC without a timeout counts (conservative)", () => {
  assert.equal(isOwnedWrapperContract(htlc({ timeout: undefined }), CREATOR, NOW), true);
});

test("isOwnedWrapperContract: vesting owned by the address counts", () => {
  assert.equal(isOwnedWrapperContract(vesting(), CREATOR, NOW), true);
});

test("isOwnedWrapperContract: contract created by a DIFFERENT address does not count", () => {
  assert.equal(isOwnedWrapperContract(htlc({ sender: "NQ99 OTHER" }), CREATOR, NOW), false);
  assert.equal(isOwnedWrapperContract(vesting({ owner: "NQ99 OTHER" }), CREATOR, NOW), false);
});

test("isOwnedWrapperContract: basic accounts never count", () => {
  assert.equal(
    isOwnedWrapperContract({ type: "basic", sender: CREATOR, timeout: NOW + 1 }, CREATOR, NOW),
    false,
  );
  assert.equal(isOwnedWrapperContract({ type: 0, sender: CREATOR }, CREATOR, NOW), false);
});

test("isOwnedWrapperContract: numeric creator fields with spaced canonical forms match", () => {
  // The node returns spaced NQ… forms; matching must be whitespace/case-insensitive.
  assert.equal(
    isOwnedWrapperContract(htlc({ sender: "nq64 66x5 1rhd 3te7 x1xj qslc fl8x 17ja qb93" }), CREATOR, NOW),
    true,
  );
});

test("isOwnedWrapperContract: missing creator → false", () => {
  assert.equal(isOwnedWrapperContract(htlc({ sender: undefined }), CREATOR, NOW), false);
});
