# ChainMate — GenLayer intelligent contract
# A chess dApp where two players play chess on-chain and receive
# AI-generated move commentary and post-game match analysis.
#
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
#
# Deploy to GenLayer (testnet Bradbury):
#   genlayer network set testnet-bradbury
#   genlayer deploy --contract contracts/chainmate.py
#
# The contract is one game instance. `create_game()` initialises it
# (the deployer is White), `join_game()` adds Black and the game starts.
#
# Move legality, check / checkmate / stalemate / draw detection and SAN
# generation are all computed deterministically on-chain by the bundled
# chess engine below, so players cannot submit illegal moves.

from dataclasses import dataclass

from genlayer import *

# ─────────────────────────────────────────────────────────────
# Minimal deterministic chess engine (rules only)
# ─────────────────────────────────────────────────────────────

START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
FILES = "abcdefgh"
PIECE_NAMES = {"p": "pawn", "n": "knight", "b": "bishop", "r": "rook", "q": "queen", "k": "king"}
PIECE_VALUES = {"p": 1, "n": 3, "b": 3, "r": 5, "q": 9, "k": 0}

KNIGHT_OFFSETS = [(1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2)]
KING_OFFSETS = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
ROOK_DIRS = [(1, 0), (-1, 0), (0, 1), (0, -1)]
BISHOP_DIRS = [(1, 1), (1, -1), (-1, 1), (-1, -1)]


def sq_to_idx(sq: str) -> int:
    return (ord(sq[0]) - ord("a")) + (int(sq[1]) - 1) * 8


def idx_to_sq(idx: int) -> str:
    return FILES[idx % 8] + str(idx // 8 + 1)


def on_board(x: int, y: int) -> bool:
    return 0 <= x < 8 and 0 <= y < 8


def parse_fen(fen: str):
    """Returns (board, turn, castling, ep, halfmove, fullmove)."""
    parts = fen.split(" ")
    board = [None] * 64
    rank = 7
    file_idx = 0
    for ch in parts[0]:
        if ch == "/":
            rank -= 1
            file_idx = 0
        elif ch.isdigit():
            file_idx += int(ch)
        else:
            board[rank * 8 + file_idx] = ch
            file_idx += 1
    turn = parts[1] if len(parts) > 1 else "w"
    castling = parts[2] if len(parts) > 2 and parts[2] != "-" else ""
    ep = parts[3] if len(parts) > 3 and parts[3] != "-" else None
    halfmove = int(parts[4]) if len(parts) > 4 else 0
    fullmove = int(parts[5]) if len(parts) > 5 else 1
    return board, turn, castling, ep, halfmove, fullmove


def to_fen(board, turn, castling, ep, halfmove, fullmove) -> str:
    rows = []
    for rank in range(7, -1, -1):
        row = ""
        empty = 0
        for file_idx in range(8):
            cell = board[rank * 8 + file_idx]
            if cell is None:
                empty += 1
            else:
                if empty:
                    row += str(empty)
                    empty = 0
                row += cell
        if empty:
            row += str(empty)
        rows.append(row)
    castle_str = castling if castling else "-"
    ep_str = ep if ep is not None else "-"
    return "/".join(rows) + f" {turn} {castle_str} {ep_str} {halfmove} {fullmove}"


def _add_move(moves, board, idx, nx, ny, promo_rank=None):
    to_idx = ny * 8 + nx
    if promo_rank is not None and ny == promo_rank:
        for p in "qrbn":
            moves.append({"from": idx_to_sq(idx), "to": idx_to_sq(to_idx), "promotion": p,
                          "castle": None, "ep": False})
    else:
        moves.append({"from": idx_to_sq(idx), "to": idx_to_sq(to_idx), "promotion": None,
                      "castle": None, "ep": False})


def pseudo_legal_moves(board, turn, castling, ep):
    moves = []
    color = "w" if turn == "w" else "b"
    pawn_dy = 1 if color == "w" else -1
    start_rank = 1 if color == "w" else 6
    promo_rank = 7 if color == "w" else 0

    for idx, cell in enumerate(board):
        if cell is None:
            continue
        is_white = cell.isupper()
        if (color == "w") != is_white:
            continue
        piece = cell.lower()
        x, y = idx % 8, idx // 8

        if piece == "p":
            ny = y + pawn_dy
            if on_board(x, ny) and board[ny * 8 + x] is None:
                if ny == promo_rank:
                    _add_move(moves, board, idx, x, ny, promo_rank)
                else:
                    _add_move(moves, board, idx, x, ny)
                    if y == start_rank and board[(y + 2 * pawn_dy) * 8 + x] is None:
                        _add_move(moves, board, idx, x, y + 2 * pawn_dy)
            for dx in (-1, 1):
                nx = x + dx
                if not on_board(nx, ny):
                    continue
                target = board[ny * 8 + nx]
                if target is not None and (target.isupper() != is_white):
                    if ny == promo_rank:
                        _add_move(moves, board, idx, nx, ny, promo_rank)
                    else:
                        moves.append({"from": idx_to_sq(idx), "to": idx_to_sq(ny * 8 + nx),
                                      "promotion": None, "castle": None, "ep": False})
                elif ep is not None and idx_to_sq(ny * 8 + nx) == ep:
                    moves.append({"from": idx_to_sq(idx), "to": idx_to_sq(ny * 8 + nx),
                                  "promotion": None, "castle": None, "ep": True})

        elif piece == "n":
            for dx, dy in KNIGHT_OFFSETS:
                nx, ny = x + dx, y + dy
                if not on_board(nx, ny):
                    continue
                target = board[ny * 8 + nx]
                if target is None or (target.isupper() != is_white):
                    moves.append({"from": idx_to_sq(idx), "to": idx_to_sq(ny * 8 + nx),
                                  "promotion": None, "castle": None, "ep": False})

        elif piece == "k":
            for dx, dy in KING_OFFSETS:
                nx, ny = x + dx, y + dy
                if not on_board(nx, ny):
                    continue
                target = board[ny * 8 + nx]
                if target is None or (target.isupper() != is_white):
                    moves.append({"from": idx_to_sq(idx), "to": idx_to_sq(ny * 8 + nx),
                                  "promotion": None, "castle": None, "ep": False})
            # castling (rank 1 occupies board indices 0-7, rank 8 indices 56-63)
            if is_white and idx == 4:  # e1
                if "K" in castling and board[5] is None and board[6] is None \
                        and board[7] is not None and board[7].lower() == "r":
                    moves.append({"from": "e1", "to": "g1", "promotion": None, "castle": "K", "ep": False})
                if "Q" in castling and board[1] is None and board[2] is None and board[3] is None \
                        and board[0] is not None and board[0].lower() == "r":
                    moves.append({"from": "e1", "to": "c1", "promotion": None, "castle": "Q", "ep": False})
            elif not is_white and idx == 60:  # e8
                if "k" in castling and board[61] is None and board[62] is None \
                        and board[63] is not None and board[63].lower() == "r":
                    moves.append({"from": "e8", "to": "g8", "promotion": None, "castle": "k", "ep": False})
                if "q" in castling and board[57] is None and board[58] is None and board[59] is None \
                        and board[56] is not None and board[56].lower() == "r":
                    moves.append({"from": "e8", "to": "c8", "promotion": None, "castle": "q", "ep": False})

        else:  # sliding pieces: r, b, q
            dirs = ROOK_DIRS if piece == "r" else BISHOP_DIRS if piece == "b" else ROOK_DIRS + BISHOP_DIRS
            for dx, dy in dirs:
                nx, ny = x + dx, y + dy
                while on_board(nx, ny):
                    target = board[ny * 8 + nx]
                    if target is None:
                        moves.append({"from": idx_to_sq(idx), "to": idx_to_sq(ny * 8 + nx),
                                      "promotion": None, "castle": None, "ep": False})
                    else:
                        if target.isupper() != is_white:
                            moves.append({"from": idx_to_sq(idx), "to": idx_to_sq(ny * 8 + nx),
                                          "promotion": None, "castle": None, "ep": False})
                        break
                    nx += dx
                    ny += dy

    return moves


def is_attacked(board, idx, by_color):
    """True if square `idx` is attacked by a piece of `by_color` ('w'|'b')."""
    x, y = idx % 8, idx // 8

    for dx in (-1, 1):
        if by_color == "w":
            ny, nx = y - 1, x + dx
        else:
            ny, nx = y + 1, x + dx
        if on_board(nx, ny):
            cell = board[ny * 8 + nx]
            if cell is not None and cell.lower() == "p" and (cell.isupper() == (by_color == "w")):
                return True

    for dx, dy in KNIGHT_OFFSETS:
        nx, ny = x + dx, y + dy
        if on_board(nx, ny):
            cell = board[ny * 8 + nx]
            if cell is not None and cell.lower() == "n" and (cell.isupper() == (by_color == "w")):
                return True

    for dx, dy in KING_OFFSETS:
        nx, ny = x + dx, y + dy
        if on_board(nx, ny):
            cell = board[ny * 8 + nx]
            if cell is not None and cell.lower() == "k" and (cell.isupper() == (by_color == "w")):
                return True

    for dx, dy in ROOK_DIRS + BISHOP_DIRS:
        nx, ny = x + dx, y + dy
        while on_board(nx, ny):
            cell = board[ny * 8 + nx]
            if cell is not None:
                lower = cell.lower()
                if cell.isupper() == (by_color == "w"):
                    if lower == "q":
                        return True
                    if lower == "r" and (dx, dy) in ROOK_DIRS:
                        return True
                    if lower == "b" and (dx, dy) in BISHOP_DIRS:
                        return True
                break
            nx += dx
            ny += dy

    return False


def find_king(board, color):
    for idx, cell in enumerate(board):
        if cell is not None and cell.lower() == "k" and (cell.isupper() == (color == "w")):
            return idx
    return None


def in_check(board, color):
    king = find_king(board, color)
    if king is None:
        return False
    enemy = "b" if color == "w" else "w"
    return is_attacked(board, king, enemy)


def apply_move(board, move, castling, ep):
    """Applies a move; returns (new_board, new_castling, new_ep)."""
    new_board = list(board)
    from_idx = sq_to_idx(move["from"])
    to_idx = sq_to_idx(move["to"])
    piece = new_board[from_idx]
    is_white = piece.isupper()
    color = "w" if is_white else "b"

    new_board[to_idx] = piece
    new_board[from_idx] = None

    if move.get("castle"):
        if move["castle"] == "K":
            rook_from, rook_to = 7, 5       # h1 -> f1
        elif move["castle"] == "Q":
            rook_from, rook_to = 0, 3       # a1 -> d1
        elif move["castle"] == "k":
            rook_from, rook_to = 63, 61     # h8 -> f8
        else:
            rook_from, rook_to = 56, 59     # a8 -> d8
        new_board[rook_to] = new_board[rook_from]
        new_board[rook_from] = None
    elif move.get("ep"):
        captured_idx = to_idx - 8 if color == "w" else to_idx + 8
        new_board[captured_idx] = None

    if move.get("promotion"):
        new_board[to_idx] = move["promotion"] if is_white else move["promotion"].lower()

    # update castling rights
    new_castling = castling
    if piece.lower() == "k":
        if is_white:
            new_castling = new_castling.replace("K", "").replace("Q", "")
        else:
            new_castling = new_castling.replace("k", "").replace("q", "")
    if move["from"] == "a1" or move["to"] == "a1":
        new_castling = new_castling.replace("Q", "")
    if move["from"] == "h1" or move["to"] == "h1":
        new_castling = new_castling.replace("K", "")
    if move["from"] == "a8" or move["to"] == "a8":
        new_castling = new_castling.replace("q", "")
    if move["from"] == "h8" or move["to"] == "h8":
        new_castling = new_castling.replace("k", "")

    # en passant target for the next move
    new_ep = None
    if piece.lower() == "p" and abs(to_idx // 8 - from_idx // 8) == 2:
        new_ep = idx_to_sq((from_idx + to_idx) // 2)

    return new_board, new_castling, new_ep


def legal_moves(board, turn, castling, ep):
    moves = []
    enemy = "b" if turn == "w" else "w"
    for m in pseudo_legal_moves(board, turn, castling, ep):
        if m.get("castle"):
            # the king may not castle out of or through check
            if is_attacked(board, sq_to_idx(m["from"]), enemy):
                continue
            pass_sq = ("f" if m["castle"] in ("K", "k") else "d") + m["from"][1]
            if is_attacked(board, sq_to_idx(pass_sq), enemy):
                continue
        nb, nc, ne = apply_move(board, m, castling, ep)
        if not in_check(nb, turn):
            moves.append(m)
    return moves


def _disambiguate(board, legal, move):
    """File/rank prefix needed to make a SAN unambiguous."""
    piece = board[sq_to_idx(move["from"])].lower()
    if piece == "p" or move.get("castle"):
        return ""
    same_dest = [m for m in legal
                 if m["to"] == move["to"] and board[sq_to_idx(m["from"])].lower() == piece
                 and not m.get("castle")]
    if len(same_dest) < 2:
        return ""
    from_file = move["from"][0]
    from_rank = move["from"][1]
    same_file = any(m["from"][0] == from_file for m in same_dest if m is not move)
    same_rank = any(m["from"][1] == from_rank for m in same_dest if m is not move)
    if same_file and same_rank:
        return move["from"]
    if same_file:
        return from_rank
    return from_file


def san_for_move(board, legal, move, turn, castling, ep):
    """Standard Algebraic Notation for a move (with +/# suffixes)."""
    if move.get("castle"):
        san = "O-O" if move["castle"] in ("K", "k") else "O-O-O"
    else:
        piece = board[sq_to_idx(move["from"])].lower()
        letter = piece.upper() if piece != "p" else ""
        prefix = _disambiguate(board, legal, move)
        capture = ""
        target = board[sq_to_idx(move["to"])]
        if piece == "p":
            if target is not None or move.get("ep"):
                capture = move["from"][0] + "x"
        elif target is not None:
            capture = "x"
        promo = ""
        if move.get("promotion"):
            promo = "=" + move["promotion"].upper()
        san = f"{letter}{prefix}{capture}{move['to']}{promo}"

    nb, nc, ne = apply_move(board, move, castling, ep)
    enemy = "b" if turn == "w" else "w"
    if in_check(nb, enemy):
        if not legal_moves(nb, enemy, nc, ne):
            san += "#"
        else:
            san += "+"
    return san


def insufficient_material(board):
    non_kings = [c for c in board if c is not None and c.lower() != "k"]
    if len(non_kings) == 0:
        return True
    if len(non_kings) == 1 and non_kings[0].lower() in ("b", "n"):
        return True
    return False


def as_move_dict(m) -> dict:
    """Normalise a stored MoveRecord (or a plain engine move dict) for the
    deterministic replay helpers, which work on dict moves."""
    if hasattr(m, "from_sq"):
        return {
            "from": m.from_sq,
            "to": m.to_sq,
            "promotion": m.promotion or None,
            "castle": None,
            "ep": False,
        }
    return m


def replay_captures(moves) -> list:
    """Replays the move list from the start position and returns captures."""
    board, turn, castling, ep, _h, _f = parse_fen(START_FEN)
    caps = []
    for m in moves:
        d = as_move_dict(m)
        target = board[sq_to_idx(d["to"])]
        if d.get("ep") or target is not None:
            caps.append(m)
        board, castling, ep = apply_move(board, d, castling, ep)
        turn = "b" if turn == "w" else "w"
    return caps


def build_move_commentary(move, san, side, enemy_in_check, result, captured_name=None) -> str:
    """Deterministic, human-sounding commentary for a move (stored on-chain)."""
    if move.get("castle"):
        text = (f"{side.capitalize()} castles {'kingside' if move['castle'] in ('K', 'k') else 'queenside'}, "
                f"tucking the king behind a wall of pawns ({san}).")
    elif move.get("promotion"):
        text = (f"Promotion! {side.capitalize()} plays {san} — the pawn transforms into a "
                f"{PIECE_NAMES[move['promotion']]}.")
    elif move.get("ep"):
        text = f"{side.capitalize()} captures a pawn en passant with {san}."
    elif captured_name:
        text = f"{side.capitalize()} captures a {captured_name} with {san}."
    else:
        text = f"{side.capitalize()} plays {san}."
    if enemy_in_check:
        if result == "checkmate":
            text += " That is checkmate — the game is over!"
        else:
            text += " This move puts the opponent in check."
    return text


# ─────────────────────────────────────────────────────────────
# The contract
# ─────────────────────────────────────────────────────────────

@allow_storage
@dataclass
class MoveRecord:
    # Sized integer — GenVM storage rejects bare Python ints.
    number: u64
    side: str
    from_sq: str
    to_sq: str
    promotion: str
    san: str


@allow_storage
@dataclass
class CommentaryRecord:
    move: str
    side: str
    text: str


class ChainMate(gl.Contract):
    creator: str
    opponent: str
    status: str
    winner: str
    fen: str
    moves: DynArray[MoveRecord]
    commentary: DynArray[CommentaryRecord]
    summary: str

    def __init__(self):
        self.creator = ""
        self.opponent = ""
        self.status = ""
        self.winner = ""
        self.fen = START_FEN
        self.summary = ""

    # ── game lifecycle ────────────────────────────────────────

    @gl.public.write
    def create_game(self) -> dict:
        # One contract hosts exactly one game; it cannot be re-created.
        if self.status != "":
            raise gl.vm.UserError("This contract already hosts a game")
        # The deployer is White. Only the authenticated sender of this
        # transaction can ever act as White — the contract never accepts
        # a caller-supplied player id or signing key.
        self.creator = str(gl.message.sender_address)
        self.opponent = ""
        self.status = "waiting"
        self.winner = ""
        self.fen = START_FEN
        self.summary = ""
        return self.get_game()

    @gl.public.write
    def join_game(self) -> dict:
        if self.status != "waiting":
            raise gl.vm.UserError("This game is not waiting for players")
        sender = str(gl.message.sender_address)
        if sender == self.creator:
            raise gl.vm.UserError("The creator cannot join their own game")
        # Black is bound to the authenticated joining sender.
        self.opponent = sender
        self.status = "active"
        return self.get_game()

    @gl.public.write
    def submit_move(self, from_sq: str, to_sq: str, promotion: str = "") -> dict:
        if self.status != "active":
            raise gl.vm.UserError("The game is not active")
        # Authorization boundary: the side that moves is derived ONLY from
        # the authenticated transaction sender. No caller-selected player
        # slot or server key can ever steer this contract.
        sender = str(gl.message.sender_address)
        if sender not in (self.creator, self.opponent):
            raise gl.vm.UserError("Only players can move")
        side = "white" if sender == self.creator else "black"
        turn = "w" if side == "white" else "b"

        board, fen_turn, castling, ep, halfmove, fullmove = parse_fen(self.fen)
        if fen_turn != turn:
            raise gl.vm.UserError("It is not your turn")

        legal = legal_moves(board, turn, castling, ep)
        target = None
        promo = promotion.lower() if promotion else None
        for m in legal:
            if m["from"] == from_sq and m["to"] == to_sq:
                if promo is None or m.get("promotion") == promo:
                    target = m
                    break
        if target is None:
            raise gl.vm.UserError("Illegal move")

        captured_name = None
        if target.get("ep"):
            captured_name = "pawn"
        elif board[sq_to_idx(target["to"])] is not None:
            captured_name = PIECE_NAMES[board[sq_to_idx(target["to"])].lower()]

        san = san_for_move(board, legal, target, turn, castling, ep)
        new_board, new_castling, new_ep = apply_move(board, target, castling, ep)

        moved_piece = board[sq_to_idx(target["from"])].lower()
        if moved_piece == "p" or board[sq_to_idx(target["to"])] is not None or target.get("ep"):
            halfmove = 0
        else:
            halfmove += 1
        fullmove = fullmove + (1 if turn == "b" else 0)

        enemy = "b" if turn == "w" else "w"
        enemy_in_check = in_check(new_board, enemy)
        enemy_legal = legal_moves(new_board, enemy, new_castling, new_ep)
        result = "active"
        winner = ""
        if not enemy_legal:
            if enemy_in_check:
                result = "checkmate"
                winner = sender
            else:
                result = "stalemate"
        elif insufficient_material(new_board):
            result = "draw"

        self.fen = to_fen(new_board, enemy, new_castling, new_ep, halfmove, fullmove)
        self.moves.append(MoveRecord(
            number=len(self.moves) + 1,
            side=side,
            from_sq=target["from"],
            to_sq=target["to"],
            promotion=target.get("promotion") or "",
            san=san,
        ))
        self.commentary.append(CommentaryRecord(
            move=san,
            side=side,
            text=build_move_commentary(target, san, side, enemy_in_check, result,
                                       captured_name),
        ))
        self.status = result
        self.winner = winner
        return self.get_game()

    @gl.public.write
    def resign_game(self) -> dict:
        if self.status != "active":
            raise gl.vm.UserError("The game is not active")
        # Authorization boundary: only the authenticated player themselves
        # can resign — never a caller-chosen key or slot.
        sender = str(gl.message.sender_address)
        if sender not in (self.creator, self.opponent):
            raise gl.vm.UserError("Only players can resign")
        side = "white" if sender == self.creator else "black"
        self.status = "resigned"
        self.winner = self.opponent if side == "white" else self.creator
        self.commentary.append(CommentaryRecord(
            move="",
            side=side,
            text=f"{side.capitalize()} resigned — {self.winner[:10]}… wins.",
        ))
        return self.get_game()

    @gl.public.view
    def get_game(self) -> dict:
        return {
            "creator": self.creator,
            "opponent": self.opponent,
            "status": self.status,
            "winner": self.winner,
            "fen": self.fen,
            "moves": [
                {
                    "number": m.number,
                    "side": m.side,
                    "from": m.from_sq,
                    "to": m.to_sq,
                    "promotion": m.promotion,
                    "san": m.san,
                }
                for m in self.moves
            ],
            "commentary": [
                {"move": c.move, "side": c.side, "text": c.text}
                for c in self.commentary
            ],
            "summary": self.summary,
        }

    # ── AI: match summary ─────────────────────────────────────

    @gl.public.write
    def generate_match_summary(self) -> str:
        if self.status not in ("checkmate", "stalemate", "draw", "resigned"):
            raise gl.vm.UserError("The game is still in progress")
        if self.summary:
            return self.summary

        ai = self._request_ai_summary()
        self.summary = ai if ai else self._build_deterministic_summary()
        return self.summary

    def _request_ai_summary(self) -> str:
        """Ask the GenLayer validators' LLMs to write the analysis.

        The LLM call runs inside a non-deterministic block executed
        independently by every validator; the validator function checks
        that both summaries are plausible and agree on the winner. The
        move list / winner are captured into locals BEFORE the block so
        the nondet code never reads or writes storage.
        """
        san_list = [m.san for m in self.moves]
        winner = self.winner
        status = self.status
        result_label = {
            "checkmate": "checkmate", "stalemate": "stalemate",
            "draw": "a draw", "resigned": "a resignation",
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
            "checkmate": "checkmate", "stalemate": "stalemate",
            "draw": "a draw", "resigned": "a resignation",
        }.get(status, status)
        captures = replay_captures(self.moves)

        sentences = []
        if total_ply == 0:
            sentences.append(f"The game ended by {result_label} without a single move being played.")
        else:
            sentences.append(f"The game lasted {total_ply} moves and ended by {result_label}.")
        if captures:
            sentences.append(f"There were {len(captures)} captures in the game.")
        if winner:
            side = "White" if winner == self.creator else "Black"
            sentences.append(f"{side} ({winner[:10]}…) came out on top.")
        else:
            sentences.append("Neither player could force a win, so honours were shared.")
        sentences.append("Both players can review the full move history and replay the game move by move.")
        return " ".join(sentences)
