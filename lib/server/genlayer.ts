import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient, createAccount } from "genlayer-js";
import {
  localnet,
  studionet,
  testnetAsimov,
  testnetBradbury,
} from "genlayer-js/chains";
import {
  ExecutionResult,
  TransactionStatus,
  type CalldataEncodable,
  type DecodedDeployData,
  type GenLayerTransaction,
  type TransactionHash,
} from "genlayer-js/types";
import type { Address } from "viem";
import { GENLAYER_NETWORK, GENLAYER_RPC_URL } from "@/lib/config";
import { getGameStorage } from "@/lib/server/storage";
import type { GameState } from "@/lib/types";

/**
 * Server-side GenLayer integration. genlayer-js runs only in Node (route
 * handlers); the browser talks to these routes via fetch.
 *
 * Signing keys come from server env vars:
 *   GENLAYER_PRIVATE_KEY    — player 1 (White / game creator), deploys games
 *   GENLAYER_PRIVATE_KEY_2  — player 2 (Black), optional second key
 *
 * The contract binds every move/resignation to the authenticated transaction
 * sender. This wrapper never lets the caller choose a signing key: each game
 * records which app identity created (White) and joined (Black) it, and the
 * signing key is resolved server-side from that binding — the caller can only
 * act as themselves.
 */

/** game address → { creatorPlayerId, opponentPlayerId } (app identities). */
const bindingKeyFor = (address: string) => `chainmate:genlayer:binding:${address}`;

interface GameBinding {
  creatorPlayerId: string;
  opponentPlayerId: string;
}

async function readBinding(address: string): Promise<GameBinding | null> {
  const raw = await getGameStorage().get(bindingKeyFor(address));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GameBinding;
  } catch {
    return null;
  }
}

async function writeBinding(address: string, binding: GameBinding): Promise<void> {
  await getGameStorage().set(bindingKeyFor(address), JSON.stringify(binding));
}

/**
 * Resolve the server signing key for a player on a given game. The caller
 * sends their own app identity (never a slot number): White is whoever
 * created the game, Black is whoever joined — recorded server-side at those
 * moments, so a client can never request the opponent's key.
 */
async function signerForPlayer(address: string, playerId: string): Promise<1 | 2> {
  const binding = await readBinding(address);
  if (binding && playerId && binding.creatorPlayerId === playerId) return 1;
  if (binding && playerId && binding.opponentPlayerId === playerId) return 2;
  throw new Error("You are not a player in this game");
}

const CONTRACT_PATH = path.join(process.cwd(), "contracts", "chainmate.py");

const CHAINS = {
  localnet,
  studionet,
  testnetAsimov,
  testnetBradbury,
} as const;

export function contractSource(): string {
  return readFileSync(CONTRACT_PATH, "utf8");
}

export function getChain() {
  return CHAINS[GENLAYER_NETWORK as keyof typeof CHAINS] ?? testnetBradbury;
}

/** Public read client — no wallet needed. */
export function getReadClient() {
  return createClient({
    chain: getChain(),
    ...(GENLAYER_RPC_URL ? { endpoint: GENLAYER_RPC_URL } : {}),
  });
}

export function getSigner(which: 1 | 2) {
  const key =
    which === 1
      ? process.env.GENLAYER_PRIVATE_KEY
      : process.env.GENLAYER_PRIVATE_KEY_2 ?? process.env.GENLAYER_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      `GENLAYER_PRIVATE_KEY${which === 2 ? "_2" : ""} is not set — add it in the project's environment settings to play on-chain.`,
    );
  }
  return createAccount(key as `0x${string}`);
}

function normalizeGame(raw: unknown, id: string): GameState {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    id,
    creator: String(r.creator ?? ""),
    opponent: String(r.opponent ?? ""),
    status: (r.status as GameState["status"]) ?? "waiting",
    winner: String(r.winner ?? ""),
    fen: String(r.fen ?? ""),
    moves: Array.isArray(r.moves) ? (r.moves as GameState["moves"]) : [],
    commentary: Array.isArray(r.commentary)
      ? (r.commentary as GameState["commentary"])
      : [],
    // The contract's `summary` is produced by generate_match_summary — an
    // on-chain LLM call under validator consensus. That is completed analysis,
    // not the deterministic fallback, so it belongs in `analysis`; `summary` is
    // reserved for rule-derived text and this backend never produces any.
    summary: "",
    analysis: String(r.summary ?? "") || undefined,
    backend: "genlayer",
  };
}

async function readGameRaw(address: string): Promise<GameState> {
  const client = getReadClient();
  const result = (await client.readContract({
    address: address as Address,
    functionName: "get_game",
    args: [],
    jsonSafeReturn: true,
  })) as Record<string, unknown>;
  return normalizeGame(result, address);
}

function receiptError(receipt: GenLayerTransaction): string {
  const leader = receipt.consensus_data?.leader_receipt?.[0];
  const stderr = leader?.error ?? "";
  if (stderr) {
    // Contract asserts surface here, e.g. "Illegal move" / "It is not your turn".
    return stderr.trim();
  }
  const resultName = receipt.resultName ?? "unknown result";
  return `transaction ended with ${resultName}`;
}

async function waitForWrite(hash: `0x${string}`, label: string): Promise<GenLayerTransaction> {
  const client = getReadClient();
  const receipt = await client.waitForTransactionReceipt({
    hash: hash as TransactionHash,
    status: TransactionStatus.FINALIZED,
    interval: 3000,
    retries: 60,
  });
  if (receipt.txExecutionResultName === ExecutionResult.FINISHED_WITH_ERROR) {
    throw new Error(`On-chain ${label} failed: ${receiptError(receipt)}`);
  }
  return receipt;
}

async function writeGame(
  address: string,
  functionName: string,
  args: CalldataEncodable[],
  which: 1 | 2,
): Promise<GameState> {
  const client = getReadClient();
  const account = getSigner(which);
  const hash = await client.writeContract({
    account,
    address: address as Address,
    functionName,
    args,
    value: BigInt(0),
  });
  await waitForWrite(hash, functionName);
  return readGameRaw(address);
}

/** Deploys a fresh ChainMate contract (one contract = one game). */
export async function deployChainMate(): Promise<{ address: string; myId: string }> {
  const client = getReadClient();
  const account = getSigner(1);
  const hash = await client.deployContract({ account, code: contractSource() });
  const receipt = await waitForWrite(hash, "deploy");
  const decoded = receipt.txDataDecoded as DecodedDeployData | undefined;
  const contractAddress = decoded?.contractAddress;
  if (!contractAddress || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
    // Never fall back to the tx hash: a hash is not a contract address, so
    // the game id would be dead and every read would report "Game not found".
    throw new Error(
      "Could not determine the deployed contract address from the deploy receipt. " +
        "The GenLayer RPC may be misconfigured or the deployment is still finalising — please retry.",
    );
  }
  return { address: contractAddress, myId: account.address };
}

/** Full create flow: deploy a contract, then initialise it (deployer = White). */
export async function createGameOnChain(
  playerId: string,
): Promise<{ game: GameState; myId: string }> {
  const { address, myId } = await deployChainMate();
  const created = await writeGame(address, "create_game", [], 1);
  await writeBinding(address, { creatorPlayerId: playerId, opponentPlayerId: "" });
  return { game: created, myId };
}

export async function getGameOnChain(id: string): Promise<GameState | null> {
  try {
    return await readGameRaw(id);
  } catch {
    return null;
  }
}

export async function joinGameOnChain(id: string, playerId: string): Promise<GameState> {
  const game = await writeGame(id, "join_game", [], 2);
  const binding = (await readBinding(id)) ?? { creatorPlayerId: "", opponentPlayerId: "" };
  await writeBinding(id, { ...binding, opponentPlayerId: playerId });
  return game;
}

export async function submitMoveOnChain(
  id: string,
  from: string,
  to: string,
  promotion: string | undefined,
  playerId: string,
): Promise<GameState> {
  const which = await signerForPlayer(id, playerId);
  return writeGame(id, "submit_move", [from, to, promotion ?? ""], which);
}

export async function resignGameOnChain(id: string, playerId: string): Promise<GameState> {
  const which = await signerForPlayer(id, playerId);
  return writeGame(id, "resign_game", [], which);
}

export async function generateSummaryOnChain(id: string): Promise<GameState> {
  // Signed by White (creator); the contract only requires the game to be over.
  return writeGame(id, "generate_match_summary", [], 1);
}

export function signerAddress(which: 1 | 2): string {
  return getSigner(which).address;
}

// ── Post-game analysis for hosted games ───────────────────────

const ANALYZER_CONTRACT_PATH = path.join(process.cwd(), "contracts", "analyze.py");

function analyzerContractSource(): string {
  return readFileSync(ANALYZER_CONTRACT_PATH, "utf8");
}

/**
 * Check whether GenLayer signing keys are configured.
 * Used by the hosted backend to decide whether to call GenLayer for analysis.
 */
export function genlayerKeysAvailable(): boolean {
  return !!process.env.GENLAYER_PRIVATE_KEY;
}

/**
 * Deploy a lightweight ChainMateAnalyzer contract, load a finished game's
 * data into it, and generate LLM-powered analysis via GenLayer validator
 * consensus (Optimistic Democracy).
 *
 * This is the server-side entry point for hosted game post-game analysis.
 * Returns the analysis text string, or throws on failure.
 *
 * Flow:
 * 1. Deploy contracts/analyze.py on GenLayer testnet Bradbury
 * 2. Call load_game(movesJson, status, winner) to populate the contract
 * 3. Call generate_analysis() — triggers gl.nondet.exec_prompt (LLM consensus)
 * 4. Read the summary back via get_summary()
 * 5. Return the analysis text
 */
export async function analyzeGameOnChain(game: {
  moves: { san: string; side: string; number: number }[];
  status: string;
  winner: string;
}): Promise<string> {
  const client = getReadClient();
  const account = getSigner(1);

  // Step 1: Deploy the analyzer contract
  console.log("[genlayer:analyze] deploying analyzer contract...");
  const deployHash = await client.deployContract({
    account,
    code: analyzerContractSource(),
  });
  const deployReceipt = await waitForWrite(deployHash, "deploy analyzer");
  const decoded = deployReceipt.txDataDecoded as DecodedDeployData | undefined;
  const analyzerAddress = decoded?.contractAddress;
  if (!analyzerAddress || !/^0x[0-9a-fA-F]{40}$/.test(analyzerAddress)) {
    throw new Error("Could not determine analyzer contract address from deploy receipt");
  }
  console.log(`[genlayer:analyze] deployed analyzer at ${analyzerAddress}`);

  // Step 2: Load game data into the analyzer
  const movesJson = JSON.stringify(
    game.moves.map((m) => ({ number: m.number, san: m.san, side: m.side })),
  );
  console.log(`[genlayer:analyze] loading ${game.moves.length} moves into analyzer...`);
  const loadHash = await client.writeContract({
    account,
    address: analyzerAddress as Address,
    functionName: "load_game",
    args: [movesJson, game.status, game.winner],
    value: BigInt(0),
  });
  await waitForWrite(loadHash, "load_game");
  console.log("[genlayer:analyze] game data loaded, generating analysis...");

  // Step 3: Generate analysis (this is the slow part — GenLayer LLM consensus)
  const analyzeHash = await client.writeContract({
    account,
    address: analyzerAddress as Address,
    functionName: "generate_analysis",
    args: [],
    value: BigInt(0),
  });
  await waitForWrite(analyzeHash, "generate_analysis");
  console.log("[genlayer:analyze] analysis generated, reading summary...");

  // Step 4: Read the summary
  const summary = (await client.readContract({
    address: analyzerAddress as Address,
    functionName: "get_summary",
    args: [],
    jsonSafeReturn: true,
  })) as string;

  if (!summary || typeof summary !== "string" || summary.length < 20) {
    throw new Error("GenLayer analysis returned empty or invalid summary");
  }

  console.log(`[genlayer:analyze] analysis complete (${summary.length} chars)`);
  return summary;
}

/** The moves/result an analysis request needs. */
export interface AnalyzableGame {
  moves: { san: string; side: string; number: number }[];
  status: string;
  winner: string;
}

/**
 * The post-game analysis dependency, as the hosted backend sees it.
 *
 * `summarizeHostedGame` takes one of these rather than calling GenLayer
 * directly, so the decision to analyse can be exercised end to end without a
 * testnet round trip (tests/node/hosted-analysis.test.ts). `genlayerAnalyzer`
 * below is the production binding and the default at every call site.
 */
export interface GameAnalyzer {
  /** Whether analysis can be attempted at all on this deployment. */
  available(): boolean;
  /** Produce the analysis text, or throw. */
  analyze(game: AnalyzableGame): Promise<string>;
}

/** Production binding: real signing keys, real on-chain analyzer contract. */
export const genlayerAnalyzer: GameAnalyzer = {
  available: genlayerKeysAvailable,
  analyze: analyzeGameOnChain,
};

