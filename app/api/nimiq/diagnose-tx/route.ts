import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/server/auth";
import { getTransactionByHash } from "@/lib/server/nimiq/rpc";
import { getServerNimiqRpcConfig, getCanonicalTreasuryAddress } from "@/lib/nimiq/config";
import {
  classifyTxLookup,
  txLookupLabel,
  type DiagnosticRpcTx,
} from "@/lib/nimiq/payment-diagnostic";

export const runtime = "nodejs";

/**
 * TEMPORARY diagnostic endpoint for the "Test 0.1 NIM Payment" action.
 *
 * Accepts the transaction hash the wallet returned and looks it up on the
 * configured Nimiq node (the SAME getTransactionByHash client the production
 * verifier uses). Reports where the hash actually stands — receiving a hash
 * from the wallet proves only that the wallet handed one back.
 *
 * This is a lookup ONLY: it consumes nothing, writes nothing, and never
 * touches the production verifier's obligations or store. Delete alongside
 * the UI entry when the capability question is answered.
 *
 * POST { playerId, txHash } → { status, label, confirmations, tx? , rpcConfigured }
 */
interface DiagnoseBody {
  playerId?: string;
  txHash?: string;
}

export async function POST(req: NextRequest) {
  let body: DiagnoseBody;
  try {
    body = (await req.json()) as DiagnoseBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const claimed = typeof body.playerId === "string" ? body.playerId.trim() : "";
  const acting = await resolveActingPlayer(req, claimed);
  if (!acting.ok) {
    return NextResponse.json({ error: acting.error }, { status: acting.status });
  }
  const txHash = (body.txHash ?? "").trim().replace(/^0x/i, "");
  // Nimiq tx hashes are 64-char hex (Blake2b). The node's RPC wants the bare
  // hex form, so a 0x-prefixed paste is stripped rather than rejected.
  if (!/^[0-9a-fA-F]{32,128}$/.test(txHash)) {
    return NextResponse.json({ error: "That does not look like a transaction hash" }, { status: 400 });
  }

  const rpc = getServerNimiqRpcConfig();
  if (!rpc) {
    return NextResponse.json(
      {
        status: "not-yet-found",
        label: "No Nimiq RPC node is configured on this deployment (NIMIQ_RPC_URL missing), so the hash cannot be looked up.",
        confirmations: 0,
        rpcConfigured: false,
        treasury: getCanonicalTreasuryAddress() || null,
      },
      { status: 200 },
    );
  }

  try {
    const tx = await getTransactionByHash(txHash);
    const { status, confirmations } = classifyTxLookup(
      tx as DiagnosticRpcTx | null,
      rpc.confirmationsRequired,
    );
    return NextResponse.json({
      status,
      label: txLookupLabel(status),
      confirmations,
      // Field summary only — the full node response is never echoed.
      tx: tx
        ? {
            from: tx.from,
            to: tx.to,
            value: String(tx.value),
            blockNumber: tx.blockNumber ?? null,
            executionResult:
              typeof (tx as { executionResult?: unknown }).executionResult === "boolean"
                ? ((tx as { executionResult?: unknown }).executionResult as boolean)
                : null,
          }
        : null,
      rpcConfigured: true,
      treasury: getCanonicalTreasuryAddress() || null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Node lookup failed";
    return NextResponse.json({ error: `Node lookup failed: ${message}` }, { status: 502 });
  }
}
