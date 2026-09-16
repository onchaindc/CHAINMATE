"use client";

import { defaultPieces } from "react-chessboard";

/**
 * The landing-page board. A real position (Giuoco Piano, move 8) rendered
 * with the SAME piece artwork as the live game board.
 *
 * It used to draw pieces with Unicode chess characters (♜♞♝♛♚♟). Those depend
 * entirely on system font fallback: Windows has no chess glyphs in its default
 * UI fonts, so the front page showed empty squares or tofu boxes instead of
 * pieces. defaultPieces is react-chessboard's inline-SVG piece set — the very
 * set the game board renders — so the marketing board now matches the product
 * exactly and cannot depend on the visitor's installed fonts.
 */

const FEN = "r1bq1rk1/1pp2ppp/p1np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 8";

/** FEN letter → react-chessboard piece key ("r" → "bR", "R" → "wR"). */
function pieceKey(fenChar: string): string {
  const color = fenChar === fenChar.toUpperCase() ? "w" : "b";
  return `${color}${fenChar.toUpperCase()}`;
}

function fenGrid(): (string | null)[][] {
  const rows: (string | null)[][] = [];
  const pieces = FEN.split(" ")[0].split("/");
  for (const row of pieces) {
    const cells: (string | null)[] = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) cells.push(null);
      } else {
        cells.push(ch);
      }
    }
    rows.push(cells);
  }
  return rows;
}

export function BoardVisual() {
  const grid = fenGrid();

  return (
    /* Sized to the space actually available on screen — capped by the column
       width AND by the viewport height (it's square), so it fills tall screens
       instead of floating small, without ever overflowing short ones. */
    <div className="relative mx-auto aspect-square w-full max-w-[min(44rem,calc(100dvh-13rem))]">
      <div
        className="grid h-full w-full grid-cols-8 overflow-hidden rounded-lg shadow-elevation-3 ring-1 ring-border/60"
        role="img"
        aria-label="A chess position from a Giuoco Piano opening"
      >
        {grid.flatMap((row, r) =>
          row.map((piece, c) => {
            const dark = (r + c) % 2 === 1;
            // Fixed brand-gold squares, deliberately NOT the --board-* CSS
            // variables those live-game themes recolour: a player's in-game
            // board choice (walnut, slate, forest…) must not repaint the
            // marketing board. Same hues as the gold theme in globals.css.
            const Piece = piece ? defaultPieces[pieceKey(piece)] : undefined;
            return (
              <div
                key={`${r}-${c}`}
                className="flex select-none items-center justify-center"
                style={{
                  backgroundColor: dark
                    ? "hsl(31 15% 36%)"
                    : "hsl(41 48% 88%)",
                }}
              >
                {Piece ? <Piece /> : null}
              </div>
            );
          }),
        )}
      </div>
      <p className="mt-3 flex items-center justify-center gap-2 text-2xs font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
        <img src="/logo-mark.svg" alt="" className="h-4 w-4" />
        Fair play on every move
      </p>
    </div>
  );
}
