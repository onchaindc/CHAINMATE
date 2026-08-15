# ChainMate contract — GenLayer deployment guide

`chainmate.py` is a GenLayer **intelligent contract** written in Python,
compatible with the GenVM and **testnet Bradbury**. One contract instance
hosts exactly one game: `create_game()` (deployer = White), `join_game()`
(Black), `submit_move()`, `resign_game()`, `get_game()`,
`generate_match_summary()`.

The contract embeds a complete, deterministic chess engine (move generation,
castling, en passant, promotion, check/checkmate/stalemate, insufficient
material, SAN generation), so all rules are enforced on-chain.

## Prerequisites

- Node.js ≥ 18
- The GenLayer CLI (installs the local simulator + deployment tooling):

```bash
npm install -g genlayer
```

- A GenLayer wallet with funds for testnet Bradbury (get testnet GEN from the
  [GenLayer faucet](https://faucet.genlayer.com) or the Bradbury testnet
  portal).

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
`NEXT_PUBLIC_GAME_BACKEND=genlayer`, `NEXT_PUBLIC_GENLAYER_NETWORK=testnetBradbury`
and the two signing keys (`GENLAYER_PRIVATE_KEY`, `GENLAYER_PRIVATE_KEY_2`),
then create a game from the UI — it deploys a fresh contract per game.

> Those two keys are **app-operator keys, not player keys**: the server signs
> moves on behalf of both players. Configure them once in your server env; your
> players just open a link and play.

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

- **leader_fn** runs `gl.nondet.exec_prompt(...)` with the full move list and
  winner, returning JSON `{"summary", "ok"}`.
- **validator_fn** independently re-runs the prompt on its own validator and
  accepts the leader's result only if both summaries are plausible and agree
  on the winner address (or "draw").
- If the LLM path fails, the contract stores a deterministic analysis instead,
  so the function always succeeds.

Prompts ask for 3–5 sentence analysis and strict JSON output. For production,
consider a stronger semantic-equivalence judge (e.g. comparing event lists
parsed from the moves).

## Storage

- `creator` / `opponent` — player addresses (White / Black)
- `status` — `"" | waiting | active | checkmate | stalemate | draw | resigned`
- `winner` — winning address (empty for stalemate/draw)
- `fen` — current board position (FEN)
- `moves` — `[{number, side, from, to, promotion, san}]`
- `commentary` — `[{move, side, text}]` per-move on-chain commentary
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
