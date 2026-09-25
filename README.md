# ♞ ChainMate

**ChainMate is a chess platform for playing, competing and climbing: real-time
online chess, an on-device AI opponent, server-authoritative ELO ratings,
achievements, friend lists, in-app messaging, news, and a full tournament
system with free entry events (Swiss, Knockout and Arena).**

Built with **Next.js 15 (App Router) + TypeScript (strict)**, **TailwindCSS**,
**shadcn/ui**, **react-chessboard** and **chess.js**. Optional **Nimiq**
integration powers wallet-linked paid tournaments (entry fees verified
on-chain, automatic NIM payouts to winners). Optional **Supabase** powers
accounts, ratings history, avatars and moderation tooling.

---

## Quickstart

```bash
npm install
npm run dev
# open http://localhost:3000
```

That's it. The app runs with zero configuration and zero API keys. Out of the
box you get:

- **Play vs AI**: a single-player match against the ChainMate Grandmaster —
  eight opponents from Pawn 600 through Apex 2400, plus native Stockfish
  (3200) running on-device via WebAssembly. Standard clocks available:
  1+0 bullet through 15+10 rapid, or untimed
- **Online multiplayer**: create a game, share the link, and your friend
  joins from any device. Games live in a shared server store: durable KV when
  configured, otherwise a built-in file store for zero-setup development
- **Tournaments**: create, join and run free tournaments in three formats
- **Accounts (when Supabase is configured)**: persistent rating, history,
  achievements, avatars, friends and messaging. Without it, the app runs in
  guest mode and everything else keeps working

---

## Features

### Play

- **Real-time online chess**: live move sync, clocks, resign, draw detection,
  drag & drop or tap to move, mobile friendly
- **Play vs AI**: on-device minimax engine with selectable strength, played
  through the exact same validation and commentary path as a human game
- **Live Watch feed**: every public game appears the moment it starts and
  leaves the moment it ends; recent results below
- **Matchmaking pool**: hit Search, get paired with another waiting player,
  colour chosen server-side
- **Directed challenges**: send a challenge to any player; only they can
  accept it

### Progression

- **Server-authoritative Glicko-1 ratings** (1200 start, deviation 350 → 30),
  computed only from rated games between two signed-in human players; the
  client can never edit a rating
- **Achievements**: ten codes awarded server-side from real game data
- **Leaderboards**: ranked straight from the durable profile store, so the
  list is identical for everyone
- **Profiles**: avatar upload, country flag, peak rating, streaks and full
  recent-form history

### Community

- **Friends**: search players, send/accept requests, see who is on your list
- **Messaging**: DMs between friends plus official announcements, with
  unread badges in the menu and a dedicated inbox page
- **News**: in-app announcements feed for the community
- **Admin console**: totals, per-account actions, broadcast messaging and
  support inbox for operators

### Tournaments

- **Three formats**: **Swiss** (configurable rounds, standings-based pairing
  with rematch avoidance and Buchholz tiebreaks), **Knockout** (single
  elimination with standard seeding and byes), **Arena** (continuous pairing
  during the window, one active game per player)
- **Full lifecycle**: Draft → Registration → Locked → In progress →
  Completed, plus Cancelled, all transitions server-enforced
- **Real games feed the standings**: every tournament match is an ordinary
  hosted ChainMate game; results are ingested from the authoritative game
  state, never from client claims, and processing is idempotent
- **Free by default**: paid tournaments additionally require a linked Nimiq
  wallet and a verified on-chain entry payment (see below)
- **Automatic settlement**: final rankings and payout obligations are
  computed server-side when the last game ends; a maintenance sweep handles
  expiring registration windows and scheduled starts

---

## Pages

| Route | Purpose |
| --- | --- |
| `/` | Landing page |
| `/play` | Play dashboard for signed-in players |
| `/create` | Create a game (or join the matchmaking pool) |
| `/join` | Join a game by id or share link |
| `/game/[id]` | Live board, clocks, move history, commentary |
| `/games` | Your games with rating deltas |
| `/watch` | Live broadcast feed + recent results |
| `/leaderboard` | ELO leaderboard |
| `/solo` | Play vs AI |
| `/tournaments` | Tournament browser |
| `/tournaments/create` | Host a tournament |
| `/tournaments/[id]` | Tournament detail: registration, standings, rounds |
| `/profile` | Your rating, stats, achievements, friends, wallet |
| `/players/[username]` | Public player profile |
| `/messages` | Inbox and chats |
| `/news` | Community news |
| `/auth` | Play as guest / create account / sign in |
| `/admin` | Operator console |

---

## Architecture

```
app/                        Next.js App Router
  api/hosted/games/         multiplayer game store + moves, results, ratings
  api/tournaments/          tournament lifecycle, registration, standings
  api/messages/  api/news/  community endpoints
  api/profile/avatar/       avatar upload (normalized to 256px webp)
  api/nimiq/                wallet binding + entry payment verification
components/
  ui/                       shadcn-style primitives
  game/                     board, move history, commentary, status, panels
  profile/                  header, stats, friends, wallet card
  notifications/            announcement bell + unread badges
hooks/                      use-game, use-ai-opponent, use-message-counts
lib/
  store/hosted-store.ts     client for the shared server store
  store/local-store.ts      offline backend (localStorage + BroadcastChannel)
  store/genlayer-store.ts   optional on-chain backend
  server/hosted.ts          authoritative game service (KV or file store)
  server/tournaments.ts     tournament engine: lifecycle, pairing, standings
  server/tournament-settlement.ts   completion, rankings, payout planning
  server/messages.ts        friends-gated messaging service
  ratings.ts                Glicko-1 (do not modify; tournament scores are separate)
  nimiq/                    config, verification, payout dispatch
lib/server/nimiq/           verification pipeline + payout node client
supabase/migrations/        full SQL schema, applied in filename order
tests/node/                 node:test suites (344 tests)
contracts/                  optional GenLayer contract (legacy backend)
```

### Two backends, one interface

Hosted multiplayer is the default and the product; the local browser backend
exists for offline demos. Both implement the same `GameStore` interface and
share the same pure rules (`lib/game-logic.ts`). The store uses:

- **Durable KV** (Vercel KV / Upstash) when `KV_REST_API_URL` +
  `KV_REST_API_TOKEN` are set, with Supabase as the durable mirror and the
  cross-instance lock
- Otherwise a **built-in file store** (`.data/`, gitignored) for local dev and
  previews. On multi-instance serverless hosting without KV, add KV: the file
  store is per-instance

### Optional GenLayer backend

`lib/store/genlayer-store.ts` and `contracts/chainmate.py` implement a legacy
on-chain backend where each game is its own GenLayer intelligent contract
(move validation by consensus, LLM match summaries). It is not required for
any current product flow; see `contracts/README.md` if you want to run it.

---

## Player accounts (identity & progression)

Accounts are built on **Supabase** (email one-time-code auth, Postgres
profiles, achievements, game history) and are fully optional:

- **Guests are guests.** A per-device identity (`Guest_XXXX`) keeps a live
  hosted game alive across refreshes, but guest games are casual: no rating,
  no streaks, no persistent record
- **Accounts start fresh.** Creating an account makes a brand-new profile at
  1200 ELO; guest history is never merged or carried over
- **Ratings are server-authoritative.** Glicko-1, peak rating, streaks and the
  achievement codes are computed and written only by the server from completed
  rated games between two signed-in accounts

### Enabling accounts

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key (client) |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret service-role key (server only) |

1. Create a project at [supabase.com](https://supabase.com), enable the Email
   provider
2. Set the three variables above
3. In the Supabase SQL editor, paste `supabase/RUN_ALL.sql` and click Run
   (one file, everything included; see the next section)
4. Redeploy. Until the keys exist the app stays in guest mode

## Database migrations

The easy path: `supabase/RUN_ALL.sql` is every migration bundled into one
file. Paste it into the Supabase SQL editor and Run. It is safe to run more
than once: every migration is idempotent, so re-running the whole bundle
never duplicates or destroys anything.

The individual files in `supabase/migrations/` are applied top to bottom when
run one at a time; regenerate the bundle after adding one with
`npm run db:bundle`.

| Migration | Creates |
| --- | --- |
| `0001_init.sql` | `profiles`, `games`, `player_achievements` with RLS |
| `0002_game_snapshots.sql` | full game snapshots for durability |
| `0003_identity_social.sql` | rating deviation, last-played tracking |
| `0004_profiles_nullable_user_id.sql` | guest profile rows |
| `0005_cascade_player_data.sql` | delete-account cascades |
| `0006_tournaments.sql` | tournaments, entries, matches, standings |
| `0007_nimiq_wallet_binding.sql` | wallet bindings + signed challenges |
| `0008_nimiq_transactions.sql` | entry transaction consumption ledger |
| `0009_nimiq_tournament_economy.sql` | `tournament_payouts` state machine |
| `0010_payout_dispatch.sql` | write-ahead payout dispatch |
| `0011_avatars.sql` + `0011_tournament_schedule.sql` | avatar column + public `avatars` bucket; scheduled starts |
| `0012_tournament_lifecycle.sql` | cancel reason, minimum field, refund ledger |
| `0013_tournament_auto_start.sql` | start-when-full flag |

---

## Nimiq production setup

Paid tournaments move **real NIM**: players pay entry fees from a Nimiq Pay
wallet, the server verifies the on-chain transaction, and winners are paid
from a treasury node. Free tournaments never require a wallet. All variable
names below are exactly as read by the code (`lib/nimiq/config.ts`,
`lib/server/nimiq/payout-config.ts`, `lib/server/nimiq/rpc.ts`).

### Storage requirement

Wallet bindings, the transaction-consumption ledger, the payout ledger and the
tournament documents live in the project storage abstraction: **durable KV
when configured, otherwise the `.data` file store**. Supabase mirrors the
durable state and holds the cross-instance unique constraints. For production
(multi-instance serverless), set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

### Verification RPC (entry payments)

The server verifies every entry transaction through your own Nimiq node;
there is deliberately no public endpoint default:

- `NIMIQ_RPC_URL`: JSON-RPC endpoint of a **full or history node**
- `NIMIQ_RPC_BASIC_AUTH`: optional, `user:password`
- `NIMIQ_CONFIRMATIONS_REQUIRED`: confirmations before an entry counts
  (default `10`)

### Payout node (treasury)

Payouts are broadcast by a **dedicated Nimiq node whose keystore holds the
treasury hot key**:

- `NIMIQ_PAYOUT_RPC_URL`: JSON-RPC endpoint of the payout node (unset =
  payout dispatch deliberately off, a typed 503)
- `NIMIQ_PAYOUT_RPC_BASIC_AUTH`: optional, `user:password`
- `NIMIQ_PAYOUT_TREASURY_ADDRESS`: the NQ… address the node signs from
- `NIMIQ_PAYOUT_CONFIRMATIONS_REQUIRED`: default `10`

**Security model:** treasury private keys live only inside the payout node's
keystore. They must never be placed in environment variables, application
code, the browser bundle, or logs.

### Treasury address & network

- `NEXT_PUBLIC_NIMIQ_TREASURY_ADDRESS`: (client) the address players pay to
- `NIMIQ_TREASURY_ADDRESS`: (server) canonical authority for verification;
  when set it wins over the client-side variable
- `NEXT_PUBLIC_NIMIQ_NETWORK`: `test` (default) or `main`; must match both
  nodes' networks
- `NEXT_PUBLIC_NIMIQ_ENABLED`: `true` to show the Nimiq UI at all

> **Set BOTH treasury variables to the SAME NQ… address.** The client pays
> using the build-time value; the server credits entries against the server
> value. The default network is `test` (TestAlbatross) so a misconfiguration
> can never point money code at mainnet. Rehearse the complete flow on testnet
> (faucet: `https://faucet.pos.nimiq-testnet.com`) before touching mainnet.

---

## Tests

```bash
npm test          # 344 node:test suites, fully offline
npx tsc --noEmit  # strict typecheck
```

The suites cover the chess rules, hosted store, ratings, tournament engine
(lifecycle, pairing, settlement), messaging, and the full Nimiq
verification/refund pipeline with real signatures over real challenges.

---

## Project structure

```
├── app/                  # routes, pages, API handlers
├── components/           # UI primitives + game/profile/notification components
├── hooks/                # use-game, use-ai-opponent, use-message-counts
├── lib/                  # stores, ratings, tournament engine, Nimiq pipeline
├── supabase/migrations/  # full SQL schema, applied in filename order
├── tests/node/           # node:test suites
├── contracts/            # optional legacy GenLayer contract
└── public/               # static assets
```

## Tech stack

Next.js 15 · TypeScript (strict) · TailwindCSS 3 · shadcn/ui ·
react-chessboard 5 · chess.js 1 · Supabase · Nimiq · node:test
