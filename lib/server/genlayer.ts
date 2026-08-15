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
import type { GameState } from "@/lib/types";

/**
 * Server-side GenLayer integration. genlayer-js runs only in Node (route
 * handlers); the browser talks to these routes via fetch.
 *
 * Signing keys come from server env vars:
 *   GENLAYER_PRIVATE_KEY    — player 1 (White / game creator), deploys games
 *   GENLAYER_PRIVATE_KEY_2  — player 2 (Black), optional second key
 */

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
    summary: String(r.summary ?? ""),
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
  const contractAddress = decoded?.contractAddress ?? hash;
  return { address: contractAddress, myId: account.address };
}

/** Full create flow: deploy a contract, then initialise it (deployer = White). */
export async function createGameOnChain(): Promise<{ game: GameState; myId: string }> {
  const { address, myId } = await deployChainMate();
  const created = await writeGame(address, "create_game", [], 1);
  return { game: created, myId };
}

export async function getGameOnChain(id: string): Promise<GameState | null> {
  try {
    return await readGameRaw(id);
  } catch {
    return null;
  }
}

export async function joinGameOnChain(id: string): Promise<GameState> {
  return writeGame(id, "join_game", [], 2);
}

export async function submitMoveOnChain(
  id: string,
  from: string,
  to: string,
  promotion: string | undefined,
  player: 1 | 2,
): Promise<GameState> {
  return writeGame(id, "submit_move", [from, to, promotion ?? ""], player);
}

export async function resignGameOnChain(id: string, player: 1 | 2): Promise<GameState> {
  return writeGame(id, "resign_game", [], player);
}

export async function generateSummaryOnChain(id: string): Promise<GameState> {
  // Signed by White (creator); the contract only requires the game to be over.
  return writeGame(id, "generate_match_summary", [], 1);
}

export function signerAddress(which: 1 | 2): string {
  return getSigner(which).address;
}
