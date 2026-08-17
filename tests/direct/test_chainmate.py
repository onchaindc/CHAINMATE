"""Direct-mode tests for the ChainMate contract (genlayer-test).

Covers the two review-critical areas:
  1. The authorization boundary — every move and resignation is bound to the
     authenticated transaction sender; no caller-selected player id or key is
     ever accepted.
  2. Core chess outcomes — legality, checkmate, stalemate, castling,
     en passant, promotion, resignation and draw handling.

Run with:
    pip install -r requirements.txt
    genvm-lint check contracts/chainmate.py
    pytest tests/direct/ -v
"""

from tests.direct.conftest import to_hex


def new_game(direct_vm, direct_deploy, alice, bob):
    """Deploy + create (White = alice) + join (Black = bob)."""
    contract = direct_deploy("contracts/chainmate.py")
    direct_vm.sender = alice
    contract.create_game()
    direct_vm.sender = bob
    contract.join_game()
    return contract


def play(direct_vm, contract, alice, bob, moves):
    """Alternate White (alice) / Black (bob) through a list of moves.

    Each move is (from, to) or (from, to, promotion).
    """
    for i, mv in enumerate(moves):
        direct_vm.sender = alice if i % 2 == 0 else bob
        contract.submit_move(mv[0], mv[1], mv[2] if len(mv) > 2 else "")


# ─────────────────────────────────────────────────────────────
# Game lifecycle
# ─────────────────────────────────────────────────────────────


def test_create_game_sets_white_to_sender(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/chainmate.py")
    direct_vm.sender = direct_alice
    game = contract.create_game()

    assert game["status"] == "waiting"
    assert game["creator"] == to_hex(direct_alice)
    assert game["opponent"] == ""
    assert game["moves"] == []


def test_join_game_binds_black_to_joining_sender(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = direct_deploy("contracts/chainmate.py")
    direct_vm.sender = direct_alice
    contract.create_game()
    direct_vm.sender = direct_bob
    game = contract.join_game()

    assert game["status"] == "active"
    assert game["opponent"] == to_hex(direct_bob)


def test_creator_cannot_join_their_own_game(
    direct_vm, direct_deploy, direct_alice
):
    contract = direct_deploy("contracts/chainmate.py")
    direct_vm.sender = direct_alice
    contract.create_game()

    with direct_vm.expect_revert("The creator cannot join their own game"):
        contract.join_game()


def test_join_rejected_when_game_not_waiting(
    direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie
):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    direct_vm.sender = direct_charlie

    with direct_vm.expect_revert("This game is not waiting for players"):
        contract.join_game()


def test_game_cannot_be_recreated(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/chainmate.py")
    direct_vm.sender = direct_alice
    contract.create_game()

    with direct_vm.expect_revert("This contract already hosts a game"):
        contract.create_game()


# ─────────────────────────────────────────────────────────────
# Authorization boundary (the review-critical part)
# ─────────────────────────────────────────────────────────────


def test_non_player_cannot_move(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    direct_vm.sender = direct_charlie

    with direct_vm.expect_revert("Only players can move"):
        contract.submit_move("e2", "e4")


def test_non_player_cannot_resign(direct_vm, direct_deploy, direct_alice, direct_bob, direct_charlie):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    direct_vm.sender = direct_charlie

    with direct_vm.expect_revert("Only players can resign"):
        contract.resign_game()


def test_player_cannot_move_out_of_turn(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    # Black tries to open the game.
    direct_vm.sender = direct_bob

    with direct_vm.expect_revert("It is not your turn"):
        contract.submit_move("e7", "e5")


def test_no_moves_before_game_starts(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/chainmate.py")
    direct_vm.sender = direct_alice
    contract.create_game()

    with direct_vm.expect_revert("The game is not active"):
        contract.submit_move("e2", "e4")


def test_no_moves_after_game_ends(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    play(direct_vm, contract, direct_alice, direct_bob, [
        ("f2", "f3"), ("e7", "e5"), ("g2", "g4"), ("d8", "h4"),
    ])
    assert contract.get_game()["status"] == "checkmate"

    with direct_vm.expect_revert("The game is not active"):
        contract.submit_move("a2", "a3")


def test_resign_requires_active_game(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/chainmate.py")
    direct_vm.sender = direct_alice
    contract.create_game()

    with direct_vm.expect_revert("The game is not active"):
        contract.resign_game()


# ─────────────────────────────────────────────────────────────
# Core chess outcomes
# ─────────────────────────────────────────────────────────────


def test_legal_move_records_san_and_advances_turn(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    direct_vm.sender = direct_alice
    game = contract.submit_move("e2", "e4")

    assert game["status"] == "active"
    assert len(game["moves"]) == 1
    assert game["moves"][0]["san"] == "e4"
    assert game["moves"][0]["side"] == "white"
    assert game["fen"].split(" ")[1] == "b"  # Black to move


def test_illegal_move_rejected(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    direct_vm.sender = direct_alice

    with direct_vm.expect_revert("Illegal move"):
        contract.submit_move("e2", "e5")


def test_checkmate_detected_fools_mate(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    play(direct_vm, contract, direct_alice, direct_bob, [
        ("f2", "f3"), ("e7", "e5"), ("g2", "g4"), ("d8", "h4"),
    ])

    game = contract.get_game()
    assert game["status"] == "checkmate"
    assert game["winner"] == to_hex(direct_bob)
    assert game["moves"][-1]["san"] == "Qh4#"


def test_stalemate_detected(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    # The shortest known stalemate (10 moves by White).
    play(direct_vm, contract, direct_alice, direct_bob, [
        ("e2", "e3"), ("a7", "a5"), ("d1", "h5"), ("a8", "a6"),
        ("h5", "a5"), ("h7", "h5"), ("a5", "c7"), ("a6", "h6"),
        ("h2", "h4"), ("f7", "f6"), ("c7", "d7"), ("e8", "f7"),
        ("d7", "b7"), ("d8", "d3"), ("b7", "b8"), ("d3", "h7"),
        ("b8", "c8"), ("f7", "g6"), ("c8", "e6"),
    ])

    game = contract.get_game()
    assert game["status"] == "stalemate"
    assert game["winner"] == ""


def test_castling_kingside(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    play(direct_vm, contract, direct_alice, direct_bob, [
        ("e2", "e4"), ("e7", "e5"), ("g1", "f3"), ("b8", "c6"),
        ("f1", "c4"), ("f8", "c5"), ("e1", "g1"),
    ])

    game = contract.get_game()
    assert game["status"] == "active"
    assert game["moves"][-1]["san"] == "O-O"
    # White's castling rights are gone once the king moved.
    assert "K" not in game["fen"].split(" ")[2]


def test_en_passant(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    play(direct_vm, contract, direct_alice, direct_bob, [
        ("e2", "e4"), ("a7", "a6"), ("e4", "e5"), ("d7", "d5"),
        ("e5", "d6"),
    ])

    game = contract.get_game()
    assert game["moves"][-1]["san"] == "exd6"


def test_promotion(direct_vm, direct_deploy, direct_alice, direct_bob):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    play(direct_vm, contract, direct_alice, direct_bob, [
        ("h2", "h4"), ("g7", "g5"), ("h4", "g5"), ("h7", "h5"),
        ("g5", "g6"), ("h5", "h4"), ("g6", "g7"), ("h4", "h3"),
    ])
    # Promotion must be declared explicitly.
    direct_vm.sender = direct_alice
    game = contract.submit_move("g7", "h8", "q")

    assert game["moves"][-1]["san"] == "gxh8=Q"
    assert game["moves"][-1]["promotion"] == "q"


def test_resignation_awards_opponent(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    play(direct_vm, contract, direct_alice, direct_bob, [
        ("e2", "e4"), ("e7", "e5"),
    ])

    direct_vm.sender = direct_bob
    game = contract.resign_game()

    assert game["status"] == "resigned"
    assert game["winner"] == to_hex(direct_alice)
    # The resignation is recorded in the commentary stream, not the move list.
    assert game["commentary"][-1]["text"].startswith("Black resigned")


def test_commentary_is_recorded_for_every_move(
    direct_vm, direct_deploy, direct_alice, direct_bob
):
    contract = new_game(direct_vm, direct_deploy, direct_alice, direct_bob)
    play(direct_vm, contract, direct_alice, direct_bob, [
        ("e2", "e4"), ("e7", "e5"), ("d1", "h5"), ("b8", "c6"),
    ])

    game = contract.get_game()
    assert len(game["commentary"]) == 4
    assert game["commentary"][0]["side"] == "white"
    assert "e4" in game["commentary"][0]["text"]
