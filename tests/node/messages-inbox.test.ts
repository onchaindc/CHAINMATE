/**
 * Player messaging — the inbox display contract.
 *
 * Regression tests for the chat-list name leak: every envelope handed to a
 * client must carry the OTHER side's real display name on counterpartName,
 * never "You" and never a raw acct_… id. The chat list titles each thread
 * with that field, so a "You" placeholder made every conversation the player
 * had initiated render as "You" instead of the friend's username.
 *
 * The store runs on the real file store (throwaway .data root, Supabase env
 * cleared) and the inbox is seeded directly, because sending DMs requires
 * real friendships (Supabase) and must fail closed without them — that
 * fail-closed behavior is pinned here too.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type * as StorageModule from "@/lib/server/storage";
import type * as MessagesModule from "@/lib/server/messages";
type MessageEnvelope = MessagesModule.MessageEnvelope;

let storage: typeof StorageModule;
let messages: typeof MessagesModule;

const INBOX_KEY = "chainmate:messages:inboxes";

const READER = "acct_reader";
const PEER = "acct_peer";

before(async () => {
  const DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-messages-"));
  process.chdir(DATA_ROOT);
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  process.on("exit", () => {
    try {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
  storage = await import("@/lib/server/storage");
  messages = await import("@/lib/server/messages");
});

/** Seed one player's inbox directly (the push path needs real friendships). */
async function seedInbox(
  playerId: string,
  envelopes: MessageEnvelope[],
): Promise<void> {
  const raw = await storage.getGameStorage().get(INBOX_KEY);
  let all: Record<string, MessageEnvelope[]> = {};
  try {
    all = raw ? (JSON.parse(raw) as Record<string, MessageEnvelope[]>) : {};
  } catch {
    all = {};
  }
  all[playerId] = envelopes;
  await storage.getGameStorage().set(INBOX_KEY, JSON.stringify(all));
}

function dmFrom(overrides: Partial<MessageEnvelope> = {}): MessageEnvelope {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    fromPlayerId: PEER,
    fromName: "Peer",
    toPlayerId: READER,
    kind: "dm",
    body: "hello there",
    sentAt: Date.now(),
    readAt: null,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* The regression: own sent copies never label the thread "You"        */
/* ------------------------------------------------------------------ */

test("a chat the reader initiated shows the peer's resolved name, never You", async () => {
  // The reader's own copy of a message they sent to PEER. This is the exact
  // shape that used to come back labelled "You" and titled the whole thread
  // "You" in the chat list.
  await seedInbox(READER, [
    dmFrom({ fromPlayerId: READER, fromName: "Reader", toPlayerId: PEER }),
  ]);

  const inbox = await messages.inboxForDisplay(READER);
  assert.equal(inbox.length, 1);
  const envelope = inbox[0];
  assert.equal(envelope.counterpartId, PEER, "the thread must group under the peer");
  assert.notEqual(envelope.counterpartName, "You", "You must never label a thread");
  assert.doesNotMatch(envelope.counterpartName, /^acct_/, "never a raw player id");
  // Without Supabase the resolver falls back to the honest placeholder.
  assert.equal(envelope.counterpartName, "Player");
});

test("a received DM shows the sender's resolved name", async () => {
  await seedInbox(READER, [dmFrom()]);

  const inbox = await messages.inboxForDisplay(READER);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].counterpartId, PEER);
  assert.notEqual(inbox[0].counterpartName, "You");
  assert.doesNotMatch(inbox[0].counterpartName, /^acct_/);
});

test("both directions of one exchange group under the same peer", async () => {
  await seedInbox(READER, [
    dmFrom(),
    dmFrom({ fromPlayerId: READER, toPlayerId: PEER, sentAt: Date.now() + 1 }),
  ]);

  const inbox = await messages.inboxForDisplay(READER);
  assert.equal(inbox.length, 2);
  for (const envelope of inbox) {
    assert.equal(envelope.counterpartId, PEER);
    assert.notEqual(envelope.counterpartName, "You");
  }
});

/* ------------------------------------------------------------------ */
/* Support + broadcast envelopes                                       */
/* ------------------------------------------------------------------ */

test("official envelopes resolve to ChainMate, not a raw id", async () => {
  await seedInbox(READER, [
    dmFrom({
      fromPlayerId: "chainmate",
      fromName: "ChainMate",
      toPlayerId: null,
      kind: "broadcast",
      body: "Server maintenance tonight",
    }),
  ]);

  const inbox = await messages.inboxForDisplay(READER);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].counterpartName, "ChainMate");
  assert.equal(inbox[0].counterpartId, "chainmate");
});

/* ------------------------------------------------------------------ */
/* Read state + the friends-only send gate                             */
/* ------------------------------------------------------------------ */

test("markInboxRead clears unread without touching the messages", async () => {
  await seedInbox(READER, [dmFrom(), dmFrom({ sentAt: Date.now() + 2 })]);

  assert.equal(await messages.unreadCount(READER), 2);
  await messages.markInboxRead(READER);
  assert.equal(await messages.unreadCount(READER), 0);

  const inbox = await messages.inboxFor(READER);
  assert.equal(inbox.length, 2, "read must not delete anything");
  for (const envelope of inbox) {
    assert.ok(envelope.readAt !== null, "every envelope must carry a read stamp");
  }
});

test("DMs fail closed without a real friendship (no Supabase)", async () => {
  // Fresh ids: the inbox above is seeded by earlier tests, and the assertion
  // here is that a rejected send writes NOTHING for either side.
  const sender = "acct_sender_nofriends";
  const target = "acct_target_nofriends";
  const result = await messages.sendDirectMessage(sender, target, "hi");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /friends/i);
  }
  // Nothing was written to either inbox.
  assert.equal((await messages.inboxFor(sender)).length, 0);
  assert.equal((await messages.inboxFor(target)).length, 0);
});

test("self-messaging is rejected before any store write", async () => {
  const result = await messages.sendDirectMessage(READER, READER, "note to self");
  assert.equal(result.ok, false);
});
