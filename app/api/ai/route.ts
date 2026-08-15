import { NextRequest, NextResponse } from "next/server";
import { aiConfigured, runAi } from "@/lib/server/ai";
import { START_FEN } from "@/lib/types";

export const runtime = "nodejs";

const MAX_PROMPT_CHARS = 4000;

/**
 * POST /api/ai
 * body: { type: "commentary" | "summary", fen?, lastMoveSan?, moves?, winner?, result? }
 * Returns { text } — or 501 when no AI_API_KEY is configured.
 */
export async function POST(req: NextRequest) {
  if (!aiConfigured()) {
    return NextResponse.json(
      { error: "AI is not configured (set AI_API_KEY)" },
      { status: 501 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const type = body.type;
  try {
    let prompt: string;
    if (type === "commentary") {
      const fen = typeof body.fen === "string" && body.fen ? body.fen : START_FEN;
      const lastMove = String(body.lastMoveSan ?? "");
      const side = String(body.side ?? "White");
      prompt =
        `The chess position is: ${fen.slice(0, MAX_PROMPT_CHARS)}\n` +
        `${side} just played ${lastMove}.\n` +
        "Write 2-3 sentences of chess commentary about this move: what it does, " +
        "the ideas behind it, any threats it creates, and how the position looks. " +
        "Be specific and accurate. Do not invent pieces or squares.";
    } else if (type === "summary") {
      const moves = String(body.moves ?? "");
      const winner = String(body.winner ?? "draw");
      const result = String(body.result ?? "finished");
      prompt =
        `The game ended by ${result}. Winner: ${winner}.\n` +
        `Complete move list (SAN): ${moves.slice(0, MAX_PROMPT_CHARS)}\n` +
        "Write a 3-5 sentence match analysis: how the game developed, key moments, " +
        "turning points or blunders, and why it ended as it did.";
    } else {
      return NextResponse.json({ error: "Unknown AI type" }, { status: 400 });
    }

    const text = await runAi(prompt);
    return NextResponse.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : "AI request failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
