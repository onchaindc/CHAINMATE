# ChainMate contract — GenLayer deployment guide

`chainmate.py` is a GenLayer **intelligent contract** written in Python,
compatible with the GenVM and **testnet Bradbury**. One contract instance
hosts exactly one game: `create_game()` (deployer = White), `join_game()`
(Black), `submit_move()`, `resign_game()`, `get_game()`,
`generate_match_summary()`.

The contract embeds a complete, deterministic chess engine (move generation,
castling, en passant, promotion, check/checkmate/stalemate, insufficient
material, SAN generation), so all rules are enforced on-chain.

## Storage model

Persistent state uses **GenVM storage types only** — no raw Python lists.
Move and commentary history are `DynArray[MoveRecord]` /
`DynArray[CommentaryRecord]` with `@allow_storage` dataclasses, so the
contract passes `genvm-lint` and GenVM storage checks.

## Authorization model

Every write is bound to the **authenticated transaction sender**
(`gl.message.sender_address` — the wallet that signed the transaction):

- `create_game()` → White is the sender.
- `join_game()` → Black is the (distinct) sender.
- `submit_move()` → derives the side from the sender and rejects anyone who
  is not a player, is out of turn, or plays after the game ends.
- `resign_game()` → only the player themselves can resign.

The contract **never accepts a caller-selected player id or signing key** —
there is no "player" argument anywhere. The dApp layer must therefore sign
moves with the actual player's key: either the player's own wallet (the
non-custodial, recommended setup) or a server key that was bound to the
player's identity at create/join time. See the repo README for the current
app integration.

## Prerequisites

- Python ≥ 3.12
- Node.js ≥ 18
- The GenLayer CLI (installs the local simulator + deployment tooling):

```bash
npm install -g genlayer
```

- A GenLayer wallet with funds for testnet Bradbury (get testnet GEN from the
  [GenLayer faucet](https://faucet.genlayer.com) or the Bradbury testnet
  portal).

## Lint + tests (run before resubmitting to the Portal)

Requires **Python ≥ 3.12** (the pinned GenVM runner needs it). If your system
only has an older Python, `uv` can provide 3.12 locally:
`uv venv .venv --python 3.12 && uv pip install --python .venv/bin/python -r requirements.txt`.

```bash
# 1. Python environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 2. Static checks — this is what the GenLayer Portal "checks" run
genvm-lint check contracts/chainmate.py

# 3. Direct-mode unit tests (in-memory, no Studio needed)
pytest tests/direct/ -v
```

Current status (verified): `genvm-lint` reports **Lint passed (3 checks) +
Validation passed**, and `pytest tests/direct/ -v` passes **20/20**.

The direct tests cover the two review-critical areas:

- **Authorization boundary** — non-players cannot move or resign, out-of-turn
  moves are rejected, games cannot be re-created, no moves before start or
  after the game ends.
- **Core chess outcomes** — legal moves + SAN, illegal moves, checkmate
  (fool's mate), stalemate (shortest known line), castling, en passant,
  promotion, resignation, per-move commentary.

## Quick start (local simulator first)

```bash
# 1. Start the local GenLayer network (5 validator nodes in Docker)
genlayer init
genlayer up

# 2. Create an account
genlayer account create --output ./keypair.json

# 3. Deploy the contract
genlayer network set localnet
genlayer deploy --contract contracts/chainmate.py

# 4. Interact (address printed by the deploy step)
genlayer call 0x<CONTRACT_ADDRESS> get_game
genlayer write 0x<CONTRACT_ADDRESS> create_game
genlayer write 0x<CONTRACT_ADDRESS> join_game          # use a second account
genlayer write 0x<CONTRACT_ADDRESS> submit_move --args e2 e4
genlayer write 0x<CONTRACT_ADDRESS> resign_game
genlayer write 0x<CONTRACT_ADDRESS> generate_match_summary
```

Watch the Studio UI (`https://studio.genlayer.com`) to see the five validators
reach consensus on every transaction, including the LLM calls.

## Deploying to testnet Bradbury

```bash
# 1. Point the CLI at the testnet and fund your account
genlayer network set testnet-bradbury
genlayer account info                     # shows address + balance

# 2. Fund the account (faucet), then deploy
genlayer deploy --contract contracts/chainmate.py
```

The deploy prints the contract address. Use that address in the dApp: set
`NEXT_PUBLIC_GAME_BACKEND=genlayer`,
`NEXT_PUBLIC_GENLAYER_NETWORK=testnetBradbury` and the signing keys
(`GENLAYER_PRIVATE_KEY`, `GENLAYER_PRIVATE_KEY_2`), then create a game from
the UI — it deploys a fresh contract per game.

> Signing keys: the server signs on behalf of both players and binds each
> game's White/Black to the browser identities that created/joined — the
> client never picks which key to use. For full non-custodial play, submit
> moves/resignations from the player's own wallet (e.g. MetaMask pointed at
> the GenLayer RPC) so `gl.message.sender_address` is the player themselves.

## Contract API

| Function | Visibility | Notes |
| --- | --- | --- |
| `create_game()` | write | resets + initialises; creator becomes White; status `waiting` |
| `join_game()` | write | second, distinct address joins as Black; status `active` |
| `submit_move(from, to, promotion="")` | write | validates legality + turn, stores SAN, detects check/checkmate/stalemate/draw, appends commentary |
| `resign_game()` | write | sets status `resigned`, opponent wins |
| `get_game()` | view | returns creator, opponent, status, winner, fen, moves, commentary, summary |
| `generate_match_summary()` | write | requires game over; LLM summary via non-deterministic block with validator cross-check; deterministic fallback if the LLM fails |

## The AI summary (non-deterministic execution)

`generate_match_summary()` calls `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)`:

- **leader_fn** runs `gl.nondet.exec_prompt(..., response_format="json")` with
  the full move list and winner, returning `{"summary", "winner"}`.
- **validator_fn** independently re-runs the prompt on its own validator and
  accepts the leader's result only if both summaries are plausible and agree
  on the winner (or "draw").
- If the LLM path fails, the contract stores a deterministic analysis instead,
  so the function always succeeds.

Move history and winner are captured into locals **before** the nondet block,
so the block never reads or writes storage.

## Storage

- `creator` / `opponent` — player addresses (White / Black)
- `status` — `"" | waiting | active | checkmate | stalemate | draw | resigned`
- `winner` — winning address (empty for stalemate/draw)
- `fen` — current board position (FEN)
- `moves` — `DynArray[MoveRecord]` (`{number, side, from, to, promotion, san}`)
- `commentary` — `DynArray[CommentaryRecord]` (`{move, side, text}`)
- `summary` — final match analysis

## Notes & limitations

- **Fees**: testnet transactions need GEN and a fee preset. The dApp's server
  wrapper submits with the SDK defaults; for production use
  `genlayer estimate-fees <addr> <method> --fee-profile ./artifacts/fee-profile.json`
  and pass the profile with `--fee-preset standard` (see the CLI docs).
- **Per-game contracts**: each game is its own contract instance (the standard
  GenLayer pattern). A factory contract that spawns games is a possible
  optimization.
- **Draw rules**: checkmate, stalemate, resignation and insufficient material
  are detected. Fifty-move / threefold repetition are not — extend
  `submit_move` to track the halfmove clock.
- The contract intentionally trusts no client: it recomputes legality, SAN and
  results from the stored FEN on every move.
