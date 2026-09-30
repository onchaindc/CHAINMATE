/**
 * The one-active-game gate.
 *
 * A player could open any number of games at once — a board vs the bot, a
 * waiting public table, a second ranked match, an accepted challenge — and
 * every one of them was a real game the player was expected to play. The
 * contract is one board at a time: every path that starts (or joins) a game
 * refuses while one is still running, and the refusal names the game that is
 * in the way so the UI can offer a way back to it.
 *
 * These tests pin the rule at the server boundary, where it is authoritative:
 * create (multiplayer), createAi (bot), join (open games), acceptChallenge,
 * createChallenge, seek (matchmaking) and rematch. The exclusions are pinned
 * too — resuming your own waiting game, the tournament engine's bracket
 * pairings, and a pairing your opponent already made are all still possible.
 *
 * Run: npm test
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

/* The file store resolves `.data/` off process.cwd() when its module first
   loads, so the working directory has to move before anything imports it —
   hence the dynamic import in before(). Tests must never write to the repo's
   real .data/. */
let DATA_ROOT: string;
let hosted: typeof import("@/lib/server/hosted");
let ActiveGameGateError: typeof import("@/lib/types").ActiveGameGateError;

before(async () => {
  DATA_ROOT = mkdtempSync(path.join(tmpdir(), "chainmate-gate-"));
  process.chdir(DATA_ROOT);
  /* No KV, no Supabase: the file store under DATA_ROOT is the whole world. */
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  hosted = await import("@/lib/server/hosted");
  ({ ActiveGameGateError } = await import("@/lib/types"));

  process.on("exit", () => {
    try {
      rmSync(DATA_ROOT, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
});

/** Gate errors must be recognisable AND carry the id of the blocking game. */
function assertGate(err: unknown, activeGameId: string): void {
  assert.ok(err instanceof ActiveGameGateError, `expected a gate error, got: ${err}`);
  const gate = err as InstanceType<typeof ActiveGameGateError>;
  assert.equal(gate.activeGameId, activeGameId);
  assert.match(
    gate.message,
    /already have a game in progress/,
    "the message must say what is wrong",
  );
}

/** Fool's mate played out so a game reaches a terminal state. */
async function playFoolsMate(id: string, white: string, black: string): Promise<void> {
  const moves: [string, string][] = [
    ["f2", "f3"],
    ["e7", "e5"],
    ["g2", "g4"],
    ["d8", "h4"],
  ];
  for (const [i, [from, to]] of moves.entries()) {
    await hosted.submitHostedMove(id, i % 2 === 0 ? white : black, from, to);
  }
}

/* ------------------------------------------------------------------ */
/* Creating games                                                      */
/* ------------------------------------------------------------------ */

test("a second multiplayer game is refused while one is waiting", async () => {
  const A = "gate_create_a";
  const first = await hosted.createHostedGame(A);
  await assert.rejects(() => hosted.createHostedGame(A), (err: unknown) => {
    assertGate(err, first.id);
    return true;
  });
  /* The first game is still the only one on the player's record. */
  const active = await hosted.readActiveHostedGame(A);
  assert.equal(active?.id, first.id);
});

test("a second bot game is refused while a bot game runs", async () => {
  const A = "gate_ai_a";
  const first = await hosted.createHostedAiGame(A, "casual");
  await assert.rejects(
    () => hosted.createHostedAiGame(A, "beginner"),
    (err: unknown) => {
      assertGate(err, first.id);
      return true;
    },
  );
});

test("a bot game is refused while a human game runs (and the other way round)", async () => {
  const A = "gate_mixed_a";
  const B = "gate_mixed_b";
  const human = await hosted.createHostedGame(A);
  await assert.rejects(
    () => hosted.createHostedAiGame(A, "casual"),
    (err: unknown) => {
      assertGate(err, human.id);
      return true;
    },
  );

  /* And a running bot game blocks a multiplayer one. */
  const bot = await hosted.createHostedAiGame(B, "casual");
  await assert.rejects(
    () => hosted.createHostedGame(B),
    (err: unknown) => {
      assertGate(err, bot.id);
      return true;
    },
  );
});

test("finishing the game reopens the door", async () => {
  const A = "gate_done_a";
  const B = "gate_done_b";
  const game = await hosted.createHostedGame(A);
  await hosted.joinHostedGame(game.id, B);
  await playFoolsMate(game.id, A, B);

  /* Checkmate ends it: the same player can now start something new. */
  assert.equal((await hosted.readActiveHostedGame(A)) ?? null, null);
  const next = await hosted.createHostedAiGame(A, "casual");
  assert.match(next.id, /^hosted_/);
});

test("resigning the game reopens the door", async () => {
  const A = "gate_resign_a";
  const B = "gate_resign_b";
  const game = await hosted.createHostedGame(A);
  await hosted.joinHostedGame(game.id, B);
  await hosted.resignHostedGame(game.id, A);
  assert.equal((await hosted.readActiveHostedGame(A)) ?? null, null);
});

test("a guest id and an account id are different players to the gate", async () => {
  /* Different player ids gate independently — the gate is per-player, not
     per-device or per-anything-else. */
  const A = "gate_distinct_a";
  const B = "gate_distinct_b";
  await hosted.createHostedGame(A);
  const bGame = await hosted.createHostedGame(B);
  assert.match(bGame.id, /^hosted_/);
});

/* ------------------------------------------------------------------ */
/* Joining games                                                       */
/* ------------------------------------------------------------------ */

test("joining an open game is refused while another game runs", async () => {
  const A = "gate_join_a";
  const B = "gate_join_b";
  const C = "gate_join_c";
  const table = await hosted.createHostedGame(A); // open to anyone
  const busy = await hosted.createHostedAiGame(C, "casual"); // C is mid-game

  await assert.rejects(
    () => hosted.joinHostedGame(table.id, C),
    (err: unknown) => {
      assertGate(err, busy.id);
      return true;
    },
  );
  /* The table stays open — C's refusal changed nothing for A. */
  const still = await hosted.getHostedGame(table.id);
  assert.equal(still?.opponent, "");
  assert.equal(still?.status, "waiting");
});

test("the gate never masks the join's own validation", async () => {
  const A = "gate_own_a";
  const game = await hosted.createHostedGame(A);

  /* A's waiting game IS A's active game — so a self-join could plausibly
     trip the gate. It must not: the join's own, more specific refusal (a
     creator does not JOIN their table; they sit back down by opening it)
     is the correct answer, and the game the gate would name would be this
     very one. */
  await assert.rejects(() => hosted.joinHostedGame(game.id, A), /cannot join your own game/);
});

/* ------------------------------------------------------------------ */
/* Challenges                                                          */
/* ------------------------------------------------------------------ */

test("a challenge cannot be sent while a game runs", async () => {
  const A = "gate_chal_a";
  const B = "gate_chal_b";
  const busy = await hosted.createHostedAiGame(A, "casual");
  await assert.rejects(
    () => hosted.createChallenge(A, B, "10 + 0"),
    (err: unknown) => {
      assertGate(err, busy.id);
      return true;
    },
  );
});

test("a challenge cannot be accepted while a game runs", async () => {
  const A = "gate_acc_a";
  const B = "gate_acc_b";
  const challenge = await hosted.createChallenge(A, B, "10 + 0");
  const busy = await hosted.createHostedAiGame(B, "casual");

  await assert.rejects(
    () => hosted.acceptChallenge(challenge.id, B),
    (err: unknown) => {
      assertGate(err, busy.id);
      return true;
    },
  );
  /* The challenge is untouched: B can still accept once they finish up. */
  const still = await hosted.getHostedGame(challenge.id);
  assert.equal(still?.status, "waiting");
  assert.equal(still?.opponent, "");
});

test("accepting works once the running game is finished", async () => {
  const A = "gate_acc2_a";
  const B = "gate_acc2_b";
  const challenge = await hosted.createChallenge(A, B, "10 + 0");
  const busy = await hosted.createHostedAiGame(B, "casual");
  await hosted.resignHostedGame(busy.id, B);

  const started = await hosted.acceptChallenge(challenge.id, B);
  assert.equal(started.id, challenge.id);
  assert.equal(started.opponent, B);
  assert.equal(started.status, "active");
});

/* ------------------------------------------------------------------ */
/* Matchmaking                                                         */
/* ------------------------------------------------------------------ */

test("searching for a match is refused while a game runs", async () => {
  const A = "gate_seek_a";
  const busy = await hosted.createHostedAiGame(A, "casual");
  await assert.rejects(
    () => hosted.seekMatch(A, "10 + 0"),
    (err: unknown) => {
      assertGate(err, busy.id);
      return true;
    },
  );
});

test("re-entering the pool while YOUR OWN seek row is open is allowed", async () => {
  const A = "gate_repool_a";
  /* First seek registers A in the pool (status "waiting"). The gate must not
     mistake A's own unclaimed pool row for a second game — pollSeek re-runs
     seekMatch every poll. */
  const first = await hosted.seekMatch(A, "10 + 0");
  assert.equal(first.status, "waiting");
  const again = await hosted.seekMatch(A, "10 + 0");
  assert.equal(again.status, "waiting");
  await hosted.cancelSeek(A);
});

test("being paired by the OTHER side's seek is honoured, not gated", async () => {
  const A = "gate_pair_a";
  const B = "gate_pair_b";
  /* A waits in the pool; B's seek pairs them. A's next poll must return the
     pairing even though A now "has an active game" — it IS A's game. */
  await hosted.seekMatch(A, "10 + 0");
  const bSeek = await hosted.seekMatch(B, "10 + 0");
  assert.equal(bSeek.status, "matched");

  const aPoll = await hosted.pollSeek(A, "10 + 0");
  assert.equal(aPoll.status, "matched");
  assert.equal(aPoll.status === "matched" && bSeek.status === "matched", true);
  if (aPoll.status === "matched" && bSeek.status === "matched") {
    assert.equal(aPoll.game.id, bSeek.game.id);
  }
});

/* ------------------------------------------------------------------ */
/* Rematch                                                             */
/* ------------------------------------------------------------------ */

test("a rematch is refused while another game runs", async () => {
  const A = "gate_rematch_a";
  const B = "gate_rematch_b";
  const finished = await hosted.createHostedGame(A);
  await hosted.joinHostedGame(finished.id, B);
  await playFoolsMate(finished.id, A, B);

  const busy = await hosted.createHostedAiGame(A, "casual");
  await assert.rejects(
    () => hosted.rematchHostedGame(finished.id, A),
    (err: unknown) => {
      assertGate(err, busy.id);
      return true;
    },
  );
});

test("a rematch works once the extra game is resigned", async () => {
  const A = "gate_rematch2_a";
  const B = "gate_rematch2_b";
  const finished = await hosted.createHostedGame(A);
  await hosted.joinHostedGame(finished.id, B);
  await playFoolsMate(finished.id, A, B);
  const busy = await hosted.createHostedAiGame(A, "casual");
  await hosted.resignHostedGame(busy.id, A);

  const next = await hosted.rematchHostedGame(finished.id, A);
  assert.equal(next.creator, A);
  assert.equal(next.opponent, B);
  assert.equal(next.status, "active");
});

/* ------------------------------------------------------------------ */
/* The tournament engine's exemption                                   */
/* ------------------------------------------------------------------ */

test("the tournament engine's bracket pairing is never gated", async () => {
  const WHITE = "gate_tourney_w";
  const BLACK = "gate_tourney_b";

  /* Both players are deliberately mid-game in casual play — the event's
     schedule is not theirs to defer, so the round must still start. */
  const casualW = await hosted.createHostedAiGame(WHITE, "casual");
  const casualB = await hosted.createHostedAiGame(BLACK, "casual");

  const game = await hosted.createHostedGameUnchecked(WHITE, { visibility: "public" });
  await hosted.joinHostedGameUnchecked(game, BLACK);
  const joined = await hosted.getHostedGame(game.id);
  assert.equal(joined?.creator, WHITE);
  assert.equal(joined?.opponent, BLACK);
  assert.equal(joined?.status, "active");

  /* Clean up so later tests (and the players) are not blocked. */
  await hosted.resignHostedGame(game.id, WHITE);
  await hosted.resignHostedGame(casualW.id, WHITE);
  await hosted.resignHostedGame(casualB.id, BLACK);
});
