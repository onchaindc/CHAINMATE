"use client";

import { useCallback, useMemo, useState } from "react";
import { Chessboard, defaultPieces } from "react-chessboard";
import { Chess, type Square } from "chess.js";
import { cn } from "@/lib/utils";
import { START_FEN } from "@/lib/types";

interface ChessBoardProps {
  fen: string;
  orientation: "white" | "black";
  interactive: boolean;
  inCheck: boolean;
  lastMove?: { from: string; to: string } | null;
  onMove: (from: string, to: string, promotion?: string) => void | Promise<void>;
  busy?: boolean;
}

const PROMOTION_PIECES = ["q", "r", "b", "n"] as const;

/** Spoken piece names — "Promote to n" told a screen reader nothing. */
const PROMOTION_NAMES: Record<(typeof PROMOTION_PIECES)[number], string> = {
  q: "Queen",
  r: "Rook",
  b: "Bishop",
  n: "Knight",
};

export function ChessBoard({
  fen,
  orientation,
  interactive,
  inCheck,
  lastMove,
  onMove,
  busy,
}: ChessBoardProps) {
  const [selected, setSelected] = useState<Square | null>(null);
  const [pending, setPending] = useState<{ from: string; to: string } | null>(null);

  const legalTargets = useMemo(() => {
    try {
      const chess = new Chess(fen);
      if (!selected) return new Set<string>();
      const moves = chess.moves({ square: selected, verbose: true });
      return new Set(moves.map((m) => m.to));
    } catch {
      return new Set<string>();
    }
  }, [fen, selected]);

  const needsPromotion = useMemo(() => {
    if (!selected || legalTargets.size === 0) return false;
    try {
      const chess = new Chess(fen);
      const piece = chess.get(selected);
      const backRank = chess.turn() === "w" ? "8" : "1";
      if (!piece || piece.type !== "p") return false;
      return [...legalTargets].some(
        (to) => to[1] === backRank && chess.moves({ square: selected, verbose: true })
          .some((m) => m.to === to),
      );
    } catch {
      return false;
    }
  }, [fen, selected, legalTargets]);

  const attemptMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      setSelected(null);
      setPending(null);
      void onMove(from, to, promotion);
    },
    [onMove],
  );

  const handleSquareClick = useCallback(
    ({ square }: { square: string }) => {
      if (!interactive || busy) return;
      const sq = square as Square;

      if (pending) {
        // ignore clicks while promotion picker is open
        return;
      }

      if (selected && legalTargets.has(sq)) {
        if (needsPromotion) {
          setPending({ from: selected, to: sq });
        } else {
          attemptMove(selected, sq);
        }
        return;
      }

      try {
        const chess = new Chess(fen);
        const piece = chess.get(sq);
        const myColor = chess.turn();
        if (piece && piece.color === myColor) {
          setSelected(sq);
        } else {
          setSelected(null);
        }
      } catch {
        setSelected(null);
      }
    },
    [interactive, busy, selected, legalTargets, needsPromotion, fen, attemptMove],
  );

  const handlePieceDrop = useCallback(
    ({ sourceSquare, targetSquare }: { sourceSquare: string; targetSquare: string | null }) => {
      if (!interactive || busy || !targetSquare) return false;
      if (sourceSquare === targetSquare) return false;
      try {
        const chess = new Chess(fen);
        const move = chess.move({
          from: sourceSquare as Square,
          to: targetSquare as Square,
          promotion: "q",
        });
        if (!move) return false;
        if (move.flags.includes("p")) {
          setPending({ from: sourceSquare, to: targetSquare });
        } else {
          attemptMove(sourceSquare, targetSquare, "q");
        }
        return true;
      } catch {
        return false;
      }
    },
    [interactive, busy, fen, attemptMove],
  );

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (lastMove) {
      styles[lastMove.from] = { backgroundColor: "rgba(201, 168, 106, 0.30)" };
      styles[lastMove.to] = { backgroundColor: "rgba(201, 168, 106, 0.30)" };
    }
    if (selected) {
      styles[selected] = { backgroundColor: "rgba(201, 168, 106, 0.45)" };
    }
    if (inCheck) {
      try {
        const chess = new Chess(fen);
        const turn = chess.turn();
        for (let i = 0; i < 64; i++) {
          const square = `${"abcdefgh"[i % 8]}${Math.floor(i / 8) + 1}`;
          const piece = chess.get(square as Square);
          if (piece && piece.type === "k" && piece.color === turn) {
            styles[square] = { backgroundColor: "rgba(190, 66, 56, 0.5)" };
          }
        }
      } catch {
        // ignore
      }
    }
    for (const target of legalTargets) {
      if (target !== selected) {
        styles[target] = {
          background: "radial-gradient(circle, rgba(201, 168, 106, 0.65) 0 20%, rgba(201, 168, 106, 0.15) 38%, transparent 42%)",
        };
      }
    }
    return styles;
  }, [fen, selected, legalTargets, inCheck, lastMove]);

  return (
    <div className="relative w-full select-none">
      <Chessboard
        options={{
          position: fen || START_FEN,
          boardOrientation: orientation,
          animationDurationInMs: 180,
          showNotation: true,
          allowDragging: interactive && !busy,
          squareStyles,
          canDragPiece: ({ square }) => {
            if (!interactive || busy || !square) return false;
            try {
              const chess = new Chess(fen);
              const piece = chess.get(square as Square);
              return !!piece && piece.color === chess.turn();
            } catch {
              return false;
            }
          },
          onSquareClick: handleSquareClick,
          onPieceDrop: handlePieceDrop,
          darkSquareStyle: { backgroundColor: "#6A5D4F" },
          lightSquareStyle: { backgroundColor: "#EFE6D2" },
        }}
      />

      {pending && (
        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-black/50 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-4 shadow-2xl">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Promote to
            </span>
            <div className="flex gap-2">
              {PROMOTION_PIECES.map((p) => {
                /* The promoting side is decided by the rank being reached —
                   rank 8 is White's, rank 1 is Black's — never by which way
                   the board happens to be facing. Drawn with the board's own
                   inline-SVG piece set, because Unicode chess glyphs render as
                   empty boxes on systems without a font that carries them. */
                const white = pending.to[1] === "8";
                const Piece = defaultPieces[`${white ? "w" : "b"}${p.toUpperCase()}`];
                return (
                  <button
                    key={p}
                    onClick={() => attemptMove(pending.from, pending.to, p)}
                    className={cn(
                      "flex h-12 w-12 items-center justify-center rounded-lg border border-border bg-secondary p-1 transition-colors hover:border-primary hover:bg-primary/20",
                    )}
                    aria-label={`Promote to ${PROMOTION_NAMES[p]}`}
                  >
                    {Piece ? <Piece /> : PROMOTION_NAMES[p]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
