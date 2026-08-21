"use client";

import { defaultPieces } from "react-chessboard";
import type { PieceRenderObject } from "react-chessboard";
import type { PieceSetId } from "@/lib/board-prefs";

/**
 * The piece sets the board can draw.
 *
 *  - `classic`  react-chessboard's own inline-SVG artwork, the set ChainMate
 *               has always used and still the default.
 *  - `letters`  Each piece as its initial on a disc. Not a novelty: piece
 *               artwork loses its silhouette at small sizes and on busy board
 *               colours, and initials stay legible at any size. Drawn from the
 *               --piece-* variables so both sets sit on the same two tones.
 *
 * react-chessboard renders a piece by looking up `pieces[key]` where key is
 * "wP".."bK" and mounting it as a component inside a square-filling wrapper, so
 * a set is just a record of components returning one <svg> at width/height
 * 100%. Dragging is handled by that wrapper, not by the piece.
 */

const LETTER_KEYS = ["P", "N", "B", "R", "Q", "K"] as const;

const LIGHT_FILL = "hsl(var(--piece-light))";
const DARK_FILL = "hsl(var(--piece-dark))";
const OUTLINE = "hsl(var(--piece-outline))";

function letterPiece(color: "w" | "b", letter: string) {
  const white = color === "w";
  /* fill/stroke go through `style`, not through the SVG presentation
     attributes: a presentation attribute is not a CSS declaration, so
     `fill="hsl(var(--piece-light))"` silently resolves to nothing and the piece
     renders black. react-chessboard's own set styles its paths the same way. */
  const discStyle: React.CSSProperties = {
    fill: white ? LIGHT_FILL : DARK_FILL,
    stroke: OUTLINE,
    strokeWidth: 1.6,
    strokeOpacity: white ? 0.85 : 0.55,
  };
  const textStyle: React.CSSProperties = {
    fill: white ? DARK_FILL : LIGHT_FILL,
    fontFamily: "var(--font-jetbrains-mono), ui-monospace, monospace",
    fontSize: "18px",
    fontWeight: 700,
    letterSpacing: "0.5px",
  };
  function LetterPiece(props?: { svgStyle?: React.CSSProperties }) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 45 45"
        width="100%"
        height="100%"
        style={props?.svgStyle}
        role="img"
      >
        <circle cx="22.5" cy="22.5" r="15.5" style={discStyle} />
        <text
          x="22.5"
          y="22.9"
          textAnchor="middle"
          dominantBaseline="central"
          style={textStyle}
        >
          {letter}
        </text>
      </svg>
    );
  }
  LetterPiece.displayName = `LetterPiece_${color}${letter}`;
  return LetterPiece;
}

const lettersPieces: PieceRenderObject = Object.fromEntries(
  (["w", "b"] as const).flatMap((color) =>
    LETTER_KEYS.map((letter) => [`${color}${letter}`, letterPiece(color, letter)]),
  ),
);

export const PIECE_RENDERERS: Record<PieceSetId, PieceRenderObject> = {
  classic: defaultPieces,
  letters: lettersPieces,
};

/**
 * One piece, drawn on its own — for the capture trays and the piece-set picker,
 * which need the same artwork the board is currently using. `color` is chess
 * colour, `type` a lowercase chess.js piece letter ("p", "n", …).
 */
export function pieceRenderer(set: PieceSetId, color: "w" | "b", type: string) {
  return PIECE_RENDERERS[set][`${color}${type.toUpperCase()}`];
}
