const FEN = "r1bq1rk1/1pp2ppp/p1np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 8";

const GLYPHS: Record<string, string> = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
  K: "♔",
  Q: "♕",
  R: "♖",
  B: "♗",
  N: "♘",
  P: "♙",
};

const FILES = "abcdefgh";

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
    <div className="relative mx-auto w-full max-w-md rounded-xl border border-primary/20 bg-card p-3 shadow-2xl shadow-black/50">
      <div className="flex">
        {/* Rank coordinates */}
        <div className="flex w-4 flex-col justify-around pr-1 text-[9px] font-medium leading-none text-muted-foreground/70">
          {[8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
            <span key={n} className="flex h-8 items-center justify-center">
              {n}
            </span>
          ))}
        </div>
        <div className="grid aspect-square flex-1 grid-cols-8 overflow-hidden rounded-md">
          {grid.flatMap((row, r) =>
            row.map((piece, c) => {
              const dark = (r + c) % 2 === 1;
              const isWhite = piece !== null && piece === piece.toUpperCase();
              const highlighted = piece === "d" || (piece === "P" && c === 3 && r === 4);
              return (
                <div
                  key={`${r}-${c}`}
                  className={`relative flex h-8 w-8 items-center justify-center text-[clamp(13px,3.6vw,26px)] leading-none select-none sm:h-auto sm:w-auto ${
                    dark ? "bg-board-dark" : "bg-board-light"
                  } ${highlighted ? "bg-board-lastmove" : ""}`}
                >
                  {piece ? (
                    <span
                      className={isWhite ? "text-[#F6F2E8]" : "text-[#23262B]"}
                      style={{
                        textShadow: isWhite
                          ? "0 1px 2px rgba(0,0,0,0.65)"
                          : "0 1px 1px rgba(255,255,255,0.35)",
                      }}
                    >
                      {GLYPHS[piece]}
                    </span>
                  ) : null}
                  {/* File coordinates along the bottom edge */}
                  {r === 7 && (
                    <span
                      className={`absolute bottom-0 left-0.5 text-[8px] font-semibold leading-none ${
                        dark ? "text-[#EFE6D2]/80" : "text-[#6A5D4F]/80"
                      }`}
                    >
                      {FILES[c]}
                    </span>
                  )}
                </div>
              );
            }),
          )}
        </div>
      </div>
    </div>
  );
}
