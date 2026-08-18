# ChainMate — GenLayer post-game analysis contract
# A lightweight contract that generates LLM-powered match analysis using
# GenLayer's validator consensus (gl.nondet.exec_prompt).
#
# Used by hosted games: when a hosted game ends, the server deploys this
# contract with the game data, calls generate_analysis(), and returns the
# LLM-written analysis to the frontend.
#
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

from dataclasses import dataclass

from genlayer import *


@allow_storage
@dataclass
class MoveRecord:
    number: u64
    san: str
    side: str


class ChainMateAnalyzer(gl.Contract):
    """Post-game analysis contract.

    Deployed per-game with pre-loaded move data. The generate_analysis()
    method uses GenLayer's LLM consensus (Optimistic Democracy) to write
    a 3-5 sentence game analysis — the same mechanism as the full
    ChainMate contract's generate_match_summary(), but without the chess
    engine overhead.
    """

    creator: str
    status: str
    winner: str
    moves: DynArray[MoveRecord]
    summary: str

    def __init__(self):
        self.creator = ""
        self.status = ""
        self.winner = ""
        self.summary = ""

    @gl.public.write
    def load_game(self, moves_json: str, status: str, winner: str) -> str:
        """Load a finished game's data for analysis.

        moves_json: JSON array of [{number, san, side}, ...]
        status: game result (checkmate, stalemate, draw, resigned, timeout)
        winner: winning player address (empty for draws)
        """
        if self.status:
            raise gl.vm.UserError("Analysis already loaded")
        self.creator = str(gl.message.sender_address)
        self.status = status
        self.winner = winner

        import json
        try:
            move_list = json.loads(moves_json)
            for m in move_list:
                self.moves.append(MoveRecord(
                    number=u64(m.get("number", 0)),
                    san=str(m.get("san", "")),
                    side=str(m.get("side", "")),
                ))
        except Exception:
            raise gl.vm.UserError("Invalid moves data")

        return f"Loaded {len(self.moves)} moves"

    @gl.public.write
    def generate_analysis(self) -> str:
        """Generate LLM-powered match analysis using GenLayer validator consensus.

        Each validator independently generates analysis with its own LLM,
        then cross-checks the result (Optimistic Democracy). Can take ~1 minute.
        """
        if self.summary:
            return self.summary
        if not self.status:
            raise gl.vm.UserError("No game data loaded")

        ai = self._request_ai_summary()
        self.summary = ai if ai else self._build_deterministic_summary()
        return self.summary

    def _request_ai_summary(self) -> str:
        """Ask the GenLayer validators' LLMs to write the analysis.

        The LLM call runs inside a non-deterministic block executed
        independently by every validator; the validator function checks
        that both summaries are plausible and agree on the winner.
        """
        san_list = [m.san for m in self.moves]
        winner = self.winner
        status = self.status
        result_label = {
            "checkmate": "checkmate",
            "stalemate": "stalemate",
            "draw": "a draw",
            "resigned": "a resignation",
            "timeout": "a timeout",
        }.get(status, status)
        moves_text = ", ".join(san_list) if san_list else "(no moves were played)"
        winner_text = winner if winner else "draw"

        prompt = (
            "You are a chess commentator analysing a finished game for the ChainMate dApp.\n"
            f"Game result: {result_label}. Winner address: {winner_text}.\n"
            f"Complete move history (SAN): {moves_text}\n"
            "Write a 3-5 sentence game analysis: how the game developed, key moments, "
            "turning points or blunders, and why the game ended as it did. "
            "Do NOT invent moves that are not listed. "
            "The winner field must be exactly " + repr(winner_text) + ".\n"
            "Respond ONLY with valid JSON in this exact shape:\n"
            '{"summary": "your analysis here", "winner": "' + winner_text + '"}\n'
            "No markdown, no extra text."
        )

        def leader_fn():
            try:
                data = gl.nondet.exec_prompt(prompt, response_format="json")
                if not isinstance(data, dict):
                    return {"summary": "", "winner": ""}
                return {
                    "summary": str(data.get("summary", "")).strip(),
                    "winner": str(data.get("winner", "")).strip(),
                }
            except Exception:
                return {"summary": "", "winner": ""}

        def validator_fn(leader_result):
            try:
                if not isinstance(leader_result, gl.vm.Return):
                    return False
                leader = leader_result.calldata
                if not isinstance(leader, dict):
                    return False
                ls = str(leader.get("summary", "")).strip()
                lw = str(leader.get("winner", "")).strip()
                if not (80 <= len(ls) <= 2000):
                    return False
                mine = leader_fn()
                ms = str(mine.get("summary", "")).strip()
                mw = str(mine.get("winner", "")).strip()
                if not (80 <= len(ms) <= 2000):
                    return False
                # Both validators must agree on the outcome they describe.
                if winner:
                    return lw == winner and mw == winner
                return lw == "draw" and mw == "draw"
            except Exception:
                return False

        try:
            data = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
            if isinstance(data, dict) and data.get("summary"):
                return str(data["summary"])
        except Exception:
            pass
        return ""

    def _build_deterministic_summary(self) -> str:
        """Offline fallback analysis — always works, no LLM needed."""
        total_ply = len(self.moves)
        status = self.status
        winner = self.winner
        result_label = {
            "checkmate": "checkmate",
            "stalemate": "stalemate",
            "draw": "a draw",
            "resigned": "a resignation",
            "timeout": "a timeout",
        }.get(status, status)

        sentences = []
        if total_ply == 0:
            sentences.append(f"The game ended by {result_label} without a single move being played.")
        else:
            sentences.append(f"The game lasted {total_ply} moves and ended by {result_label}.")
        if winner:
            side = "a player"
            for m in self.moves:
                if m.side == "white" and winner:
                    side = "White"
                elif m.side == "black" and winner:
                    side = "Black"
            sentences.append(f"{side} came out on top and claimed the win.")
        else:
            sentences.append("Neither player could force a win, so honours were shared.")
        sentences.append("Both players can review the full move history and replay the game move by move.")
        return " ".join(sentences)

    @gl.public.view
    def get_summary(self) -> str:
        return self.summary

    @gl.public.view
    def get_status(self) -> dict:
        return {
            "status": self.status,
            "winner": self.winner,
            "moveCount": len(self.moves),
            "summary": self.summary,
        }
