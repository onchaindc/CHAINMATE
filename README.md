# ♞ ChainMate

**ChainMate is a GenLayer-powered chess dApp where two players play chess and
receive AI-generated commentary and post-game analysis.**

Every move is validated by an on-chain **intelligent contract** written in
Python for the GenLayer network (testnet Bradbury). The contract embeds a full
chess engine — move legality, turn order, check, checkmate, stalemate, en
passant, castling and promotion are all enforced by consensus, not by the app.
When a game ends, the contract asks the GenLayer validators' own LLMs to write
and cross-check the match analysis (`generate_match_summary`).

Built with **Next.js 15 (App Router) + TypeScript**, **TailwindCSS**,
**shadcn/ui**, **react-chessboard**, **chess.js** and **genlayer-js**.

---

## Quickstart

```bash
npm install
npm run dev
# open http://localhost:3000
```

That's it — **the app runs with zero configuration and zero API keys.** Out of
the box you get:

- **Play vs AI** — a single-player match against the on-device chess engine
  (no opponent, no setup, works anywhere)
- **Online multiplayer (default)** — create a game, share the link, and a
  friend joins as Black from any device. Games live in a shared server store:
  Vercel KV when configured, otherwise a built-in file store (`.data/games.json`,
  gitignored) that works in previews and containers with zero setup.
- **Local two-player mode** — game state lives in the browser (localStorage)
  and syncs across tabs via `BroadcastChannel`, for quick same-browser play

To play on the actual GenLayer chain, see
[Playing on GenLayer](#playing-on-genlayer).

### Instant single-player (Play vs AI)

1. Open `/solo` (or hit **Play vs AI** on the landing page).
2. Pick an opponent — **Pawn** (600) through **Zenith** (2000), a 1- to 3-ply
   search with a shrinking chance of a deliberate blunder.
3. Play White against the AI (Black). It moves through the exact same
   validation + commentary path as a human, entirely in your browser.

### Two-player online demo

1. Open `http://localhost:3000/create` → **Create game** (you are White).
2. Copy the share link and send it to a friend — or open it in a **second
   tab** of your browser (each tab gets its own identity, so it joins as
   Black). Works across devices out of the box.
3. Play! Moves, commentary and results sync live between the players.

---

## Features

- **Play vs AI** — single-player mode with an on-device minimax engine
- **Create / Join games** — one-click flows, no accounts required
- **Real-time chess board** — live updates for both players
- **On-chain move validation** — full chess rules enforced by the contract
- **Move history** — SAN notation, auto-scrolling, highlighted latest move
- **Check / checkmate / stalemate / draw detection** — clear status indicators
- **Resignation** — end the game anytime
- **AI commentary panel** — per-move commentary from the chain, plus optional
  LLM-enhanced insights
- **End-game AI summary** — 3–5 sentence match analysis, written on-chain by
  the GenLayer validators' LLMs
- **Mobile responsive** — click-to-move + drag & drop, tap friendly

---

## Player accounts (identity & progression)

ChainMate has a permanent identity layer built on **Supabase** (email
one-time-code auth, Postgres profiles, achievements, game history) — fully
optional and key-gated:

- **Guests are guests.** A per-device identity (`Guest_XXXX`) is created so
  a live hosted game survives a refresh, but guest games are **casual**:
  they never touch ratings, streaks, achievements or any persistent record.
  A guest's rating stays at the provisional 1200 with zero games — nothing
  is hardcoded or accumulated on their behalf.
- **Accounts start fresh.** From the navbar menu (or the banner on
  Games/Profile) a guest creates an account with a username + email. The
  one-time code signs them in and the server creates a **brand-new profile
  at 1200 ELO** with its own player id — guest history is never merged,
  imported or carried over.
- **Signed-in players** keep their account games across devices; sign-in
  sessions persist across refreshes.
- **Ratings & achievements are server-authoritative**: Glicko-1 (1200
  start, rating deviation 350 → 30), peak rating, win/loss streaks and the
  10 achievement codes are computed and written only by the server from
  completed rated games between two signed-in accounts. The client can
  never edit them.

### Enabling accounts (optional)

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL (`https://<project>.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key (client) |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret service-role key (server only — never expose) |

1. Create a free project at [supabase.com](https://supabase.com) →
   **Authentication** → enable **Email** provider (magic link / OTP).
2. Copy the three values above into your env (Freebuff: Keys / API keys panel;
   Vercel: Project → Settings → Environment Variables).
3. Run `supabase/migrations/0001_init.sql` once in the Supabase SQL editor
   (creates `profiles`, `games`, `player_achievements` with RLS).
4. Redeploy. Until these keys exist the app simply stays in guest mode —
   everything else keeps working.

Without Supabase keys, guests still get a stable per-device id (so a live
match survives a refresh), but their games stay casual and nothing is
rated or recorded; the account layer is what unlocks username, a persistent
rating and cross-device history.

---

## Pages

| Route            | Purpose                                              |
| ---------------- | ---------------------------------------------------- |
| `/`              | Landing page                                         |
| `/create`        | Create a game (you play White)                       |
| `/join`          | Join a game by id or share link (you play Black)     |
| `/game/[id]`     | Live board, clocks, move history, commentary — the    |
|                  | page becomes a replay with a result modal when it ends |
| `/games`         | Your real games (with rating deltas)                 |
| `/watch`         | Live broadcast feed (every active game) + recent     |
| `/leaderboard`   | Real ELO leaderboard                                 |
| `/profile`       | Your rating, streaks, achievements, recent games     |
| `/auth`          | Play as guest / create account / sign in             |

## Game page layout

- **Left:** Black player (name / rating / clock) → large chess board → White
  player, resign button, replay controls when the game ends
- **Right:** match console — move history, analysis, game info (tabbed on
  mobile)
- **On game end:** a result modal (You won / You lost / Draw + termination
  reason, real rating changes, earned achievements, summary) opens over the
  same URL, and the board becomes a replay

## Watch & live broadcast

Every hosted game is **public by default** and is automatically registered in
Watch's live feed the moment it starts (move count updates in real time) and
removed the moment it ends — no manual "publish" step. Games created as
**Private** stay out of the broadcast but still work through their share link.

---

## Architecture

```
app/                        Next.js App Router
  page.tsx                  landing page
  create/  join/  game/[id] game flows
  api/games/                on-chain game actions (create/join/move/resign/summary)
  api/hosted/games/         shared multiplayer store (Vercel KV or file store)
  api/ai/                   optional LLM commentary/summary
components/
  ui/                       shadcn-style primitives
  landing/                  marketing sections
  game/                     board, move history, commentary, status, panels
hooks/
  use-game.ts               game state, live subscription, actions
  use-ai-commentary.ts      LLM commentary for the latest move
  use-ai-opponent.ts        drives the single-player AI opponent
lib/
  chess.ts                  chess.js helpers
  ai-engine.ts              on-device chess AI (minimax + alpha-beta)
  game-logic.ts             shared pure game rules (all stores use this)
  commentary.ts             rule-based commentary engine
  summary.ts                rule-based match summary
  store/local-store.ts      offline backend (localStorage + BroadcastChannel + AI games)
  store/hosted-store.ts     shared multiplayer backend (talks to /api/hosted/games)
  store/genlayer-store.ts   on-chain backend (talks to /api/games)
  server/hosted.ts          Vercel KV-backed game store
  server/genlayer.ts        genlayer-js: deploy, read, write, receipt handling
  server/ai.ts              OpenAI-compatible LLM calls
contracts/
  chainmate.py              the GenLayer intelligent contract (Python)
```

### Three backends, one interface

All stores implement the same `GameStore` interface (create/join/move/resign/
summary/subscribe) and share the same pure game rules (`lib/game-logic.ts`),
so the app behaves identically on every backend. The game id decides the
backend automatically: `local_…` → browser store, `hosted_…` → shared server
store, `0x…` → GenLayer contract.

| | Hosted mode (default) | Local mode | GenLayer mode |
| --- | --- | --- | --- |
| State | shared server store (Vercel KV or file store) | localStorage + BroadcastChannel | the smart contract |
| Cross-device | yes | no (same browser only) | yes |
| Single-player AI | yes (local engine) | yes | yes |
| Setup | none (KV optional for production) | none | deploy contract + 2 signing keys |
| Move latency | instant | instant | seconds (testnet) |
| Verifiability | demo | demo | full on-chain |

Set `NEXT_PUBLIC_GAME_BACKEND=local` (or `genlayer`) to change the default
backend; game ids are auto-detected either way.

---

## Playing across devices

Multiplayer is the **default** mode: games live in a shared server store, so a
link created on your laptop opens and joins fine on a phone — no "Game not
found" when a friend taps the invite. The store uses:

- **Vercel KV** (Upstash Redis) when `KV_REST_API_URL` + `KV_REST_API_TOKEN`
  are set — the durable production path (Vercel → Storage → KV injects them
  automatically once attached; on Freebuff, paste them into the Keys / API
  keys panel).
- Otherwise, a **built-in file store** (`.data/games.json`, gitignored) —
  zero-configuration cross-device play in previews, containers and local dev.

> Note: the file store persists per instance. On multi-instance serverless
> hosting without KV, games can be lost between cold starts — add Vercel KV
> for durable production multiplayer.

To play on-chain instead, see [Playing on GenLayer](#playing-on-genlayer).

---

## Playing on GenLayer

The smart contract lives in [`contracts/chainmate.py`](contracts/chainmate.py)
— see [contracts/README.md](contracts/README.md) for the full deployment guide
(CLI install, localnet simulator, testnet Bradbury, funding, fees).

### 1. Set the environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `NEXT_PUBLIC_GAME_BACKEND` | no | `hosted` (default, shared server store), `local`, or `genlayer` |
| `KV_REST_API_URL` | production | Vercel KV REST endpoint (Upstash Redis) — durable multiplayer |
| `KV_REST_API_TOKEN` | production | Vercel KV REST token — durable multiplayer |
| `NEXT_PUBLIC_GENLAYER_NETWORK` | no | `testnetBradbury` (default), `localnet`, `studionet`, `testnetAsimov` |
| `NEXT_PUBLIC_GENLAYER_RPC_URL` | no | RPC override (defaults to the network's public RPC) |
| `GENLAYER_PRIVATE_KEY` | genlayer mode | hex private key of the app's **White** signing account (also deploys games) |
| `GENLAYER_PRIVATE_KEY_2` | genlayer mode | hex private key of the app's **Black** signing account (must be a different address) |
| `NEXT_PUBLIC_AI_ENABLED` | no | `true` to enable LLM-enhanced commentary in the UI |
| `AI_API_KEY` | AI features | OpenAI-compatible API key |
| `AI_BASE_URL` | no | default `https://api.openai.com/v1` |
| `AI_MODEL` | no | default `gpt-4o-mini` |
| `NEXT_PUBLIC_SUPABASE_URL` | accounts | Supabase project URL — enables player accounts (see [Player accounts](#player-accounts-identity--progression)) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | accounts | Supabase public anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | accounts | Supabase service-role key (server only) |

**Who needs these keys? Only the app operator — your players never touch them.**

> **Why are there two "player" keys?** This MVP signs moves *server-side* instead
> of in the browser, so the app itself needs two GenLayer accounts to act as the
> two players: `GENLAYER_PRIVATE_KEY` is the **White** account (the game creator,
> which also deploys each game's contract) and `GENLAYER_PRIVATE_KEY_2` is the
> **Black** account. Every on-chain game reuses these same two accounts — that is
> exactly why real players need *nothing*: no wallet, no key, no sign-up. A player
> just opens your invite link and plays. The production upgrade is browser-wallet
> signing (MetaMask via `genlayer-js`), where each player signs their own moves
> with their own wallet and these server keys disappear entirely.

> **On Freebuff**, paste `GENLAYER_PRIVATE_KEY` / `GENLAYER_PRIVATE_KEY_2` /
> `AI_API_KEY` into the project's Keys / API keys panel. The app reads them
> from server-side env vars at runtime — never commit secrets.

### 2. How on-chain play works

- **Create game** → the server deploys a fresh `ChainMate` contract (one
  contract = one game) and calls `create_game()` — the deployer's key is White.
- **Join game** → the server signs `join_game()` with `GENLAYER_PRIVATE_KEY_2`
  (Black). Both keys must be distinct addresses, or the contract rejects the join.
- **Every move** → `submit_move(from, to, promotion)` is validated by the
  contract's embedded chess engine, stored on-chain with SAN + commentary.
- **Game over** → `generate_match_summary()` runs a non-deterministic LLM block:
  each GenLayer validator independently writes the analysis with its own LLM and
  cross-checks the result (Optimistic Democracy). Can take ~1 minute; the UI
  shows a progress state.

> Browser-wallet signing (MetaMask via `genlayer-js`) is the natural production
> upgrade; the current MVP signs server-side so two-player play works with just
> env keys.

---

## AI features

| Feature | Without any key (default) | With `AI_API_KEY` + `NEXT_PUBLIC_AI_ENABLED=true` |
| --- | --- | --- |
| Move commentary | built-in rule engine (captures, checks, center control, castling…) | LLM commentary for each new move via `/api/ai` |
| Match summary | rule-based analysis (local mode) / deterministic fallback (on-chain) | LLM summary via `/api/ai` (local mode); on-chain LLM summary is always used by the contract |

The GenLayer contract's `generate_match_summary()` uses the network's own LLM
consensus regardless of app-level AI keys.

---

## Contract functions

```python
create_game()               # initialise the game; creator = White
join_game()                 # second player joins as Black
submit_move(from, to, prom) # validate & store a move (full chess rules)
resign_game()               # resign; opponent wins
get_game()                  # read state: players, fen, moves, commentary, summary
generate_match_summary()    # LLM post-game analysis with validator cross-check
```

Storage: players, move history (SAN + squares), game status, winner, AI
commentary entries, and the final match summary.

---

## Project structure

```
├── app/                  # routes, pages, API handlers
├── components/           # UI primitives + landing + game components
├── hooks/                # use-game, use-ai-commentary
├── lib/                  # chess helpers, commentary, stores, GenLayer SDK wrapper
├── contracts/            # chainmate.py — GenLayer intelligent contract
├── public/               # static assets
├── tailwind.config.ts    # dark chess-club theme
└── components.json       # shadcn/ui config
```

## Tech stack

Next.js 15 · TypeScript (strict) · TailwindCSS 3 · shadcn/ui · react-chessboard 5 ·
chess.js 1 · genlayer-js · Python 3 (GenVM intelligent contract)
