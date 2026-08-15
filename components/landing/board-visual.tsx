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
    <div className="relative mx-auto w-full max-w-md">
      <div className="grid aspect-square grid-cols-8 overflow-hidden rounded-lg shadow-2xl shadow-black/60 ring-1 ring-border/60">
        {grid.flatMap((row, r) =>
          row.map((piece, c) => {
            const dark = (r + c) % 2 === 1;
            const isWhite = piece !== null && piece === piece.toUpperCase();
            return (
              <div
                key={`${r}-${c}`}
                className={`flex items-center justify-center text-[clamp(14px,4.2vw,30px)] leading-none select-none ${
                  dark ? "bg-board-dark" : "bg-board-light"
                }`}
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
              </div>
            );
          }),
        )}
      </div>
      <p className="mt-3 flex items-center justify-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground/80">
        <img src="/logo-mark.svg" alt="" className="h-4 w-4" />
        Every move validated on GenLayer
      </p>
    </div>
  );
}
